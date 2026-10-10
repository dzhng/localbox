import Foundation

public enum HostStatus: String, Codable, Sendable { case firstRun = "first-run", starting, ready, disconnected, paused, resetting }
public struct HostStatusSnapshot: Codable, Equatable, Sendable {
    public var status: HostStatus; public var vmId: String; public var relayConnected: Bool; public var detail: String?; public var updatedAt: Date
    public init(vmId: String = "vm_01") { self.status = .firstRun; self.vmId = vmId; self.relayConnected = false; self.updatedAt = Date() }
}
public actor HostStatusStore {
    public private(set) var snapshot: HostStatusSnapshot
    public init(vmId: String = "vm_01") { self.snapshot = HostStatusSnapshot(vmId: vmId) }
    public func update(_ status: HostStatus, relayConnected: Bool? = nil, detail: String? = nil) { snapshot.status = status; if let relayConnected { snapshot.relayConnected = relayConnected }; snapshot.detail = detail; snapshot.updatedAt = Date() }
}
