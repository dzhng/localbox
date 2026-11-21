import Foundation

/// The two ways a receiver can reach a sender, tried in this order.
public enum PathKind: String, Codable, Sendable {
    /// A local interface address: same network.
    case local
    /// A NAT's public mapping (STUN-reflected, or the source a punch arrived from): across networks.
    case punched
}

/// An address a peer can try. `local` addresses are this Mac's interfaces; `reflexive` is what STUN saw
/// (the NAT's public mapping of our port); `peer-reflexive` is a source address a peer's punch arrived from.
public struct Candidate: Codable, Equatable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable { case local, reflexive, peerReflexive = "peer-reflexive" }
    public var kind: Kind
    public var address: String
    public var port: UInt16

    public init(kind: Kind, address: String, port: UInt16) { self.kind = kind; self.address = address; self.port = port }

    public var peer: PeerAddress { PeerAddress(address, port) }
    public var path: PathKind { kind == .local ? .local : .punched }
    public var label: String { "\(kind.rawValue) \(address):\(port)" }
}

/// What STUN told us. `mapping` compares the reflected port toward two destinations: the same port means an
/// endpoint-independent mapping (punchable); different ports mean a symmetric NAT (a punch will likely fail).
public struct NATReport: Codable, Equatable, Sendable {
    public var server: String
    public var reflexive: Candidate?
    public var secondReflexive: Candidate?
    public var mapping: String
    public var error: String?
}

/// What one transport offers the peer for this side's port.
public struct Gathered: Sendable {
    public var candidates: [Candidate]
    public var nat: NATReport?
    /// Why this transport offers nothing, when it doesn't.
    public var unavailable: String?
}

/// One way to reach the peer over the shared port. Every transport's candidates ride the same port, so the
/// address STUN reflected is the one a punch opens, and the first authenticated reply picks the path.
public protocol Transport: Sendable {
    var kind: PathKind { get }
    /// Seconds into path selection before the receiver tries the peer's candidates of this kind, so an
    /// earlier transport wins when both work.
    var delay: TimeInterval { get }
    /// Flows (local ports) the receiver uses once a path of this kind wins.
    var flows: Int { get }
    /// Candidates for `port`, gathered before the transfer starts (it may take over `port.onDatagrams`).
    func gather(on port: any DatagramPort) -> Gathered
}

/// Same network: this Mac's IPv4 interface addresses (or the given ones), tried at once, on two flows.
/// Network.framework's ceiling is per process pair (~260k datagrams/s in spike 20, whatever the flow count),
/// but two flows halve each flow's burst into its socket buffer, which cut loss in the spike's runs.
public struct LANTransport: Transport {
    public let kind = PathKind.local
    public let delay: TimeInterval = 0
    public var flows: Int
    /// nil: this Mac's interfaces, skipping loopback and link-local.
    public var addresses: [String]?

    public init(addresses: [String]? = nil, flows: Int = 2) { self.addresses = addresses; self.flows = max(1, flows) }

    public func gather(on port: any DatagramPort) -> Gathered {
        let addresses = addresses ?? Self.interfaceAddresses()
        return Gathered(candidates: addresses.map { Candidate(kind: .local, address: $0, port: port.localPort) },
                        unavailable: addresses.isEmpty ? "this Mac has no IPv4 network address" : nil)
    }

    public static func interfaceAddresses() -> [String] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }
        var out: [String] = []
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let entry = pointer.pointee
            guard let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  entry.ifa_flags & UInt32(IFF_UP) != 0, entry.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let text = String(cString: host)
            if !text.hasPrefix("169.254."), !out.contains(text) { out.append(text) }
        }
        return out
    }
}

/// Across networks: the port's public mapping from STUN, tried after the local head start, on one flow (each
/// extra port would need its own NAT mapping). The sender punches toward the receiver's candidates as soon as
/// its answer arrives, so both NATs open a mapping for the other.
public struct PunchedUDPTransport: Transport {
    public let kind = PathKind.punched
    public var delay: TimeInterval
    public let flows = 1
    public var stunHost: String
    /// The second destination tells endpoint-independent from symmetric mapping.
    public var stunPorts: [UInt16]
    public var budget: TimeInterval

    public init(stunHost: String = "stun.cloudflare.com", stunPorts: [UInt16] = [3478, 53], budget: TimeInterval = 2.5, delay: TimeInterval = 0.3) {
        self.stunHost = stunHost; self.stunPorts = stunPorts; self.budget = budget; self.delay = delay
    }

