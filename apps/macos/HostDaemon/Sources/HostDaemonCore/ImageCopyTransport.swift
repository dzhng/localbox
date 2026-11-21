import Foundation

// The seam between the daemon's `image.copy` operation and the bytes. The daemon owns the journal, the image store and
// the rendezvous; a transport owns everything on the wire (paths, AEAD with the copy's key, resume). Slice 37's
// `ImageTransfer` library conforms through a small adapter wired in `localbox-hostd/main.swift`; until then dev daemons
// use `LoopbackImageCopyTransport` and release daemons answer `image.copy` unsupported.

/// An address one end of a copy can be reached at; `kind` is the transport's own (`local`, `reflexive`, ...).
public struct ImageCopyCandidate: Codable, Equatable, Hashable, Sendable {
    public let kind: String
    public let address: String
    public let port: Int
    public init(kind: String, address: String, port: Int) { self.kind = kind; self.address = address; self.port = port }
}

/// The path a finished copy took: an address on the local network, or a punched connection across the internet.
public enum ImageCopyPath: String, Codable, Sendable {
    case localNetwork = "local_network", internet
}

/// What one end of a finished copy moved: bytes over the wire (this run's, after any resume), how long, which path.
public struct ImageCopyReport: Equatable, Sendable {
    public let bytes: UInt64
    public let durationMs: Int
    public let path: ImageCopyPath
    public init(bytes: UInt64, durationMs: Int, path: ImageCopyPath) { self.bytes = bytes; self.durationMs = durationMs; self.path = path }
}

/// One path a transport tried and why it failed, e.g. `local network 10.0.0.4:50123: timed out`.
public struct ImageCopyAttempt: Equatable, Sendable {
    public let path: ImageCopyPath
    public let candidate: String
    public let reason: String
    public init(path: ImageCopyPath, candidate: String, reason: String) { self.path = path; self.candidate = candidate; self.reason = reason }
    var text: String { "\(path == .localNetwork ? "local network" : "internet") \(candidate) (\(reason))" }
}

/// No path between the two ends worked: every one tried, in order (`PathSelector`'s report).
public struct ImageCopyUnreachable: Error, Equatable, Sendable {
    public let tried: [ImageCopyAttempt]
    public init(tried: [ImageCopyAttempt]) { self.tried = tried }
}

/// The candidate exchange of one copy, through the account (the copy's Convex row, by way of the connector).
public protocol ImageCopyRendezvous: Sendable {
    /// Publishes where this end can be reached, replacing what it published before.
    func publish(_ candidates: [ImageCopyCandidate]) async throws
    /// The peer's candidates once it has published some; with `previous`, waits for a set different from it (the peer
    /// restarted and gathered new ones). Throws when the copy failed elsewhere or the peer stays silent too long.
    func peerCandidates(after previous: [ImageCopyCandidate]?) async throws -> [ImageCopyCandidate]
}

/// Bytes done of bytes total; throws once the operation must stop (the daemon is exiting), which ends the transfer.
public typealias ImageCopyProgress = @Sendable (_ done: UInt64, _ total: UInt64) async throws -> Void

/// An image's files as `ImageStore` lays them out: the directory and the paths in it that make up the image.
public struct ImageCopySource: Equatable, Sendable {
    public let directory: URL
    public let files: [String]
}

/// Moves one image between two Macs. `receive` writes into a temporary directory that survives a daemon restart, so a
/// transport that resumes finds what an earlier run wrote; the daemon verifies and commits it after.
public protocol ImageCopyTransport: Sendable {
    func send(_ image: ImageCopySource, key: Data, rendezvous: any ImageCopyRendezvous, progress: @escaping ImageCopyProgress) async throws -> ImageCopyReport
    func receive(into temp: URL, key: Data, rendezvous: any ImageCopyRendezvous, progress: @escaping ImageCopyProgress) async throws -> ImageCopyReport
}

