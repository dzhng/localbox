import Foundation

// The seam between the daemon's `image.copy` operation and the bytes. The daemon owns the journal, the image store and
// the rendezvous; a transport owns everything on the wire (paths, AEAD with the copy's key, resume). Every daemon uses
// `ImageTransferCopyTransport` (target `ImageCopyTransfer`, over `ImageTransfer`), wired in `localbox-hostd/main.swift`.

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
    var text: String { "\(path == .localNetwork ? "local network" : "internet")\(candidate.isEmpty ? "" : " \(candidate)") (\(reason))" }
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
    /// The peer's candidates once it has published some, or throws when it stays silent too long. With `previous`, waits
    /// with no deadline for a set different from it (the peer restarted and gathered new ones), so the transport bounds
    /// its own transfer. Either throws when the copy failed elsewhere.
    func peerCandidates(after previous: [ImageCopyCandidate]?) async throws -> [ImageCopyCandidate]
}

/// Bytes done of bytes total; throws once the operation must stop (the daemon is exiting), which ends the transfer.
public typealias ImageCopyProgress = @Sendable (_ done: UInt64, _ total: UInt64) async throws -> Void

/// An image's files as `ImageStore` lays them out: the directory and the paths in it that make up the image.
public struct ImageCopySource: Equatable, Sendable {
    public let directory: URL
    public let files: [String]
    public init(directory: URL, files: [String]) { self.directory = directory; self.files = files }
}

/// Moves one image between two Macs. `receive` writes into a temporary directory that survives a daemon restart, so a
/// transport that resumes finds what an earlier run wrote; the daemon verifies and commits it after. The receiver
/// reports progress; the sender serves what it is asked for and knows no total.
public protocol ImageCopyTransport: Sendable {
    func send(_ image: ImageCopySource, key: Data, rendezvous: any ImageCopyRendezvous) async throws -> ImageCopyReport
    func receive(into temp: URL, key: Data, rendezvous: any ImageCopyRendezvous, progress: @escaping ImageCopyProgress) async throws -> ImageCopyReport
}