    public func gather(on port: any DatagramPort) -> Gathered {
        let nat = stun(port)
        return Gathered(candidates: nat.reflexive.map { [$0] } ?? [], nat: nat, unavailable: nat.error)
    }

    /// Binding requests from `port` itself to the STUN server, retried every 400 ms within `budget`. Takes over
    /// `port.onDatagrams` while it runs. The flows are cancelled afterwards: a live flow to the STUN server on
    /// the shared port stopped every later flow from that port in spike 20.
    public func stun(_ port: any DatagramPort) -> NATReport {
        let servers = stunPorts.map { PeerAddress(stunHost, $0) }
        let transactions = servers.map { _ in Data((0..<12).map { _ in UInt8.random(in: 0...255) }) }
        var mapped: [Int: Candidate] = [:]
        let finished = DispatchSemaphore(value: 0)
        port.delivery.sync {
            port.onDatagrams = { batch in
                for datagram in batch {
                    guard let (transaction, address, mappedPort) = StunMessage.parseBindingResponse(datagram.data),
                          let index = transactions.firstIndex(of: transaction), mapped[index] == nil else { continue }
                    mapped[index] = Candidate(kind: .reflexive, address: address, port: mappedPort)
                    if mapped.count == servers.count { finished.signal() }
                }
            }
        }
        let deadline = Date().addingTimeInterval(budget)
        repeat {
            port.delivery.sync { for (index, server) in servers.enumerated() where mapped[index] == nil { port.send([StunMessage.bindingRequest(transactions[index])], to: server) } }
        } while finished.wait(timeout: .now() + 0.4) == .timedOut && Date() < deadline
        servers.forEach(port.disconnect)
        return port.delivery.sync {
            port.onDatagrams = nil
            let first = mapped[0], second = mapped[1]
            let mapping: String
            switch (first, second) {
            case let (a?, b?): mapping = a.port == b.port && a.address == b.address ? "endpoint-independent" : "endpoint-dependent (symmetric NAT)"
            case (_?, nil): mapping = "unknown (only one STUN destination answered)"
            default: mapping = "unknown"
            }
            return NATReport(server: servers.first?.description ?? stunHost, reflexive: first, secondReflexive: second, mapping: mapping,
                             error: first == nil ? "no STUN response from \(servers.first?.description ?? stunHost) within \(budget)s" : nil)
        }
    }
}

/// RFC 5389 binding request and the XOR-MAPPED-ADDRESS (or legacy MAPPED-ADDRESS) in its success response.
enum StunMessage {
    static let cookie: UInt32 = 0x2112_A442

    static func bindingRequest(_ transaction: Data) -> Data {
        var out = Data()
        out.appendBE(UInt16(0x0001)); out.appendBE(UInt16(0)); out.appendBE(cookie); out.append(transaction)
        return out
    }

    static func parseBindingResponse(_ data: Data) -> (transaction: Data, address: String, port: UInt16)? {
        guard data.count >= 20, data.readBE(UInt16.self, at: 0) == 0x0101, data.readBE(UInt32.self, at: 4) == cookie else { return nil }
        let transaction = data.subdata(in: data.startIndex + 8..<data.startIndex + 20)
        let end = min(data.count, 20 + Int(data.readBE(UInt16.self, at: 2)))
        var at = 20; var fallback: (String, UInt16)?
        while at + 4 <= end {
            let type = data.readBE(UInt16.self, at: at), length = Int(data.readBE(UInt16.self, at: at + 2))
            let value = at + 4
            guard value + length <= end else { break }
            if (type == 0x0020 || type == 0x0001), length >= 8, data.byte(value + 1) == 0x01 {
                let xor = type == 0x0020
                let port = data.readBE(UInt16.self, at: value + 2) ^ (xor ? UInt16(cookie >> 16) : 0)
                let raw = data.readBE(UInt32.self, at: value + 4) ^ (xor ? cookie : 0)
                let address = "\(raw >> 24).\(raw >> 16 & 0xff).\(raw >> 8 & 0xff).\(raw & 0xff)"
                if xor { return (transaction, address, port) }
                fallback = (address, port)
            }
            at = value + (length + 3) & ~3
        }
        return fallback.map { (transaction, $0.0, $0.1) }
    }
}
