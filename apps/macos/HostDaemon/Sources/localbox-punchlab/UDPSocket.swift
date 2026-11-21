import Foundation
import Network

/// One local UDP port, Network.framework only. A listener takes datagrams from peers we have not sent to yet
/// (a punch arriving first); every peer we send to gets a connected NWConnection bound to the *same* local
/// port, so the address STUN reflected is the one the peer sees, and the kernel delivers that peer's
/// datagrams straight to the connected flow. IPv4 only.
///
/// Three stages per socket, each its own thread: Network.framework callbacks only collect datagrams (any
/// work there slows its reads and the kernel buffer overflows); an opener authenticates them in batches
/// (AEAD is most of the per-datagram cost, and one opener per socket spreads it across flows); the owner
/// gets the results in batches on `delivery`, where its state lives.
final class UDPSocket: @unchecked Sendable {
    struct Datagram {
        var data: Data
        var from: NWEndpoint
        /// What `open` returned; nil when it isn't set or the datagram failed authentication.
        var opened: (header: PacketHeader, payload: Data)?
    }

    /// The owner's queue: batches are delivered here, and the owner's state lives here.
    let delivery: DispatchQueue
    private(set) var port: UInt16 = 0
    /// Called on `delivery` with every datagram that arrived since the previous call.
    var onDatagrams: (([Datagram]) -> Void)?
    /// Runs on this socket's opener thread for every datagram; set before traffic starts.
    var open: ((Data) -> (PacketHeader, Data)?)?

    private let io = DispatchQueue(label: "punchlab.udp.io", qos: .userInteractive)
    private let opener = DispatchQueue(label: "punchlab.udp.open", qos: .userInteractive)
    private let lock = NSLock()
    private var connections: [NWEndpoint: NWConnection] = [:]
    private var raw: [Datagram] = []
    private var inbox: [Datagram] = []
    private var listener: NWListener?
    /// Several receives in flight per flow: with one, Network.framework hands datagrams over one callback
    /// round trip at a time and the receive rate drops by about half.
    private let pendingReceives = 32

    init(port requested: UInt16 = 0, delivery: DispatchQueue) throws {
        self.delivery = delivery
        let listener = try NWListener(using: Self.parameters(localPort: nil), on: requested == 0 ? .any : NWEndpoint.Port(rawValue: requested)!)
        let ready = DispatchSemaphore(value: 0)
        var failure: Error?
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.signal()
            case .failed(let error): failure = error; ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.adopt(connection) }
        listener.start(queue: io)
        self.listener = listener
        guard ready.wait(timeout: .now() + 5) == .success, failure == nil, let bound = listener.port?.rawValue else {
            throw PunchError("cannot bind UDP port \(requested): \(failure.map { "\($0)" } ?? "timed out")")
        }
        port = bound
    }

    static func parameters(localPort: UInt16?) -> NWParameters {
        let parameters = NWParameters.udp
        parameters.allowLocalEndpointReuse = true
        (parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4
        if let localPort { parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.any), port: NWEndpoint.Port(rawValue: localPort)!) }
        return parameters
    }

    static func endpoint(_ address: String, _ port: UInt16) -> NWEndpoint {
        .hostPort(host: IPv4Address(address).map { .ipv4($0) } ?? .name(address, nil), port: NWEndpoint.Port(rawValue: port)!)
    }

    /// Any thread. `.idempotent` sends: a datagram the kernel drops is the protocol's loss to recover, not
    /// an error to surface.
    func send(_ datagrams: [Data], to remote: NWEndpoint) {
        let connection = connection(to: remote)
        connection.batch { for datagram in datagrams { connection.send(content: datagram, completion: .idempotent) } }
    }

    /// Cancels the flow to `remote`, if any.
    func disconnect(_ remote: NWEndpoint) {
        lock.lock(); let connection = connections.removeValue(forKey: remote); lock.unlock()
        connection?.cancel()
    }

    func close() {
        lock.lock(); let all = Array(connections.values); connections.removeAll(); lock.unlock()
        listener?.cancel()
        all.forEach { $0.cancel() }
    }

    private func connection(to remote: NWEndpoint) -> NWConnection {
        lock.lock()
        if let existing = connections[remote] { lock.unlock(); return existing }
        let connection = NWConnection(to: remote, using: Self.parameters(localPort: port))
        connections[remote] = connection
        lock.unlock()
        start(connection, remote: remote)
        return connection
    }

    private func adopt(_ connection: NWConnection) {
        let remote = connection.endpoint
        lock.lock()
        if connections[remote] == nil { connections[remote] = connection }
        lock.unlock()
        start(connection, remote: remote)
    }

    private func start(_ connection: NWConnection, remote: NWEndpoint) {
        // A flow that fails (ICMP unreachable while the peer restarts) is dropped so the next send rebuilds it.
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard case .failed = state, let self, let connection else { return }
            connection.cancel()
            self.lock.lock()
            if self.connections[remote] === connection { self.connections[remote] = nil }
            self.lock.unlock()
        }
        connection.start(queue: io)
        for _ in 0..<pendingReceives { receive(on: connection, from: remote) }
    }

    private func receive(on connection: NWConnection, from remote: NWEndpoint) {
        connection.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.lock.lock()
                let wasEmpty = self.raw.isEmpty
                self.raw.append(Datagram(data: data, from: remote))
                self.lock.unlock()
                if wasEmpty { self.opener.async { self.openRaw() } }
            }
            if error == nil, connection.state != .cancelled { self.receive(on: connection, from: remote) }
        }
    }

    private func openRaw() {
        lock.lock(); var batch = raw; raw.removeAll(keepingCapacity: true); lock.unlock()
        if let open { for index in batch.indices { batch[index].opened = open(batch[index].data) } }
        lock.lock()
        let wasEmpty = inbox.isEmpty
        inbox.append(contentsOf: batch)
        lock.unlock()
        if wasEmpty { delivery.async { self.drain() } }
    }

    private func drain() {
        lock.lock(); let batch = inbox; inbox.removeAll(keepingCapacity: true); lock.unlock()
        if !batch.isEmpty { onDatagrams?(batch) }
    }
}