/// The dev and test transport: both ends on one Mac, so the receiver reads the sender's files straight from its image
/// store. It exercises everything around the bytes (the rendezvous both ways, progress, resume from what the temporary
/// already holds, the sender learning the receiver is done) and is never used by a release daemon. The sender publishes
/// its directory and files; the receiver copies them `chunkBytes` at a time, pausing `pauseMs` between chunks so a
/// proof can stop it midway, and publishes `loopback-done` when it has everything.
public struct LoopbackImageCopyTransport: ImageCopyTransport {
    static let root = "loopback-root", file = "loopback-file", ready = "loopback-ready", done = "loopback-done"
    public let chunkBytes: Int
    public let pauseMs: Int
    public init(chunkBytes: Int = 1 << 20, pauseMs: Int = 0) { self.chunkBytes = chunkBytes; self.pauseMs = pauseMs }

    public func send(_ image: ImageCopySource, key: Data, rendezvous: any ImageCopyRendezvous, progress: @escaping ImageCopyProgress) async throws -> ImageCopyReport {
        let started = Date()
        try await rendezvous.publish([ImageCopyCandidate(kind: Self.root, address: image.directory.path, port: 0)] + image.files.enumerated().map { ImageCopyCandidate(kind: Self.file, address: $1, port: $0) })
        var seen: [ImageCopyCandidate]? = nil
        while true {
            let peer = try await rendezvous.peerCandidates(after: seen)
            if peer.contains(where: { $0.kind == Self.done }) { break }
            seen = peer
        }
        let bytes = image.files.reduce(UInt64(0)) { $0 + fileSize(image.directory.appendingPathComponent($1)) }
        return ImageCopyReport(bytes: bytes, durationMs: Int(Date().timeIntervalSince(started) * 1000), path: .localNetwork)
    }

    public func receive(into temp: URL, key: Data, rendezvous: any ImageCopyRendezvous, progress: @escaping ImageCopyProgress) async throws -> ImageCopyReport {
        let started = Date()
        try await rendezvous.publish([ImageCopyCandidate(kind: Self.ready, address: "", port: 0)])
        let peer = try await rendezvous.peerCandidates(after: nil)
        guard let root = peer.first(where: { $0.kind == Self.root }) else {
            throw ImageCopyUnreachable(tried: [ImageCopyAttempt(path: .localNetwork, candidate: "loopback", reason: "the sender published no loopback directory")])
        }
        let source = URL(fileURLWithPath: root.address, isDirectory: true)
        let files = peer.filter { $0.kind == Self.file }.sorted { $0.port < $1.port }.map(\.address)
        let total = files.reduce(UInt64(0)) { $0 + fileSize(source.appendingPathComponent($1)) }
        var done: UInt64 = 0, moved: UInt64 = 0
        for relative in files {
            let from = source.appendingPathComponent(relative), to = temp.appendingPathComponent(relative)
            try FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
            let size = fileSize(from)
            // Resume: keep the whole chunks an earlier run wrote.
            var offset = min(fileSize(to), size) / UInt64(chunkBytes) * UInt64(chunkBytes)
            if !FileManager.default.fileExists(atPath: to.path) { FileManager.default.createFile(atPath: to.path, contents: nil) }
            let reader = try FileHandle(forReadingFrom: from), writer = try FileHandle(forWritingTo: to)
            defer { try? reader.close(); try? writer.close() }
            try writer.truncate(atOffset: offset)
            done += offset
            while offset < size {
                try reader.seek(toOffset: offset)
                let chunk = try reader.read(upToCount: chunkBytes) ?? Data()
                guard !chunk.isEmpty else { break }
                try writer.seek(toOffset: offset)
                try writer.write(contentsOf: chunk)
                offset += UInt64(chunk.count); done += UInt64(chunk.count); moved += UInt64(chunk.count)
                try await progress(done, total)
                if pauseMs > 0 { try await Task.sleep(nanoseconds: UInt64(pauseMs) * 1_000_000) }
            }
        }
        try await rendezvous.publish([ImageCopyCandidate(kind: Self.done, address: "", port: 0)])
        return ImageCopyReport(bytes: moved, durationMs: Int(Date().timeIntervalSince(started) * 1000), path: .localNetwork)
    }
}

private func fileSize(_ url: URL) -> UInt64 { ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.uint64Value ?? 0 }
