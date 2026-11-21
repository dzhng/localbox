import CryptoKit
import Foundation
import HostDaemonCore
import ImageTransfer

/// The daemon's image copy transport: `ImageCopyTransport` over the `ImageTransfer` library. Each side opens one UDP
/// port, gathers its candidates (interface addresses, the STUN mapping) and publishes them through the rendezvous; the
/// receiver drives the transfer into the daemon's resumable temporary, so a restarted receiver resumes from the bitmap
/// beside it. `ImageTransfer` knows nothing of the daemon; this is the only place the two meet.
public struct ImageTransferCopyTransport: ImageCopyTransport {
    /// The paths to try, in order: the local network, then a punched connection.
    public var selector: PathSelector
    /// The sender's pacing and its idle timeout: it gives up when the receiver asks for nothing for that long.
    public var sender: Sender.Options
    /// How long a receiver says HELLO to the sender's candidates before the copy is unreachable.
    public var punchTimeout: TimeInterval
    /// A receiver whose bytes stop moving for this long asks the sender again from the start of path selection, which
    /// resumes the transfer or ends it unreachable; the library itself re-requests forever.
    public var stallSeconds: TimeInterval

    /// A sender waits as long for a restarting receiver as a side waits for its peer (`ImageCopy`'s 120 s).
    public static let senderIdleSeconds: TimeInterval = 120

    public init(selector: PathSelector = PathSelector(), sender: Sender.Options? = nil, punchTimeout: TimeInterval = 15, stallSeconds: TimeInterval = 60) {
        self.selector = selector; self.punchTimeout = punchTimeout; self.stallSeconds = stallSeconds
        self.sender = sender ?? { var options = Sender.Options(); options.idleTimeout = Self.senderIdleSeconds; return options }()
    }

    public func send(_ image: ImageCopySource, key: Data, rendezvous: any ImageCopyRendezvous, progress: @escaping ImageCopyProgress) async throws -> ImageCopyReport {
        let started = Date()
        let secret = try Self.secret(key)
        let manifest = try await blocking { try TransferManifest.build(root: image.directory, paths: image.files) }
        let endpoint = try await openEndpoint("localbox.copy.send")
        defer { endpoint.close() }
        try await rendezvous.publish(endpoint.candidates.map(Self.wire))
        let receivers = Receivers()
        let (answers, feed) = AsyncStream<[Candidate]>.makeStream()
        let options = sender
        let sent = try await withThrowingTaskGroup(of: SenderReport?.self) { group -> SenderReport in
            defer { group.cancelAll(); feed.finish() }
            // Every candidate set a receiver publishes (a restarted one publishes anew) is punched toward; a copy that
            // failed elsewhere ends the send.
            group.addTask {
                var previous: [ImageCopyCandidate]?
                while true {
                    let peer = try await rendezvous.peerCandidates(after: previous)
                    previous = peer
                    let candidates = peer.compactMap(Self.candidate)
                    receivers.add(candidates)
                    feed.yield(candidates)
                }
            }
            group.addTask { try await Sender.send(directory: image.directory, manifest: manifest, key: secret, over: endpoint, answers: answers, options: options) }
            while let next = try await group.next() { if let report = next { return report } }
            throw CancellationError()
        }
        try Task.checkCancellation()
        guard sent.finished else {
            throw HostOperationFailure(code: "copy_unreachable", message: "the receiving Mac asked for nothing for \(Int(options.idleTimeout)) s", nextStep: ImageCopy.unreachableNextStep)
        }
        return ImageCopyReport(bytes: UInt64(sent.dataBytes), durationMs: Self.ms(since: started), path: receivers.path(of: sent.peers.last))
    }

    public func receive(into temp: URL, key: Data, rendezvous: any ImageCopyRendezvous, progress: @escaping ImageCopyProgress) async throws -> ImageCopyReport {
        let started = Date()
        let secret = try Self.secret(key)
        let endpoint = try await openEndpoint("localbox.copy.receive")
        defer { endpoint.close() }
        try await rendezvous.publish(endpoint.candidates.map(Self.wire))
        var offer = try await rendezvous.peerCandidates(after: nil)
        var stalledAt: UInt64?
        while true {
            switch try await attempt(into: temp, key: secret, offer: offer, endpoint: endpoint, rendezvous: rendezvous, progress: progress) {
            case let .received(report):
                return ImageCopyReport(bytes: report.stats.receivedBytes, durationMs: Self.ms(since: started), path: report.path.kind == .local ? .localNetwork : .internet)
            case let .peerChanged(next):
                // The sender restarted and gathered new candidates: ask it again; the bitmap keeps what arrived.
                offer = next; stalledAt = nil
            case let .stalled(done):
                guard stalledAt != done else {
                    throw HostOperationFailure(code: "copy_unreachable", message: "the sending Mac answered but sent nothing for \(Int(stallSeconds)) s, twice", nextStep: ImageCopy.unreachableNextStep)
                }
                stalledAt = done
            }
        }
    }

