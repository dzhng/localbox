import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Local CLI/daemon IPC request. A launchd Unix socket or an in-process test
/// transport can carry this same shape without owning lifecycle state.
public struct LocalIPCRequest: Codable, Sendable {
    public let token: String
    public let envelope: Data
    public init(token: String, envelope: Data) { self.token = token; self.envelope = envelope }
}

/// The response written by `UnixDomainSocketServer` for one request.
///
/// The socket protocol is a big-endian uint32 length followed by JSON. A
/// successful response has `envelope`; failures have a stable, non-sensitive
/// `error` value. The connection handles one request and then closes.
public struct LocalIPCResponse: Codable, Sendable, Equatable {
    public let envelope: Data?
    public let error: String?

    public init(envelope: Data? = nil, error: String? = nil) {
        self.envelope = envelope
        self.error = error
    }

    public static func success(_ envelope: Data) -> LocalIPCResponse {
        LocalIPCResponse(envelope: envelope)
    }

    public static func failure(_ error: String) -> LocalIPCResponse {
        LocalIPCResponse(error: error)
    }
}

public enum LocalIPCError: Error, CustomStringConvertible, Sendable {
    case unauthorized
    case malformed
    public var description: String { switch self { case .unauthorized: return "local IPC authentication failed"; case .malformed: return "malformed local IPC request" } }
}

public struct LocalIPCEndpoint: Sendable, Equatable {
    public let socketPath: String
    public init(socketPath: String = "~/Library/Application Support/AgentComputer/agent.sock") { self.socketPath = socketPath }
}

/// Authenticates before forwarding to the single HostDaemon lifecycle owner.
public actor AuthenticatedLocalIPC {
    private let daemon: HostDaemon
    private let token: String
    public let endpoint: LocalIPCEndpoint
    public init(daemon: HostDaemon, token: String, endpoint: LocalIPCEndpoint = LocalIPCEndpoint()) { self.daemon = daemon; self.token = token; self.endpoint = endpoint }
    public func handle(_ request: LocalIPCRequest) async throws -> Data {
        guard !request.token.isEmpty, constantTimeEqual(request.token, token) else { throw LocalIPCError.unauthorized }
        guard !request.envelope.isEmpty else { throw LocalIPCError.malformed }
        return try await daemon.request(request.envelope)
    }
}

