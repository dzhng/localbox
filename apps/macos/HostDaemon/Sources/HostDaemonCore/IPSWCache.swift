import Foundation

/// One macOS restore image Apple serves: where it is, what it installs and how big it is. Captured once when a build
/// begins and kept in its checkpoint, so a resumed build downloads and installs the same release.
public struct IPSWRelease: Codable, Equatable, Sendable {
    public let url: URL
    /// Dotted, as `sw_vers` prints it ("27.2.1").
    public let version: String
    public let build: String
    public let sizeBytes: UInt64
    public init(url: URL, version: String, build: String, sizeBytes: UInt64) { self.url = url; self.version = version; self.build = build; self.sizeBytes = sizeBytes }
    enum CodingKeys: String, CodingKey { case url, version, build, sizeBytes = "size_bytes" }

    /// The cache's file name: Apple's own (`UniversalMac_27.2.1_26B131_Restore.ipsw`).
    public var fileName: String { url.lastPathComponent }
}

/// The newest restore image this Mac can run, from Apple.
public protocol IPSWCatalog: Sendable {
    func latest() async throws -> IPSWRelease
}

/// Byte-range HTTP, the one thing a resumable download needs.
public protocol RangedHTTP: Sendable {
    /// The resource's length (`Content-Length` of a `HEAD`).
    func length(of url: URL) async throws -> UInt64
    /// Appends the resource's bytes from `offset` on to `file`, calling `progress` with the bytes appended so far.
    func fetch(_ url: URL, from offset: UInt64, appendingTo file: FileHandle, progress: @escaping @Sendable (UInt64) -> Void) async throws
}

/// The IPSW cache under `images/.ipsw/`: each release as Apple names it, written as `<name>.partial` until every byte
/// is there, then renamed. A download that stops (a crash, a dropped connection) resumes from the partial file's
/// length, so a 25 GB IPSW is fetched once. Nothing evicts it yet (delegated).
public struct IPSWCache: Sendable {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }

    public func file(for release: IPSWRelease) -> URL { directory.appendingPathComponent(release.fileName) }
    private func partial(for release: IPSWRelease) -> URL { directory.appendingPathComponent(release.fileName + ".partial") }

    /// Records what `release` is beside its file (`<name>.json`), so a build can use it when Apple can't be asked.
    public func remember(_ release: IPSWRelease) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(release).write(to: directory.appendingPathComponent(release.fileName + ".json"), options: .atomic)
    }

    /// The newest remembered release that is cached whole, by version.
    public func newestCached() -> IPSWRelease? {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        let releases = names.filter { $0.hasSuffix(".ipsw.json") }.compactMap { try? JSONDecoder().decode(IPSWRelease.self, from: Data(contentsOf: directory.appendingPathComponent($0))) }.filter(has)
        return releases.max { $0.version.split(separator: ".").compactMap { Int($0) }.lexicographicallyPrecedes($1.version.split(separator: ".").compactMap { Int($0) }) }
    }

    /// Whether `release` is cached whole.
    public func has(_ release: IPSWRelease) -> Bool { fileLength(file(for: release)) == release.sizeBytes }

    /// Bytes `release` still needs on disk before it is cached.
    public func missingBytes(_ release: IPSWRelease) -> UInt64 {
        has(release) ? 0 : release.sizeBytes - min(release.sizeBytes, fileLength(partial(for: release)) ?? 0)
    }

    /// The cached file, downloading what is missing first. `progress` gets the bytes held so far, out of the size.
    public func fetch(_ release: IPSWRelease, over http: any RangedHTTP, progress: @escaping @Sendable (UInt64) -> Void = { _ in }) async throws -> URL {
        let complete = file(for: release)
        if has(release) { return complete }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let partial = partial(for: release)
        if !FileManager.default.fileExists(atPath: partial.path) { FileManager.default.createFile(atPath: partial.path, contents: nil) }
        var held = fileLength(partial) ?? 0
        // A partial longer than the release (a different file under the same name) is started over.
        if held > release.sizeBytes { try FileHandle(forWritingTo: partial).truncate(atOffset: 0); held = 0 }
        if held < release.sizeBytes {
            let handle = try FileHandle(forWritingTo: partial)
            defer { try? handle.close() }
            try handle.seekToEnd()
            let start = held
            try await http.fetch(release.url, from: start, appendingTo: handle, progress: { progress(start + $0) })
            try handle.synchronize()
        }
        let length = fileLength(partial) ?? 0
        guard length == release.sizeBytes else {
            throw HostDaemonError.unsupported("the IPSW download stopped at \(length) of \(release.sizeBytes) bytes; it resumes from there")
        }
        try? FileManager.default.removeItem(at: complete)
        try FileManager.default.moveItem(at: partial, to: complete)
        return complete
    }

    private func fileLength(_ url: URL) -> UInt64? { (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.uint64Value }
}

/// `RangedHTTP` over URLSession: a `Range: bytes=<offset>-` request whose body is appended to the file as it arrives.
public struct URLSessionRangedHTTP: RangedHTTP {
    public init() {}

    public func length(of url: URL) async throws -> UInt64 {
        var request = URLRequest(url: url); request.httpMethod = "HEAD"
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.expectedContentLength > 0 else {
            throw HostDaemonError.unsupported("\(url.absoluteString) answered no length")
        }
        return UInt64(http.expectedContentLength)
    }

    public func fetch(_ url: URL, from offset: UInt64, appendingTo file: FileHandle, progress: @escaping @Sendable (UInt64) -> Void) async throws {
        var request = URLRequest(url: url)
        if offset > 0 { request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range") }
        let writer = AppendingDownload(file: file, ranged: offset > 0, progress: progress)
        let session = URLSession(configuration: .ephemeral, delegate: writer, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                writer.finished = { continuation.resume(with: $0) }
                session.dataTask(with: request).resume()
            }
        } onCancel: { session.invalidateAndCancel() }
    }
}

/// Writes a data task's body to a file as it arrives, refusing an answer that would not continue the file.
private final class AppendingDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let file: FileHandle, ranged: Bool, progress: @Sendable (UInt64) -> Void
    var finished: ((Result<Void, Error>) -> Void)?
    private var written: UInt64 = 0, failure: Error?
    init(file: FileHandle, ranged: Bool, progress: @escaping @Sendable (UInt64) -> Void) { self.file = file; self.ranged = ranged; self.progress = progress }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // A ranged request must get 206; a 200 would restart the file from byte 0 behind what is already there.
        guard status == (ranged ? 206 : 200) else {
            failure = HostDaemonError.unsupported("the IPSW server answered HTTP \(status)\(ranged ? " to a resumed download" : "")")
            return completionHandler(.cancel)
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil else { return }
        do { try file.write(contentsOf: data); written += UInt64(data.count); progress(written) }
        catch { failure = error; dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let outcome: Result<Void, Error> = (failure ?? error).map { .failure($0) } ?? .success(())
        finished?(outcome); finished = nil
    }
}
