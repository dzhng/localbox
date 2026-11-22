import Darwin
import Foundation

/// A refusal on the app socket, answered as the CLI's failure envelope; `code` is one of the CLI's error codes.
public struct AppSocketFailure: Error, Equatable, Sendable {
    public let code: String
    public let message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
}

/// Why the socket could not be served.
public enum AppSocketError: Error, Equatable, CustomStringConvertible {
    /// Another app answers there: a live socket is never taken over.
    case inUse(String)
    /// Something that is not a socket sits at the path; this listener never made it, so it is not deleted.
    case occupied(String)
    case unavailable(String)
    public var description: String {
        switch self {
        case .inUse(let path): return "another Localbox app already answers at \(path)"
        case .occupied(let path): return "\(path) exists and is not a socket"
        case .unavailable(let message): return message
        }
    }
}

/// The app's own listener, `<root>/app.sock` (specs/menu-bar-app, slice 09), for what only the app can do: report
/// its children and change its login item, and later its updates. It answers whatever the daemon is doing, since it
/// is how the CLI learns the daemon is down. Ported from Bento's `AppSocket`: mode 0600, one JSON request line in
/// (`{"id","operation","params"}`), one response line out in the CLI's envelope (`{"id","ok":true,"result"}` or
/// `{"id","ok":false,"error":{code,message,retryable}}`), then the connection closes.
public final class AppSocket: @unchecked Sendable {
    /// Answers one operation, off the main thread.
    public typealias Handler = @Sendable (_ operation: String, _ params: [String: Any]) -> Result<[String: Any], AppSocketFailure>

    /// Requests carry no more than a flag; the bound only stops a runaway caller.
    static let maxRequestBytes = 64 * 1024
    private let path: String
    private let handle: Handler
    private let queue = DispatchQueue(label: "sh.localbox.mac.app-socket", attributes: .concurrent)
    private var source: DispatchSourceRead?
    private var bound: ino_t = 0

    public init(path: String, handle: @escaping Handler) { self.path = path; self.handle = handle }

    public func start() throws {
        try reclaimLeftover()
        guard var address = Self.address(path) else { throw AppSocketError.unavailable("the app socket path is too long: \(path)") }
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw unavailable("cannot open the app socket") }
        // Accepted sockets inherit this, so a caller that hangs up before its answer is written never raises SIGPIPE.
        var noSignal: Int32 = 1
        setsockopt(listener, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard result == 0, chmod(path, 0o600) == 0, listen(listener, 16) == 0 else {
            let error = unavailable("cannot listen on \(path)")
            close(listener)
            throw error
        }
        var info = stat()
        if lstat(path, &info) == 0 { bound = info.st_ino }
        _ = fcntl(listener, F_SETFL, fcntl(listener, F_GETFL) | O_NONBLOCK)
        let source = DispatchSource.makeReadSource(fileDescriptor: listener, queue: queue)
        source.setEventHandler { [weak self] in
            while case let client = accept(listener, nil, nil), client >= 0 { self?.serve(client) }
        }
        source.setCancelHandler { close(listener) }
        self.source = source
        source.resume()
    }

    /// Removes the socket only if it is still the one this listener bound (a successor may have replaced it).
    public func stop() {
        source?.cancel(); source = nil
        var info = stat()
        if bound != 0, lstat(path, &info) == 0, info.st_ino == bound { unlink(path) }
    }

    /// A file left by an app that died is removed; a socket something still answers on is refused.
    private func reclaimLeftover() throws {
        var info = stat()
        guard lstat(path, &info) == 0 else { return }
        guard (info.st_mode & S_IFMT) == S_IFSOCK else { throw AppSocketError.occupied(path) }
        guard var address = Self.address(path) else { throw AppSocketError.unavailable("the app socket path is too long: \(path)") }
        let probe = socket(AF_UNIX, SOCK_STREAM, 0)
        defer { close(probe) }
        let connected = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        if connected == 0 { throw AppSocketError.inUse(path) }
        unlink(path)
    }

    private func serve(_ client: Int32) {
        // An accepted socket inherits the listener's non-blocking mode; reads here block, bounded by these deadlines,
        // which accepted sockets do not inherit.
        _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK)
        var deadline = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &deadline, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &deadline, socklen_t(MemoryLayout<timeval>.size))
        queue.async { [self] in
            // Nothing arrived (a probe that hung up, a stalled caller): nothing to answer.
            guard let line = readLine(client) else { close(client); return }
            guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let id = request["id"] as? String, !id.isEmpty, let operation = request["operation"] as? String else {
                respond(client, id: nil, .failure(AppSocketFailure(code: "invalid_input", message: "expected one JSON line with id, operation and params")))
                return
            }
            let params = request["params"] as? [String: Any] ?? [:]
            respond(client, id: id, handle(operation, params))
        }
    }

    private func readLine(_ client: Int32) -> Data? {
        var buffered = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        // Each read is bounded by SO_RCVTIMEO; this bounds a caller that trickles bytes.
        let deadline = Date().addingTimeInterval(5)
        while buffered.count <= Self.maxRequestBytes, Date() < deadline {
            let count = read(client, &chunk, chunk.count)
            guard count > 0 else { return nil }
            if let end = chunk[0..<count].firstIndex(of: 0x0A) {
                buffered.append(contentsOf: chunk[0..<end])
                return buffered.count <= Self.maxRequestBytes ? buffered : nil
            }
            buffered.append(contentsOf: chunk[0..<count])
        }
        return nil
    }

    private func respond(_ client: Int32, id: String?, _ result: Result<[String: Any], AppSocketFailure>) {
        var envelope: [String: Any] = ["id": id ?? NSNull()]
        switch result {
        case .success(let value): envelope["ok"] = true; envelope["result"] = value
        case .failure(let failure): envelope["ok"] = false; envelope["error"] = ["code": failure.code, "message": failure.message, "retryable": false]
        }
        var line = (try? JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys]))
            ?? Data(#"{"id":null,"ok":false,"error":{"code":"internal","message":"the answer could not be encoded","retryable":false}}"#.utf8)
        line.append(0x0A)
        line.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = write(client, raw.baseAddress! + offset, raw.count - offset)
                if written <= 0 { break }
                offset += written
            }
        }
        close(client)
    }

    private static func address(_ path: String) -> sockaddr_un? {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in raw.copyBytes(from: bytes); raw[bytes.count] = 0 }
        return address
    }

    private func unavailable(_ message: String) -> AppSocketError { .unavailable("\(message): \(String(cString: strerror(errno)))") }
}
