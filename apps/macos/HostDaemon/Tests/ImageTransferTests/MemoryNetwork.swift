import Foundation
@testable import ImageTransfer

/// Ports that reach each other by address inside one process, with loss, reordering and tampering injected on
/// the way, and fake STUN servers that reflect a port as a public alias routed back to it.
final class MemoryNetwork: @unchecked Sendable {
    struct Conditions {
        var loss = 0.0
        /// Chance a datagram is held back and delivered after the next batch to the same port.
        var reorder = 0.0
        /// Sees every datagram that survives loss; returns what is delivered.
        var tamper: ((Data) -> Data)?
    }

    var conditions: Conditions {
        get { lock.withLock { _conditions } }
        set { lock.withLock { _conditions = newValue } }
    }

    private let lock = NSLock()
    private var _conditions = Conditions()
    private var ports: [PeerAddress: MemoryPort] = [:]
    /// A public address (from a fake STUN server) and the port it routes to.
    private var aliases: [PeerAddress: PeerAddress] = [:]
    private var stunServers: [String: (PeerAddress) -> PeerAddress] = [:]
    /// Replies from a port reached through its public alias come from that alias, as through a NAT's mapping.
    private var replySources: [Flow: PeerAddress] = [:]
    private struct Flow: Hashable { var from: PeerAddress; var to: PeerAddress }
    private var held: [PeerAddress: [(Data, PeerAddress)]] = [:]
    private var nextPort: UInt16 = 40_000
    private var random = SplitMix(seed: 0x5EED)
    private let wire = DispatchQueue(label: "memory.wire")

    init(_ conditions: Conditions = Conditions()) { _conditions = conditions }

    func port(host: String, delivery: DispatchQueue = DispatchQueue(label: "memory.delivery", qos: .userInteractive)) -> MemoryPort {
        lock.withLock {
            nextPort += 1
            let port = MemoryPort(network: self, address: PeerAddress(host, nextPort), delivery: delivery)
            ports[port.address] = port
            return port
        }
    }

    /// Binding requests to `host` (any port) are answered with `publicHost` and the requester's port, and that
    /// public address then routes to the requester: an endpoint-independent NAT.
    func addStunServer(host: String, publicHost: String) {
        lock.withLock { stunServers[host] = { PeerAddress(publicHost, $0.port) } }
    }

    func remove(_ address: PeerAddress) { lock.withLock { ports[address] = nil } }

    func carry(_ datagrams: [Data], from source: PeerAddress, to destination: PeerAddress) {
        lock.lock()
        if let reflect = stunServers[destination.host] {
            let mapped = reflect(source)
            aliases[mapped] = source
            let target = ports[source]
            lock.unlock()
            let responses = datagrams.compactMap { StunMessage.parseBindingRequest($0).map { StunMessage.bindingResponse($0, mapped: mapped) } }
            target?.receive(responses, from: destination)
            return
        }
        let resolved = aliases[destination] ?? destination
        guard let target = ports[resolved] else { lock.unlock(); return }
        if resolved != destination { replySources[Flow(from: resolved, to: source)] = destination }
        let source = replySources[Flow(from: source, to: resolved)] ?? source
        var batch: [(Data, PeerAddress)] = [], newlyHeld: [(Data, PeerAddress)] = []
        for datagram in datagrams {
            if random.unit() < _conditions.loss { continue }
            let delivered = _conditions.tamper?(datagram) ?? datagram
            if random.unit() < _conditions.reorder { newlyHeld.append((delivered, source)) } else { batch.append((delivered, source)) }
        }
        batch += held[resolved] ?? []
        held[resolved] = newlyHeld
        lock.unlock()
        deliver(batch, to: target)
        if !newlyHeld.isEmpty {
            // Stragglers are delivered late even when no later batch comes along.
            wire.asyncAfter(deadline: .now() + .milliseconds(3)) { [self] in
                lock.lock(); let late = held[resolved] ?? []; held[resolved] = []; lock.unlock()
                deliver(late, to: target)
            }
        }
    }

    private func deliver(_ batch: [(Data, PeerAddress)], to target: MemoryPort) {
        var bySource: [PeerAddress: [Data]] = [:], order: [PeerAddress] = []
        for (data, source) in batch {
            if bySource[source] == nil { order.append(source) }
            bySource[source, default: []].append(data)
        }
        for source in order { target.receive(bySource[source]!, from: source) }
    }
}

final class MemoryPort: DatagramPort, @unchecked Sendable {
    let address: PeerAddress
    let delivery: DispatchQueue
    var localPort: UInt16 { address.port }
    var open: ((Data) -> (PacketHeader, Data)?)?
    var onDatagrams: (([Datagram]) -> Void)?
    private let network: MemoryNetwork  // strong: a test may hold only the ports
    private let opener = DispatchQueue(label: "memory.open", qos: .userInteractive)

    init(network: MemoryNetwork, address: PeerAddress, delivery: DispatchQueue) {
        self.network = network; self.address = address; self.delivery = delivery
    }

    func send(_ datagrams: [Data], to remote: PeerAddress) { network.carry(datagrams, from: address, to: remote) }
    func disconnect(_ remote: PeerAddress) {}
    func close() { network.remove(address) }
    func sibling() throws -> any DatagramPort { network.port(host: address.host, delivery: delivery) }

    func receive(_ datagrams: [Data], from source: PeerAddress) {
        guard !datagrams.isEmpty else { return }
        opener.async { [self] in
            var batch = datagrams.map { Datagram(data: $0, from: source) }
            if let open { for index in batch.indices { batch[index].opened = open(batch[index].data) } }
            delivery.async { [self] in onDatagrams?(batch) }
        }
    }
}

struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
}

extension StunMessage {
    static func parseBindingRequest(_ data: Data) -> Data? {
        guard data.count >= 20, data.readBE(UInt16.self, at: 0) == 0x0001, data.readBE(UInt32.self, at: 4) == cookie else { return nil }
        return data.subdata(in: data.startIndex + 8..<data.startIndex + 20)
    }

    static func bindingResponse(_ transaction: Data, mapped: PeerAddress) -> Data {
        let octets = mapped.host.split(separator: ".").compactMap { UInt32($0) }
        let raw = octets.reduce(0) { $0 << 8 | $1 }
        var out = Data()
        out.appendBE(UInt16(0x0101)); out.appendBE(UInt16(12)); out.appendBE(cookie); out.append(transaction)
        out.appendBE(UInt16(0x0020)); out.appendBE(UInt16(8)); out.append(0); out.append(0x01)
        out.appendBE(mapped.port ^ UInt16(cookie >> 16)); out.appendBE(raw ^ cookie)
        return out
    }
}
