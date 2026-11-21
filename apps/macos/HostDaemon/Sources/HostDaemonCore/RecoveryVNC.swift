#if os(macOS)
import Foundation
import Virtualization

/// The only use of private Apple API in Localbox: Virtualization's built-in VNC server (`_VZVNCServer`), which lets an
/// unattended build see and type into a macOS guest's screen. It is used for exactly one screen, Recovery's Terminal,
/// to run `csrutil disable`, which macOS offers no other way to do. A macOS whose private API changed shape answers
/// `unsupported` here rather than crashing the daemon.
public final class RecoveryVNC: @unchecked Sendable {
    private let server: NSObject
    public let port: UInt16
    /// The server listens on every interface, so it takes a one-time password (VNC allows 8 characters).
    public let password: String

    /// Attaches a password-protected VNC server on a free port to a VM created on `queue`.
    public init(virtualMachine: VZVirtualMachine, queue: DispatchQueue) throws {
        guard let serverClass = NSClassFromString("_VZVNCServer") as? NSObject.Type,
              let securityClass = NSClassFromString("_VZVNCAuthenticationSecurityConfiguration") as? NSObject.Type else {
            throw HostDaemonError.unsupported("this macOS has no _VZVNCServer; the macOS image build cannot disable SIP")
        }
        let port = try freeTCPPort()
        password = String((0..<8).map { _ in Array("abcdefghijkmnpqrstuvwxyz23456789").randomElement()! })
        guard let unsecured = securityClass.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() as? NSObject,
              let security = unsecured.perform(NSSelectorFromString("initWithPassword:"), with: password)?.takeRetainedValue() as? NSObject,
              let allocated = serverClass.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() as? NSObject else {
            throw HostDaemonError.unsupported("this macOS's _VZVNCServer did not take a password; the macOS image build cannot disable SIP")
        }
        typealias Initializer = @convention(c) (AnyObject, Selector, UInt16, DispatchQueue, AnyObject) -> Unmanaged<NSObject>
        let selector = NSSelectorFromString("initWithPort:queue:securityConfiguration:")
        guard let method = class_getInstanceMethod(serverClass, selector) else { throw HostDaemonError.unsupported("_VZVNCServer has no initWithPort:queue:securityConfiguration:") }
        let initialize = unsafeBitCast(method_getImplementation(method), to: Initializer.self)
        server = initialize(allocated, selector, port, queue, security).takeRetainedValue()
        self.port = port
        queue.sync {
            server.setValue(virtualMachine, forKey: "virtualMachine")
            server.perform(NSSelectorFromString("start"))
        }
    }

    public func stop() { server.perform(NSSelectorFromString("stop")) }
}

/// A TCP port nothing listens on right now (bind to port 0, read what the kernel chose).
func freeTCPPort() throws -> UInt16 {
    let fd = socket(AF_INET, SOCK_STREAM, 0); defer { close(fd) }
    var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_port = 0; address.sin_addr.s_addr = INADDR_ANY
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let bound = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) == 0 && getsockname(fd, $0, &length) == 0 } }
    guard bound else { throw HostDaemonError.unsupported("no free TCP port for the VNC server") }
    return UInt16(bigEndian: address.sin_port)
}
#endif
