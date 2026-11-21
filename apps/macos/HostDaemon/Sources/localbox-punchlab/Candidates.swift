import Foundation
import Network

/// An address a peer can try. `local` addresses are this Mac's interfaces; `reflexive` is what STUN saw
/// (the NAT's public mapping of our port); `peer-reflexive` is a source address a peer's punch arrived from.
struct Candidate: Codable, Equatable, Hashable {
    enum Kind: String, Codable { case local, reflexive, peerReflexive = "peer-reflexive" }
    var kind: Kind
    var address: String
    var port: UInt16

    var endpoint: NWEndpoint { UDPSocket.endpoint(address, port) }
    var label: String { "\(kind.rawValue) \(address):\(port)" }
}

/// What STUN told us. `mapping` compares the reflected port toward two destinations: the same port means an
/// endpoint-independent mapping (punchable); different ports mean a symmetric NAT (a punch will likely fail).
struct NATReport: Codable, Equatable {
    var server: String
    var reflexive: Candidate?
    var secondReflexive: Candidate?
    var mapping: String
    var error: String?
}

/// The pasted file the sending side writes: candidates plus the one-time key. Whoever holds it can read the
/// transfer, so it travels like a password.
struct Offer: Codable, Equatable {
    var id: String
    var key: String
    var candidates: [Candidate]
    var nat: NATReport?
}

/// The pasted reply. The sending side watches for it and punches toward its candidates; a new `id` (a
/// restarted receiver) makes it punch again.
struct Answer: Codable, Equatable {
    var id: String
    var offer: String
    var candidates: [Candidate]
    var nat: NATReport?
}

enum CandidateGatherer {
    static let stunHost = "stun.cloudflare.com"

    /// This Mac's IPv4 interface addresses, skipping loopback and link-local.
    static func localAddresses() -> [String] {
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

    /// Binding requests from `socket`'s own port to the STUN server on 3478 and 53, retried every 400 ms
    /// within `budget`. Takes over `socket.onDatagrams` while it runs; call before the transfer starts.
    static func stun(_ socket: UDPSocket, budget: TimeInterval = 2.5) -> NATReport {
        let servers = [UDPSocket.endpoint(stunHost, 3478), UDPSocket.endpoint(stunHost, 53)]
        let transactions = servers.map { _ in Data((0..<12).map { _ in UInt8.random(in: 0...255) }) }
        var mapped: [Int: Candidate] = [:]
        let finished = DispatchSemaphore(value: 0)
        socket.delivery.sync {
            socket.onDatagrams = { batch in
                for datagram in batch {
                    guard let (transaction, address, port) = StunMessage.parseBindingResponse(datagram.data),
                          let index = transactions.firstIndex(of: transaction), mapped[index] == nil else { continue }
                    mapped[index] = Candidate(kind: .reflexive, address: address, port: port)
                    if mapped.count == servers.count { finished.signal() }
                }
            }
        }
        let deadline = Date().addingTimeInterval(budget)
        repeat {
            socket.delivery.sync { for (index, server) in servers.enumerated() where mapped[index] == nil { socket.send([StunMessage.bindingRequest(transactions[index])], to: server) } }
        } while finished.wait(timeout: .now() + 0.4) == .timedOut && Date() < deadline
        servers.forEach(socket.disconnect)
        return socket.delivery.sync {
            socket.onDatagrams = nil
            let first = mapped[0], second = mapped[1]
            let mapping: String
            switch (first, second) {
            case let (a?, b?): mapping = a.port == b.port && a.address == b.address ? "endpoint-independent" : "endpoint-dependent (symmetric NAT)"
            case (_?, nil): mapping = "unknown (only one STUN destination answered)"
            default: mapping = "unknown"
            }
            return NATReport(server: "\(stunHost):3478", reflexive: first, secondReflexive: second, mapping: mapping,
                             error: first == nil ? "no STUN response from \(stunHost):3478 within \(budget)s" : nil)
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
