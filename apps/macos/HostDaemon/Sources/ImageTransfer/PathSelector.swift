import Foundation

/// The transports in the order they are tried: local candidates first, then punched ones after their head
/// start. The receiver says HELLO to every candidate on the schedule this sets; the first one that answers
/// with the key wins. When none does, `attempts` explains every path tried and why it failed.
public struct PathSelector: Sendable {
    public var transports: [any Transport]

    public init(_ transports: [any Transport] = [LANTransport(), PunchedUDPTransport()]) { self.transports = transports }

    func transport(_ kind: PathKind) -> (any Transport)? { transports.first { $0.kind == kind } }

    /// Seconds into selection before the receiver says HELLO to `candidate`; nil when no transport here takes
    /// its kind. A peer-reflexive candidate is tried at once: a punch already arrived from it.
    func delay(for candidate: Candidate) -> TimeInterval? {
        candidate.kind == .peerReflexive ? 0 : transport(candidate.path)?.delay
    }

    func flows(for path: PathKind) -> Int { transport(path)?.flows ?? 1 }

    /// For an unreachable peer: per transport, either why there was nothing to try, or each candidate tried.
    func attempts(offered: [Candidate], learned: [Candidate], unavailableHere: [PathAttempt], timeout: TimeInterval) -> [PathAttempt] {
        var out: [PathAttempt] = []
        for transport in transports {
            let tried = (offered + learned).filter { $0.path == transport.kind && delay(for: $0) != nil }
            let here = unavailableHere.filter { $0.path == transport.kind }
            if tried.isEmpty {
                out.append(PathAttempt(path: transport.kind, candidate: nil, reason: "the sender offered no \(transport.kind.rawValue) candidate"))
            }
            for candidate in tried {
                out.append(PathAttempt(path: transport.kind, candidate: candidate, reason: "no authenticated reply within \(Int(timeout))s"))
            }
            out.append(contentsOf: here)
        }
        return out
    }
}

/// One path tried, and why it failed.
public struct PathAttempt: Codable, Equatable, Sendable, CustomStringConvertible {
    public var path: PathKind
    public var candidate: Candidate?
    public var reason: String

    public var description: String { "\(candidate?.label ?? path.rawValue): \(reason)" }
}

/// The path a transfer took.
public struct TransferPath: Codable, Equatable, Sendable {
    public var kind: PathKind
    public var candidate: Candidate
    public var flows: Int
}

/// One side of a transfer: its port, and the candidates every transport gathered for it. Gathering blocks for up
/// to the STUN budget. Hand `candidates` to the peer (with the key, through the rendezvous); the sender passes
/// the endpoint to `Sender.send`, the receiver to `Receiver.receive`.
public final class TransferEndpoint: @unchecked Sendable {
    public let port: any DatagramPort
    public let selector: PathSelector
    public let candidates: [Candidate]
    public let nat: NATReport?
    /// Transports that offer nothing from this side, and why (no network address, no STUN answer).
    public let unavailable: [PathAttempt]

    public init(port: any DatagramPort, selector: PathSelector = PathSelector()) {
        self.port = port; self.selector = selector
        var candidates: [Candidate] = [], unavailable: [PathAttempt] = [], nat: NATReport?
        for transport in selector.transports {
            let gathered = transport.gather(on: port)
            nat = nat ?? gathered.nat
            if let reason = gathered.unavailable { unavailable.append(PathAttempt(path: transport.kind, candidate: nil, reason: "this side: \(reason)")) }
            for candidate in gathered.candidates where !candidates.contains(where: { $0.peer == candidate.peer }) { candidates.append(candidate) }
        }
        self.candidates = candidates; self.nat = nat; self.unavailable = unavailable
    }

    public func close() { port.close() }
}
