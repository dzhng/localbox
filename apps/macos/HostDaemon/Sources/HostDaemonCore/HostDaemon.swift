import Foundation

public enum DaemonLifecycle: String, Codable, Sendable {
    case firstRun = "first-run"
    case starting
    case ready
    case disconnected
    case paused
    case stopping
    case stopped
    case resetting
    case error
}

public struct DaemonStatus: Codable, Equatable, Sendable {
    public let lifecycle: DaemonLifecycle
    public let vmID: String
    public let channelEpoch: Int
    public let relayConnected: Bool
    public let detail: String?
    public init(lifecycle: DaemonLifecycle, vmID: String, channelEpoch: Int = 0, relayConnected: Bool = false, detail: String? = nil) {
        self.lifecycle = lifecycle; self.vmID = vmID; self.channelEpoch = channelEpoch; self.relayConnected = relayConnected; self.detail = detail
    }
}

public protocol GuestChannel: Sendable {
    func send(_ envelope: Data) async throws -> Data
    func close() async
}

public protocol VMBackend: Sendable {
    func start() async throws
    func stop() async throws
    func pause() async throws
    func resume() async throws
    func reset() async throws
}

public enum HostDaemonError: Error, CustomStringConvertible, Sendable {
    case invalidState(String)
    case unsupported(String)
    case guestUnavailable
    public var description: String {
        switch self { case .invalidState(let message), .unsupported(let message): return message; case .guestUnavailable: return "guest channel is unavailable" }
    }
}

/// The single owner of VM lifecycle, guest-channel epoch, and readiness.
public actor HostDaemon {
    private let backend: any VMBackend
    private var channel: (any GuestChannel)?
    private var statusValue: DaemonStatus
    public init(vmID: String = "vm_01", backend: any VMBackend) {
        self.backend = backend
        self.statusValue = DaemonStatus(lifecycle: .firstRun, vmID: vmID)
    }
    public func status() -> DaemonStatus { statusValue }
    public func attach(channel: any GuestChannel) {
        self.channel = channel
        statusValue = DaemonStatus(lifecycle: .ready, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch + 1, relayConnected: statusValue.relayConnected)
    }
    public func markRelay(connected: Bool) { statusValue = DaemonStatus(lifecycle: statusValue.lifecycle, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch, relayConnected: connected, detail: statusValue.detail) }
    public func start() async throws {
        guard statusValue.lifecycle == .firstRun || statusValue.lifecycle == .stopped || statusValue.lifecycle == .paused else { throw HostDaemonError.invalidState("VM cannot start from \(statusValue.lifecycle.rawValue)") }
        statusValue = DaemonStatus(lifecycle: .starting, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch, relayConnected: statusValue.relayConnected)
        do { try await backend.start(); statusValue = DaemonStatus(lifecycle: .ready, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch + 1, relayConnected: statusValue.relayConnected) }
        catch { statusValue = DaemonStatus(lifecycle: .error, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch, relayConnected: false, detail: String(describing: error)); throw error }
    }
    public func pause() async throws { guard statusValue.lifecycle == .ready else { throw HostDaemonError.invalidState("VM is not ready") }; try await backend.pause(); statusValue = DaemonStatus(lifecycle: .paused, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch, relayConnected: false) }
    public func resume() async throws { guard statusValue.lifecycle == .paused else { throw HostDaemonError.invalidState("VM is not paused") }; try await backend.resume(); statusValue = DaemonStatus(lifecycle: .ready, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch + 1, relayConnected: statusValue.relayConnected) }
    public func stop() async throws { guard statusValue.lifecycle != .stopped else { return }; statusValue = DaemonStatus(lifecycle: .stopping, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch, relayConnected: false); await channel?.close(); try await backend.stop(); channel = nil; statusValue = DaemonStatus(lifecycle: .stopped, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch + 1) }
    public func reset(confirm: String) async throws { guard confirm == "RESET" else { throw HostDaemonError.invalidState("reset requires confirmation RESET") }; statusValue = DaemonStatus(lifecycle: .resetting, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch, relayConnected: false); await channel?.close(); try await backend.reset(); channel = nil; statusValue = DaemonStatus(lifecycle: .stopped, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch + 1) }
    public func request(_ envelope: Data) async throws -> Data { guard statusValue.lifecycle == .ready, let channel else { throw HostDaemonError.guestUnavailable }; return try await channel.send(envelope) }
}

public actor FakeGuestChannel: GuestChannel {
    private let handler: @Sendable (Data) async throws -> Data
    private(set) public var closed = false
    public init(handler: @escaping @Sendable (Data) async throws -> Data) { self.handler = handler }
    public func send(_ envelope: Data) async throws -> Data { guard !closed else { throw HostDaemonError.guestUnavailable }; return try await handler(envelope) }
    public func close() { closed = true }
}

public actor FakeVMBackend: VMBackend {
    public private(set) var running = false
    public init() {}
    public func start() { running = true }
    public func stop() { running = false }
    public func pause() { running = false }
    public func resume() { running = true }
    public func reset() { running = false }
}