    private enum Attempt: Sendable { case received(TransferReport), peerChanged([ImageCopyCandidate]), stalled(done: UInt64) }

    /// One `Receiver.receive` toward `offer`, raced against the sender publishing new candidates and against a stall.
    /// Ends with the first; the receive is cancelled (its bitmap saved) before the next attempt starts on the same port.
    private func attempt(into temp: URL, key: SymmetricKey, offer: [ImageCopyCandidate], endpoint: TransferEndpoint, rendezvous: any ImageCopyRendezvous, progress: @escaping ImageCopyProgress) async throws -> Attempt {
        let meter = Meter()
        var options = Receiver.Options()
        options.punchTimeout = punchTimeout
        options.progress = { meter.latest = $0 }
        let candidates = offer.compactMap(Self.candidate)
        let stallSeconds = stallSeconds
        return try await withThrowingTaskGroup(of: Attempt.self) { group in
            defer { group.cancelAll() }
            group.addTask {
                do { return .received(try await Receiver.receive(into: temp, key: key, offer: candidates, over: endpoint, options: options)) }
                catch let TransferError.unreachable(_, attempts) { throw ImageCopyUnreachable(tried: attempts.map(Self.attempt)) }
            }
            group.addTask { .peerChanged(try await rendezvous.peerCandidates(after: offer)) }
            // The daemon's progress, and the stall clock: it runs only once a path won (the receive's own punch timeout
            // covers the time before).
            group.addTask {
                var last: UInt64?, moved = Date()
                while true {
                    try await Task.sleep(nanoseconds: 250_000_000)
                    guard let now = meter.latest else { continue }
                    if now.doneBytes != last { last = now.doneBytes; moved = Date() }
                    try await progress(now.doneBytes, now.dataBytes)
                    if Date().timeIntervalSince(moved) > stallSeconds { return .stalled(done: now.doneBytes) }
                }
            }
            return try await group.next()!
        }
    }

    /// A port and the candidates every transport gathered for it; gathering blocks (STUN), so it runs off the pool.
    private func openEndpoint(_ label: String) async throws -> TransferEndpoint {
        let selector = selector
        return try await blocking { TransferEndpoint(port: try UDPSocket(delivery: DispatchQueue(label: label, qos: .userInteractive)), selector: selector) }
    }

    static func secret(_ key: Data) throws -> SymmetricKey {
        guard key.count == 32 else { throw HostOperationFailure(code: "internal", message: "the copy's key is \(key.count) bytes, not 32") }
        return SymmetricKey(data: key)
    }

    static func wire(_ candidate: Candidate) -> ImageCopyCandidate { ImageCopyCandidate(kind: candidate.kind.rawValue, address: candidate.address, port: Int(candidate.port)) }

    /// A peer's candidate this library can try; nil for a kind or port it doesn't know.
    static func candidate(_ wire: ImageCopyCandidate) -> Candidate? {
        guard let kind = Candidate.Kind(rawValue: wire.kind), let port = UInt16(exactly: wire.port) else { return nil }
        return Candidate(kind: kind, address: wire.address, port: port)
    }

    static func attempt(_ tried: PathAttempt) -> ImageCopyAttempt {
        ImageCopyAttempt(path: tried.path == .local ? .localNetwork : .internet, candidate: tried.candidate.map { "\($0.address):\($0.port)" } ?? "", reason: tried.reason)
    }

    static func ms(since start: Date) -> Int { Int(Date().timeIntervalSince(start) * 1000) }
}

/// The receive's latest progress, written on its delivery queue and read by the progress task.
private final class Meter: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TransferProgress?
    var latest: TransferProgress? {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

/// Every candidate the receivers published, to name the path the sender's last peer came in on.
private final class Receivers: @unchecked Sendable {
    private let lock = NSLock()
    private var local: Set<String> = []
    func add(_ candidates: [Candidate]) { lock.withLock { for candidate in candidates where candidate.kind == .local { local.insert(candidate.peer.description) } } }
    /// A peer that came from one of a receiver's interface addresses is on the local network; anything else crossed a NAT.
    func path(of peer: String?) -> ImageCopyPath { lock.withLock { peer.map { local.contains($0) } ?? true ? .localNetwork : .internet } }
}

/// Runs blocking work (hashing a whole image, binding a socket, STUN) on a thread of its own instead of the pool.
private func blocking<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async { continuation.resume(with: Result { try work() }) }
    }
}