/// A launchd-compatible Unix-domain socket adapter for `AuthenticatedLocalIPC`.
///
/// The adapter owns only the listener and connection tasks. `HostDaemon` remains
/// the sole owner of VM lifecycle, and all request authentication/forwarding
/// goes through `AuthenticatedLocalIPC`. launchd may provide the listener fd in
/// a future product wrapper; this standalone listener is useful for development
/// and tests and has the same one-request-per-connection wire contract.
public actor UnixDomainSocketServer {
    public let endpoint: LocalIPCEndpoint
    private let ipc: AuthenticatedLocalIPC
    private let maxFrameBytes: UInt32
    private var listenerFD: Int32 = -1
    private var source: DispatchSourceRead?
    private var running = false
    private var resolvedPath: String?

    public init(ipc: AuthenticatedLocalIPC, endpoint: LocalIPCEndpoint? = nil, maxFrameBytes: UInt32 = 8 * 1024 * 1024) {
        self.ipc = ipc
        self.endpoint = endpoint ?? LocalIPCEndpoint()
        self.maxFrameBytes = maxFrameBytes
    }

    deinit {
        // `stop()` is async because this type is an actor, so deinit cannot
        // call it. The dispatch source cancellation handler closes the fd.
        source?.cancel()
        if let path = resolvedPath { unlink(path) }
    }

    public func start() throws {
        guard !running else { return }
        guard maxFrameBytes > 0 else { throw LocalIPCSocketError.invalidConfiguration("maxFrameBytes must be greater than zero") }
        let path = try Self.resolveSocketPath(endpoint.socketPath)
        let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
        try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)

        // Remove only a stale socket. Refuse to unlink an unrelated file.
        if FileManager.default.fileExists(atPath: path) {
            var info = stat()
            guard stat(path, &info) == 0 else { throw LocalIPCSocketError.systemCall("stat", errno) }
            #if canImport(Darwin) || canImport(Glibc)
            guard (info.st_mode & S_IFMT) == S_IFSOCK else { throw LocalIPCSocketError.pathOccupied }
            #endif
            guard unlink(path) == 0 else { throw LocalIPCSocketError.systemCall("unlink", errno) }
        }

        let fd = socket(AF_UNIX, Self.streamSocketType, 0)
        guard fd >= 0 else { throw LocalIPCSocketError.systemCall("socket", errno) }
        do {
            try Self.bind(fd: fd, path: path)
            guard listen(fd, 64) == 0 else { throw LocalIPCSocketError.systemCall("listen", errno) }
            guard chmod(path, mode_t(0o600)) == 0 else { throw LocalIPCSocketError.systemCall("chmod", errno) }
            try Self.setNonBlocking(fd)
        } catch {
            close(fd); unlink(path); throw error
        }

        listenerFD = fd
        resolvedPath = path
        running = true
        let readSource = DispatchSource.makeReadSource(fileDescriptor: fd, queue: DispatchQueue(label: "com.agentcomputer.host-daemon.ipc", qos: .userInitiated))
        readSource.setEventHandler { [weak self] in
            guard let self else { return }
            Task { await self.acceptReadyConnections() }
        }
        readSource.setCancelHandler { close(fd) }
        source = readSource
        readSource.resume()
    }

    public func stop() {
        guard running else { return }
        running = false
        source?.cancel()
        source = nil
        listenerFD = -1
        if let path = resolvedPath { unlink(path) }
        resolvedPath = nil
    }

    public func isRunning() -> Bool { running }

    private func acceptReadyConnections() {
        guard running, listenerFD >= 0 else { return }
        while running {
            let connection = accept(listenerFD, nil, nil)
            if connection >= 0 {
                // `accept` inherits the listener's non-blocking flag on macOS.
                // Restore blocking mode before FileHandle reads the request.
                try? Self.setBlocking(connection)
                let ipc = self.ipc
                let maxFrameBytes = self.maxFrameBytes
                Task.detached(priority: .userInitiated) {
                    await Self.handleConnection(connection, ipc: ipc, maxFrameBytes: maxFrameBytes)
                }
                continue
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK { break }
            break
        }
    }

    private static func handleConnection(_ fd: Int32, ipc: AuthenticatedLocalIPC, maxFrameBytes: UInt32) async {
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
            let body = try readFrame(from: handle, maxFrameBytes: maxFrameBytes)
            let request: LocalIPCRequest
            do {
                request = try JSONDecoder().decode(LocalIPCRequest.self, from: body)
            } catch {
                throw LocalIPCSocketError.malformed
            }
            do {
                let envelope = try await ipc.handle(request)
                try writeFrame(try JSONEncoder().encode(LocalIPCResponse.success(envelope)), to: handle)
            } catch let error as LocalIPCError {
                let code: String
                switch error {
                case .unauthorized: code = "unauthorized"
                case .malformed: code = "malformed"
                }
                try writeFrame(try JSONEncoder().encode(LocalIPCResponse.failure(code)), to: handle)
            } catch {
                try writeFrame(try JSONEncoder().encode(LocalIPCResponse.failure("unavailable")), to: handle)
            }
        } catch let error as LocalIPCSocketError {
            let value: String
            switch error {
            case .frameTooLarge: value = "frame_too_large"
            case .malformed: value = "malformed"
            default: value = "unavailable"
            }
            try? writeFrame(try JSONEncoder().encode(LocalIPCResponse.failure(value)), to: handle)
        } catch {
            try? writeFrame(try JSONEncoder().encode(LocalIPCResponse.failure("unavailable")), to: handle)
        }
        try? handle.close()
    }

    private static func readFrame(from handle: FileHandle, maxFrameBytes: UInt32) throws -> Data {
        let header = try readExactly(4, from: handle)
        let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard length > 0 else { throw LocalIPCSocketError.malformed }
        guard length <= maxFrameBytes else { throw LocalIPCSocketError.frameTooLarge }
        return try readExactly(Int(length), from: handle)
    }

    private static func readExactly(_ count: Int, from handle: FileHandle) throws -> Data {
        var result = Data(); result.reserveCapacity(count)
        while result.count < count {
            guard let chunk = try handle.read(upToCount: count - result.count), !chunk.isEmpty else { throw LocalIPCSocketError.malformed }
            result.append(chunk)
        }
        return result
    }

    private static func writeFrame(_ body: Data, to handle: FileHandle) throws {
        guard body.count <= Int(UInt32.max) else { throw LocalIPCSocketError.frameTooLarge }
        var length = UInt32(body.count).bigEndian
        try handle.write(contentsOf: Data(bytes: &length, count: 4))
        try handle.write(contentsOf: body)
    }

    private static func resolveSocketPath(_ path: String) throws -> String {
        let expanded: String
        if path == "~" { expanded = FileManager.default.homeDirectoryForCurrentUser.path }
        else if path.hasPrefix("~/") { expanded = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(String(path.dropFirst(2))).path }
        else { expanded = path }
        guard !expanded.isEmpty, expanded.utf8.count < Self.maxSocketPathBytes else { throw LocalIPCSocketError.invalidConfiguration("socket path is too long") }
        return expanded
    }

    private static func bind(fd: Int32, path: String) throws {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard bytes.count + 1 <= capacity else { throw LocalIPCSocketError.invalidConfiguration("socket path is too long") }
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.copyBytes(from: [UInt8](repeating: 0, count: destination.count))
            destination.copyBytes(from: bytes)
        }
        let length = socklen_t(MemoryLayout<sa_family_t>.size + bytes.count + 1)
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                #if canImport(Darwin)
                Darwin.bind(fd, $0, length)
                #else
                Glibc.bind(fd, $0, length)
                #endif
            }
        }
        guard result == 0 else { throw LocalIPCSocketError.systemCall("bind", errno) }
    }

    private static func setBlocking(_ fd: Int32) throws {
        #if canImport(Darwin)
        let current = fcntl(fd, F_GETFL)
        guard current >= 0, fcntl(fd, F_SETFL, current & ~O_NONBLOCK) == 0 else { throw LocalIPCSocketError.systemCall("fcntl", errno) }
        #else
        let current = fcntl(fd, F_GETFL, 0)
        guard current >= 0, fcntl(fd, F_SETFL, current & ~O_NONBLOCK) == 0 else { throw LocalIPCSocketError.systemCall("fcntl", errno) }
        #endif
    }

    private static func setNonBlocking(_ fd: Int32) throws {
        #if canImport(Darwin)
        let current = fcntl(fd, F_GETFL)
        guard current >= 0, fcntl(fd, F_SETFL, current | O_NONBLOCK) == 0 else { throw LocalIPCSocketError.systemCall("fcntl", errno) }
        #else
        let current = fcntl(fd, F_GETFL, 0)
        guard current >= 0, fcntl(fd, F_SETFL, current | O_NONBLOCK) == 0 else { throw LocalIPCSocketError.systemCall("fcntl", errno) }
        #endif
    }

    #if canImport(Darwin)
    private static let streamSocketType: Int32 = SOCK_STREAM
    #else
    private static let streamSocketType: Int32 = Int32(SOCK_STREAM.rawValue)
    #endif
    private static let maxSocketPathBytes = MemoryLayout.size(ofValue: sockaddr_un().sun_path)
}

public enum LocalIPCSocketError: Error, CustomStringConvertible, Sendable {
    case invalidConfiguration(String)
    case pathOccupied
    case frameTooLarge
    case malformed
    case systemCall(String, Int32)

    public var description: String {
        switch self {
        case .invalidConfiguration(let value): return value
        case .pathOccupied: return "local IPC socket path is occupied by a non-socket"
        case .frameTooLarge: return "local IPC frame exceeds the configured limit"
        case .malformed: return "malformed local IPC frame"
        case .systemCall(let operation, let code): return "local IPC \(operation) failed (errno \(code))"
        }
    }
}

private func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
    let a = Array(lhs.utf8); let b = Array(rhs.utf8); guard a.count == b.count else { return false }
    var difference: UInt8 = 0; for index in a.indices { difference |= a[index] ^ b[index] }; return difference == 0
}
