import Foundation
@testable import HostDaemonCore

actor FakeGuestChannel: GuestChannel {
    private let handler: @Sendable (Data) async throws -> Data
    private(set) public var closed = false
    public private(set) var names: [String] = []
    public init(handler: @escaping @Sendable (Data) async throws -> Data) { self.handler = handler }
    public func send(_ envelope: Data) async throws -> Data { guard !closed else { throw HostDaemonError.guestUnavailable }; return try await handler(envelope) }
    public func rename(to name: String) { names.append(name) }
    public func close() { closed = true }
}

/// What fake VMs and their control lanes did, in order, across every backend a factory made.
final class EventLog: @unchecked Sendable {
    private let lock = NSLock(); private var entries: [String] = []
    func append(_ event: String) { lock.lock(); entries.append(event); lock.unlock() }
    var events: [String] { lock.lock(); defer { lock.unlock() }; return entries }
}

/// A control lane that records freeze and thaw; `freezeError` fails every freeze.
actor FakeControlChannel: GuestControlChannel {
    private let log: EventLog; private let freezeError: HostDaemonError?
    init(log: EventLog, freezeError: HostDaemonError?) { self.log = log; self.freezeError = freezeError }
    func freeze(timeoutMs: Int) throws { log.append("freeze \(timeoutMs)"); if let freezeError { throw freezeError } }
    func thaw() { log.append("thaw") }
    func close() { log.append("control closed") }
}

/// A VM that only records its lifecycle; its guest answers with `guest`, and `save` fails with `saveError` when set.
/// Start and restore take `bootDelay`; `stop` fails with `stopError` when set; `die` is the guest powering off.
/// Pause, resume, save and the control lane are written to `log`.
actor FakeSandboxBackend: HibernateBackend, GuestChannelProvider, GuestControlDialer, GuestStopReporting {
    public private(set) var running = false
    private let guest: @Sendable (Data) async throws -> Data
    private let saveError: HostDaemonError?
    private let stopError: HostDaemonError?
    private let bootDelay: UInt64
    private let log: EventLog
    private let freezeError: HostDaemonError?
    private var stopped: (@Sendable (String) -> Void)?
    public init(saveError: HostDaemonError? = nil, stopError: HostDaemonError? = nil, freezeError: HostDaemonError? = nil, bootDelay: UInt64 = 0, log: EventLog = EventLog(), guest: @escaping @Sendable (Data) async throws -> Data = { $0 }) {
        self.saveError = saveError; self.stopError = stopError; self.freezeError = freezeError; self.bootDelay = bootDelay; self.log = log; self.guest = guest
    }
    public func start() async throws { try await Task.sleep(nanoseconds: bootDelay); running = true }
    public func stop() throws { if let stopError { throw stopError }; running = false }
    public func pause() { log.append("pause"); running = false }
    public func resume() { log.append("resume"); running = true }
    public func save(to url: URL) throws {
        if let saveError { throw saveError }
        log.append("save")
        try Data("saved".utf8).write(to: url); running = false
    }
    public func dialControl() -> any GuestControlChannel { FakeControlChannel(log: log, freezeError: freezeError) }
    public func restore(from url: URL) async throws {
        try await Task.sleep(nanoseconds: bootDelay)
        guard FileManager.default.fileExists(atPath: url.path) else { throw HostDaemonError.invalidState("saved machine state is missing") }
        running = true
    }
    public func makeGuestChannel() -> any GuestChannel { FakeGuestChannel(handler: guest) }
    public func onGuestStop(_ handler: @escaping @Sendable (String) -> Void) { stopped = handler }
    public func die(_ reason: String) { running = false; stopped?(reason) }
}

/// Makes `FakeSandboxBackend`s; `boots` counts the backends made, one per boot or restore, and `made` holds them.
final class FakeBackendFactory: SandboxBackendFactory, @unchecked Sendable {
    private let lock = NSLock()
    private var backends: [FakeSandboxBackend] = []
    private let saveError: HostDaemonError?
    private let stopError: HostDaemonError?
    private let freezeError: HostDaemonError?
    private let bootDelay: UInt64
    private let guest: @Sendable (Data) async throws -> Data
    let log: EventLog
    /// `saveError`: every save fails with it, e.g. `.screenLocked` or `.unsupported("permission denied")`; `stopError`
    /// likewise for every stop, `freezeError` for every freeze on the control lane. `bootDelay` (nanoseconds) is how
    /// long each start or restore takes. Every backend writes to `log`.
    public init(saveError: HostDaemonError? = nil, stopError: HostDaemonError? = nil, freezeError: HostDaemonError? = nil, bootDelay: UInt64 = 0, log: EventLog = EventLog(), guest: @escaping @Sendable (Data) async throws -> Data = { $0 }) {
        self.saveError = saveError; self.stopError = stopError; self.freezeError = freezeError; self.bootDelay = bootDelay; self.log = log; self.guest = guest
    }
    public var boots: Int { made.count }
    public var made: [FakeSandboxBackend] { lock.lock(); defer { lock.unlock() }; return backends }
    public func provision(_ record: inout SandboxRecord, in directory: SandboxDirectory) throws -> [String: String] { record.mac = randomLocalMAC(); return [:] }
    public func backend(for record: SandboxRecord, in directory: SandboxDirectory) throws -> any SandboxBackend {
        let backend = FakeSandboxBackend(saveError: saveError, stopError: stopError, freezeError: freezeError, bootDelay: bootDelay, log: log, guest: guest)
        lock.lock(); backends.append(backend); lock.unlock()
        return backend
    }
}
