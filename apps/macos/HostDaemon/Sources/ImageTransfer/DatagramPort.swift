import Foundation

/// An IPv4 address (or, for a STUN server, a host name) and a UDP port.
public struct PeerAddress: Hashable, Codable, Sendable, CustomStringConvertible {
    public var host: String
    public var port: UInt16

    public init(_ host: String, _ port: UInt16) { self.host = host; self.port = port }

    public var description: String { "\(host):\(port)" }
}

public struct Datagram {
    public var data: Data
    public var from: PeerAddress
    /// What the port's `open` returned; nil when it isn't set or the datagram failed authentication.
    public var opened: (header: PacketHeader, payload: Data)?

    public init(data: Data, from: PeerAddress) { self.data = data; self.from = from }
}

/// One local datagram port: the layer the transfer protocol runs on. `UDPSocket` is the real one
/// (Network.framework); tests run the same protocol over an in-memory network.
///
/// Delivery contract: `open` runs off the owner's queue for every datagram (AEAD is most of the per-datagram
/// cost); the results arrive in batches on `delivery` through `onDatagrams`, where the owner's state lives.
public protocol DatagramPort: AnyObject {
    var delivery: DispatchQueue { get }
    /// The local port number, as candidates name it.
    var localPort: UInt16 { get }
    var open: ((Data) -> (PacketHeader, Data)?)? { get set }
    var onDatagrams: (([Datagram]) -> Void)? { get set }
    /// Any thread. A datagram the network drops is the protocol's loss to recover, never an error.
    func send(_ datagrams: [Data], to remote: PeerAddress)
    /// Forgets the flow to `remote`, if any.
    func disconnect(_ remote: PeerAddress)
    func close()
    /// Another port on the same host, delivering on the same queue: an extra flow on a local path.
    func sibling() throws -> any DatagramPort
}
