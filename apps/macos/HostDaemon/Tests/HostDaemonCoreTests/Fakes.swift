import Foundation
@testable import HostDaemonCore

actor FakeGuestChannel: GuestChannel, GuestAgentReporting {
    private let handler: @Sendable (Data) async throws -> Data
    private let agent: GuestAgentIdentity?
    private(set) public var closed = false
    public private(set) var names: [String] = []
    public init(agent: GuestAgentIdentity? = nil, handler: @escaping @Sendable (Data) async throws -> Data) { self.agent = agent; self.handler = handler }
    public func agentIdentity() -> GuestAgentIdentity? { agent }
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

/// The guest agent of every fake VM a factory makes: the build it announces (nil announces none, so nothing is ever
/// pushed to it), and how an update of it goes.
final class FakeAgent: @unchecked Sendable {
    private let lock = NSLock()
    private var installed: String?
    let os: String
    /// Fails every push (the guest refused it); `reconnectError` fails the request lane's re-dial after one.
    let updateError: HostDaemonError?, reconnectError: HostDaemonError?
    init(version: String? = nil, os: String = "linux", updateError: HostDaemonError? = nil, reconnectError: HostDaemonError? = nil) {
        installed = version; self.os = os; self.updateError = updateError; self.reconnectError = reconnectError
    }
    var identity: GuestAgentIdentity? { lock.lock(); defer { lock.unlock() }; return installed.map { GuestAgentIdentity(version: $0, os: os) } }
    func install(_ version: String) { lock.lock(); installed = version; lock.unlock() }
}

/// A control lane that records freeze, thaw and agent pushes; `freezeError` fails every freeze. A push installs the
/// version and calls `exited`, as the guest's old agent ends.
actor FakeControlChannel: GuestControlChannel {
    private let log: EventLog; private let freezeError: HostDaemonError?; private let agent: FakeAgent; private let exited: @Sendable () async -> Void
    init(log: EventLog, freezeError: HostDaemonError?, agent: FakeAgent, exited: @escaping @Sendable () async -> Void) { self.log = log; self.freezeError = freezeError; self.agent = agent; self.exited = exited }
    func freeze(timeoutMs: Int) throws { log.append("freeze \(timeoutMs)"); if let freezeError { throw freezeError } }
    func thaw() { log.append("thaw") }
    func updateAgent(_ binary: AgentBinary) async throws -> AgentUpdateOutcome {
        log.append("update \(binary.version) \(binary.size) bytes")
        if let error = agent.updateError { throw error }
        agent.install(binary.version); await exited()
        return .updated
    }
    func close() { log.append("control closed") }
}

/// A VM that only records its lifecycle; its guest answers with `guest`, and `save` fails with `saveError` when set.
/// Start and restore take `bootDelay`; `stop` fails with `stopError` when set; `die` is the guest powering off.
/// Pause, resume, save and the control lane are written to `log`.
actor FakeSandboxBackend: HibernateBackend, GuestChannelProvider, GuestControlDialer, GuestReconnecting, GuestStopReporting {
    public private(set) var running = false
    private let guest: @Sendable (Data) async throws -> Data
    private let saveError: HostDaemonError?
    private let stopError: HostDaemonError?
    private let bootDelay: UInt64
    private let log: EventLog
    private let freezeError: HostDaemonError?
    private let agent: FakeAgent
    private var channel: FakeGuestChannel?
    private var stopped: (@Sendable (String) -> Void)?
    public init(saveError: HostDaemonError? = nil, stopError: HostDaemonError? = nil, freezeError: HostDaemonError? = nil, bootDelay: UInt64 = 0, log: EventLog = EventLog(), agent: FakeAgent = FakeAgent(), guest: @escaping @Sendable (Data) async throws -> Data = { $0 }) {
        self.saveError = saveError; self.stopError = stopError; self.freezeError = freezeError; self.bootDelay = bootDelay; self.log = log; self.agent = agent; self.guest = guest
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
    public func dialControl() -> any GuestControlChannel { FakeControlChannel(log: log, freezeError: freezeError, agent: agent, exited: { await self.agentExited() }) }
    /// The old agent is gone, and with it every connection to it.
    private func agentExited() async { await channel?.close() }
    public func reconnectGuest(name: String) throws -> any GuestChannel {
        log.append("reconnect")
        if let error = agent.reconnectError { throw error }
        return makeGuestChannel()
    }
    public func restore(from url: URL) async throws {
        try await Task.sleep(nanoseconds: bootDelay)
        guard FileManager.default.fileExists(atPath: url.path) else { throw HostDaemonError.invalidState("saved machine state is missing") }
        running = true
    }
    public func makeGuestChannel() -> any GuestChannel { let made = FakeGuestChannel(agent: agent.identity, handler: guest); channel = made; return made }
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
    let agent: FakeAgent
    /// `saveError`: every save fails with it, e.g. `.screenLocked` or `.unsupported("permission denied")`; `stopError`
    /// likewise for every stop, `freezeError` for every freeze on the control lane. `bootDelay` (nanoseconds) is how
    /// long each start or restore takes. Every backend writes to `log` and runs `agent`.
    public init(saveError: HostDaemonError? = nil, stopError: HostDaemonError? = nil, freezeError: HostDaemonError? = nil, bootDelay: UInt64 = 0, log: EventLog = EventLog(), agent: FakeAgent = FakeAgent(), guest: @escaping @Sendable (Data) async throws -> Data = { $0 }) {
        self.saveError = saveError; self.stopError = stopError; self.freezeError = freezeError; self.bootDelay = bootDelay; self.log = log; self.agent = agent; self.guest = guest
    }
    public var boots: Int { made.count }
    public var made: [FakeSandboxBackend] { lock.lock(); defer { lock.unlock() }; return backends }
    public func provision(_ record: inout SandboxRecord, in directory: SandboxDirectory) throws -> [String: String] { record.mac = randomLocalMAC(); return [:] }
    public func backend(for record: SandboxRecord, in directory: SandboxDirectory) throws -> any SandboxBackend {
        let backend = FakeSandboxBackend(saveError: saveError, stopError: stopError, freezeError: freezeError, bootDelay: bootDelay, log: log, agent: agent, guest: guest)
        lock.lock(); backends.append(backend); lock.unlock()
        return backend
    }
}
