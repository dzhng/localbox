import XCTest
@testable import HostDaemonCore

// What every HostDaemonCore test shares: fakes for VMs, guests and the macOS build, scratch directories, request
// envelopes, and a daemon wired as `localbox-hostd` wires one.

let gib: UInt64 = 1024 * 1024 * 1024

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
final class EventLog: Sendable {
    private let entries = Locked<[String]>([])
    func append(_ event: String) { entries.withLock { $0.append(event) } }
    var events: [String] { entries.value }
}

/// The guest agent of every fake VM a factory makes: the build it announces (nil announces none, so nothing is ever
/// pushed to it), and how an update of it goes.
final class FakeAgent: Sendable {
    private let installed: Locked<String?>
    let os: String
    /// Fails every push (the guest refused it); `reconnectError` fails the request lane's re-dial after one.
    let updateError: HostDaemonError?, reconnectError: HostDaemonError?
    init(version: String? = nil, os: String = "linux", updateError: HostDaemonError? = nil, reconnectError: HostDaemonError? = nil) {
        installed = Locked(version); self.os = os; self.updateError = updateError; self.reconnectError = reconnectError
    }
    var identity: GuestAgentIdentity? { installed.value.map { GuestAgentIdentity(version: $0, os: os) } }
    func install(_ version: String) { installed.value = version }
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
    private let backends = Locked<[FakeSandboxBackend]>([])
    private let saveError: HostDaemonError?
    private let stopError: HostDaemonError?
    private let freezeError: HostDaemonError?
    private let bootDelay: UInt64
    private let guest: @Sendable (Data) async throws -> Data
    let log: EventLog
    let agent: FakeAgent
    private let images: Set<String>
    /// Every image's disk size; each sandbox's disk starts at it.
    let imageDiskBytes: UInt64 = 8 * gib
    /// Each sandbox's disk size as its last grow left it.
    private let disks = Locked<[String: UInt64]>([:])
    /// `saveError`: every save fails with it, e.g. `.screenLocked` or `.unsupported("permission denied")`; `stopError`
    /// likewise for every stop, `freezeError` for every freeze on the control lane. `bootDelay` (nanoseconds) is how
    /// long each start or restore takes. `images` are the images this Mac holds; provisioning from any other fails as
    /// `ImageStore` does. Every backend writes to `log` and runs `agent`; each disk grow is logged as `grow disk BYTES`.
    public init(saveError: HostDaemonError? = nil, stopError: HostDaemonError? = nil, freezeError: HostDaemonError? = nil, bootDelay: UInt64 = 0, images: Set<String> = [builtInImage],
                log: EventLog = EventLog(), agent: FakeAgent = FakeAgent(), guest: @escaping @Sendable (Data) async throws -> Data = { $0 }) {
        self.saveError = saveError; self.stopError = stopError; self.freezeError = freezeError; self.bootDelay = bootDelay; self.images = images; self.log = log; self.agent = agent; self.guest = guest
    }
    public var boots: Int { made.count }
    public var made: [FakeSandboxBackend] { backends.value }
    public func provision(_ record: inout SandboxRecord, in directory: SandboxDirectory) throws -> [String: String] {
        guard images.contains(record.imageID) else { throw ImageNotHere(imageID: record.imageID) }
        record.diskBytes = try DiskGrowth.sandboxSize(requested: record.diskBytes == 0 ? nil : record.diskBytes, image: record.imageID, imageBytes: imageDiskBytes)
        let id = record.sandboxID, disk = imageDiskBytes
        disks.withLock { $0[id] = disk }
        // Fixture convention: an image whose id starts with "macos" is a macOS image, as its manifest would say.
        if record.imageID.hasPrefix("macos") { record.os = .macos }
        record.mac = randomLocalMAC(); return [:]
    }
    public func growDisk(_ record: SandboxRecord, in directory: SandboxDirectory) throws -> Bool {
        let grew = disks.withLock { disks -> Bool in
            guard record.diskBytes > disks[record.sandboxID] ?? record.diskBytes else { return false }
            disks[record.sandboxID] = record.diskBytes; return true
        }
        if grew { log.append("grow disk \(record.diskBytes)") }
        return grew
    }
    public func backend(for record: SandboxRecord, in directory: SandboxDirectory) throws -> any SandboxBackend {
        let backend = FakeSandboxBackend(saveError: saveError, stopError: stopError, freezeError: freezeError, bootDelay: bootDelay, log: log, agent: agent, guest: guest)
        backends.withLock { $0.append(backend) }
        return backend
    }
}

// MARK: - Scratch directories and waits

extension XCTestCase {
    /// A new directory, removed when the test ends.
    func scratch() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lb-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    /// Returns once `condition` holds, polling for about five seconds; fails the test if it never does.
    func until(_ condition: @escaping () async throws -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<500 { if try await condition() { return }; try await Task.sleep(nanoseconds: 10_000_000) }
        XCTFail("condition never held", file: file, line: line)
    }

    /// A `SandboxHost` over `sandboxesDirectory` with a scratch journal and image store of its own, for tests
    /// of sandboxes alone (no operation kinds registered; `TestDaemon` wires everything).
    func sandboxHost(sandboxesDirectory: URL, factory: any SandboxBackendFactory, hostCPUs: Int? = nil, hostMemoryBytes: UInt64? = nil, admissionBytes: UInt64? = nil, allowsSimulatedPower: Bool = false,
                     agentSetup: AgentSetupCLI? = nil, agentUpdater: GuestAgentUpdater? = nil, freeDiskBytes: (@Sendable () -> UInt64)? = nil, store: ImageStore? = nil, builtinImage: BuiltinImageWait? = nil,
                     idleSleep: any IdleSleepPrevention = NoIdleSleepPrevention(), now: @escaping @Sendable () -> Date = { Date() }) throws -> SandboxHost {
        let root = try scratch()
        let operations = try HostOperationStore(operationsDirectory: root.appendingPathComponent("operations"))
        let store = try store ?? ImageStore(imagesDirectory: root.appendingPathComponent("images"), freeBytesOverride: freeDiskBytes)
        return SandboxHost(sandboxesDirectory: sandboxesDirectory, factory: factory, operations: operations, store: store, hostCPUs: hostCPUs, hostMemoryBytes: hostMemoryBytes, admissionBytes: admissionBytes,
                           allowsSimulatedPower: allowsSimulatedPower, agentSetup: agentSetup, agentUpdater: agentUpdater, builtinImage: builtinImage, idleSleep: idleSleep, now: now)
    }
}

/// Holds every waiter until opened.
actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() { isOpen = true; for waiter in waiters { waiter.resume() }; waiters = [] }
}

// MARK: - Requests

/// What answers request envelopes: the daemon's router and each of its owners.
protocol RequestHandling: Sendable { func request(_ envelope: Data) async throws -> Data }
extension SandboxHost: RequestHandling {}
extension ImageHost: RequestHandling {}
extension HostDaemon: RequestHandling {}

/// A request as the relay sends one, `input` as JSON text.
func envelope(_ operation: String, _ input: String = "{}", mutation: String? = nil, sandboxID: String? = "sandbox_1", deadlineMs: Int = 60_000) -> Data {
    Data(#"{"protocol_version":"v1","request_id":"\#(operation)-1","operation":"\#(operation)","sandbox_id":\#(sandboxID.map { "\"\($0)\"" } ?? "null"),"deadline_ms":\#(deadlineMs),"mutation_id":\#(mutation.map { "\"\($0)\"" } ?? "null"),"input":\#(input)}"#.utf8)
}

/// A request as the relay or the connector sends one, `input` as an object.
func envelope(_ operation: String, _ input: [String: Any], mutation: String? = nil, sandboxID: String? = nil, deadlineMs: Int = 30_000) -> Data {
    try! JSONSerialization.data(withJSONObject: ["protocol_version": protocolVersion, "request_id": "r-\(UUID().uuidString)", "operation": operation, "sandbox_id": sandboxID as Any? ?? NSNull(),
                                                 "deadline_ms": deadlineMs, "mutation_id": mutation as Any? ?? NSNull(), "input": input] as [String: Any])
}

/// The whole answer envelope.
func call(_ handler: some RequestHandling, _ request: Data) async throws -> [String: Any] {
    let answer = try await handler.request(request)
    return try XCTUnwrap(try JSONSerialization.jsonObject(with: answer) as? [String: Any])
}

/// The result of a request that must succeed.
func result(_ handler: some RequestHandling, _ operation: String, _ input: String = "{}", sandboxID: String? = nil, file: StaticString = #filePath, line: UInt = #line) async throws -> [String: Any] {
    let response = try await call(handler, envelope(operation, input, sandboxID: sandboxID))
    XCTAssertEqual(response["ok"] as? Bool, true, "\(operation): \(response)", file: file, line: line)
    return response["result"] as? [String: Any] ?? [:]
}

func result(_ handler: some RequestHandling, _ operation: String, _ input: [String: Any], sandboxID: String? = nil, mutation: String? = nil, deadlineMs: Int = 30_000, file: StaticString = #filePath, line: UInt = #line) async throws -> [String: Any] {
    let response = try await call(handler, envelope(operation, input, mutation: mutation, sandboxID: sandboxID, deadlineMs: deadlineMs))
    return try XCTUnwrap(response["result"] as? [String: Any], "\(operation): \(response)", file: file, line: line)
}

/// The error of a request that must fail.
func failure(_ handler: some RequestHandling, _ operation: String, _ input: [String: Any], sandboxID: String? = nil, mutation: String? = nil, file: StaticString = #filePath, line: UInt = #line) async throws -> [String: Any] {
    let response = try await call(handler, envelope(operation, input, mutation: mutation, sandboxID: sandboxID))
    return try XCTUnwrap(response["error"] as? [String: Any], "\(operation): \(response)", file: file, line: line)
}

/// The kinds of a report's actions, in order.
func kinds(_ report: [String: Any]) -> [String] { (report["actions"] as? [[String: Any]])?.compactMap { $0["kind"] as? String } ?? [] }

/// A guest that answers `guest.activity` with `jobs(sandboxID)` running jobs and everything else with its operation,
/// writing each request it gets to `log`.
func answeringGuest(log: EventLog? = nil, jobs: @escaping @Sendable (String) -> Int = { _ in 0 }) -> @Sendable (Data) async throws -> Data {
    { request in
        let object = try JSONSerialization.jsonObject(with: request) as? [String: Any]
        let operation = object?["operation"] as? String ?? ""
        log?.append("request \(operation)")
        let result: [String: Any] = operation == "guest.activity" ? ["running_jobs": jobs(object?["sandbox_id"] as? String ?? "")] : ["operation": operation]
        return try JSONSerialization.data(withJSONObject: ["ok": true, "result": result])
    }
}

// MARK: - A daemon

/// One daemon under `root` (`operations/`, `images/`, `sandboxes/`), wired by `HostDaemon` exactly as `localbox-hostd`
/// wires one, with fake VMs, a fake macOS build driver and Apple catalog, a fixed free disk (1 TiB unless the test says),
/// and a copy transport the test picks. A second
/// `TestDaemon` over the same root is that daemon restarted; nothing starts until the test calls `operations.start()`.
struct TestDaemon {
    let root: URL, store: ImageStore, operations: HostOperationStore, daemon: HostDaemon
    var host: SandboxHost { daemon.sandboxes }
    var images: ImageHost { daemon.images }

    init(root: URL, factory: any SandboxBackendFactory = FakeBackendFactory(), freeBytes: UInt64 = 1 << 40, hostCPUs: Int = 4, hostMemoryBytes: UInt64 = 8 * gib,
         transport: any ImageCopyTransport = UnreachableTransport(tried: []), copyPeerWaitMs: Int = 10_000, macDriver: (any MacBuildDriver)? = nil, catalog: any IPSWCatalog = FakeCatalog(), http: any RangedHTTP = FakeHTTP(),
         guestAgent: URL? = nil, hostVersion: String = "27.0.1", dev: Bool = false, idleSleep: any IdleSleepPrevention = NoIdleSleepPrevention()) async throws {
        self.root = root
        operations = try HostOperationStore(operationsDirectory: root.appendingPathComponent("operations"))
        store = try ImageStore(imagesDirectory: root.appendingPathComponent("images"), freeBytesOverride: { freeBytes })
        store.sweepTemps(keeping: await operations.runningSubjects())
        let host = SandboxHost(sandboxesDirectory: root.appendingPathComponent("sandboxes"), factory: factory, operations: operations, store: store, hostCPUs: hostCPUs, hostMemoryBytes: hostMemoryBytes, idleSleep: idleSleep)
        let builder = MacBaseBuilder(store: store, operations: operations, sandboxes: host, driver: macDriver ?? FakeMacDriver(journals: root.appendingPathComponent("operations")), catalog: catalog, http: http, guestAgent: guestAgent, hostVersion: { hostVersion })
        daemon = await HostDaemon(sandboxes: host, macBuilder: builder, transport: transport, copyPeerWaitMs: copyPeerWaitMs, dev: dev)
    }
}

extension ImageStore {
    /// A committed linux image with a random disk of `bytes`, marked listed by `listedBy` when given; returns the disk.
    @discardableResult func plant(_ id: String, bytes: Int = 1024, listedBy: String? = nil) throws -> Data {
        let temp = try reserveTemp(id)
        try FileManager.default.createDirectory(at: temp.appendingPathComponent("boot"), withIntermediateDirectories: true)
        let disk = Data((0..<bytes).map { _ in UInt8.random(in: 0...255) })
        try disk.write(to: temp.appendingPathComponent("disk.img"))
        try Data("efi".utf8).write(to: temp.appendingPathComponent("boot/efi-vars"))
        _ = try seal(temp, imageID: id, os: .linux, diskBytes: UInt64(bytes), hardwareModel: nil, minMacOS: nil, agentVersion: "test")
        try commit(temp, as: id)
        if let listedBy { try markListed(id, by: listedBy) }
        return disk
    }
}

/// A transport that finds no path, as `PathSelector` reports it.
struct UnreachableTransport: ImageCopyTransport {
    let tried: [ImageCopyAttempt]
    func send(_ image: ImageCopySource, key: Data, rendezvous: any ImageCopyRendezvous) async throws -> ImageCopyReport { throw ImageCopyUnreachable(tried: tried) }
    func receive(into temp: URL, key: Data, rendezvous: any ImageCopyRendezvous, progress: @escaping ImageCopyProgress) async throws -> ImageCopyReport { throw ImageCopyUnreachable(tried: tried) }
}

// MARK: - The macOS build's fakes

let fakeIPSW = IPSWRelease(url: URL(string: "https://updates.example.com/UniversalMac_27.2.1_26B131_Restore.ipsw")!, version: "27.2.1", build: "26B131", sizeBytes: 4096)

/// Apple's catalog; `fails` makes it answer as its service does when it errors.
final class FakeCatalog: IPSWCatalog, @unchecked Sendable {
    private let failing = Locked(false)
    var fails: Bool { get { failing.value } set { failing.value = newValue } }
    func latest() async throws -> IPSWRelease {
        if fails { throw HostDaemonError.unsupported("The restore image catalog failed to load.") }
        return fakeIPSW
    }
}

/// Serves `body` by range; `failAfter` drops the connection once that many bytes of the file exist.
final class FakeHTTP: RangedHTTP, @unchecked Sendable {
    static let body = Data((0..<4096).map { UInt8(truncatingIfNeeded: $0 &* 7) })
    private let state: Locked<(failAfter: Int?, offsets: [UInt64])>
    var failAfter: Int? { get { state.value.failAfter } set { state.withLock { $0.failAfter = newValue } } }
    var offsets: [UInt64] { state.value.offsets }
    init(failAfter: Int? = nil) { state = Locked((failAfter, [])) }

    func length(of url: URL) async throws -> UInt64 { UInt64(Self.body.count) }
    func fetch(_ url: URL, from offset: UInt64, appendingTo file: FileHandle, progress: @escaping @Sendable (UInt64) -> Void) async throws {
        state.withLock { $0.offsets.append(offset) }
        let end = failAfter.map { min($0, Self.body.count) } ?? Self.body.count
        try file.write(contentsOf: Self.body.subdata(in: Int(offset)..<max(Int(offset), end)))
        progress(UInt64(end) - offset)
        if end < Self.body.count { throw URLError(.networkConnectionLost) }
    }
}

/// Guests made of files. Records each step, the phase journaled (on disk, under `journals`) when it ran, every password
/// it was handed, every journal write it could see, and the disk a provisioning boot started from.
final class FakeMacDriver: MacBuildDriver, @unchecked Sendable {
    struct Seen { var calls: [String] = [], phases: [String] = [], passwords: [String] = [], journals: [String] = [], scripts: [String] = []; var payload: URL?, provisionedDisk: Data?, failing: String?; var unclaimed = true; var installedDiskBytes: UInt64? }
    let journals: URL
    /// Holds `install` until opened, so a test can look at a build whose VM runs.
    let installGate: Gate?
    private let seen = Locked(Seen())
    /// A step that throws, as a guest step that exits non-zero would.
    var failing: String? { get { seen.value.failing } set { seen.withLock { $0.failing = newValue } } }
    var calls: [String] { seen.value.calls }
    var phasesSeen: [String] { seen.value.phases }
    var passwords: [String] { seen.value.passwords }
    var journalsSeen: [String] { seen.value.journals }
    var scripts: [String] { seen.value.scripts }
    var payload: URL? { seen.value.payload }
    var provisionedDisk: Data? { seen.value.provisionedDisk }
    init(journals: URL, installGate: Gate? = nil) { self.journals = journals; self.installGate = installGate }

    static func writeInstalled(_ build: MacBuildDirectory) throws {
        try Data("installed".utf8).write(to: build.installedDisk)
        try Data("aux".utf8).write(to: build.installedAux)
        try Data("model".utf8).write(to: build.hardwareModel)
        try Data("identifier".utf8).write(to: build.machineIdentifier)
        try Data("02:00:00:00:00:02".utf8).write(to: build.mac)
    }

    /// Records step `name` of the build in `build`, with the phase its operation last journaled.
    func step(_ name: String, _ build: MacBuildDirectory, script: String? = nil, payload: URL? = nil) throws {
        let subject = String(build.root.lastPathComponent.dropFirst().dropLast(".build".count))
        let written = (try? FileManager.default.contentsOfDirectory(at: journals, includingPropertiesForKeys: nil))?.compactMap { try? Data(contentsOf: $0) } ?? []
        let records = written.compactMap { try? JSONDecoder().decode(HostOperationRecord.self, from: $0) }
        let phase = records.filter { $0.subject == subject }.max { $0.startedAt < $1.startedAt }?.progress?.phase ?? ""
        let failing = seen.withLock { seen -> String? in
            seen.calls.append(name); seen.phases.append(phase); seen.journals.append(contentsOf: written.map { String(decoding: $0, as: UTF8.self) })
            if let script { seen.scripts.append(script) }
            if let payload { seen.payload = payload }
            return seen.failing
        }
        if name == failing { throw HostDaemonError.unsupported("a build step in the guest exited 56") }
    }

    /// The disk size the last install was asked for.
    var installedDiskBytes: UInt64? { seen.value.installedDiskBytes }

    func install(ipsw: URL, into build: MacBuildDirectory, diskBytes: UInt64, progress: @escaping @Sendable (Double) -> Void) async throws {
        XCTAssertEqual(try Data(contentsOf: ipsw), FakeHTTP.body, "installs the cached IPSW")
        seen.withLock { $0.installedDiskBytes = diskBytes }
        try Self.writeInstalled(build)
        try step("install", build)
        await installGate?.wait()
    }

    func provision(_ build: MacBuildDirectory, user: MacProvisioningUser) async throws -> any MacProvisionedGuest {
        seen.withLock { $0.passwords.append(user.password); $0.provisionedDisk = try? Data(contentsOf: build.disk) }
        try step("provision", build)
        return FakeMacGuest(driver: self, build: build)
    }

    /// The work copy has space its container does not reach yet: true until a guest claims it.
    var unclaimed: Bool { get { seen.value.unclaimed } set { seen.withLock { $0.unclaimed = newValue } } }

    func freeRecoverySpace(_ build: MacBuildDirectory) throws -> Bool {
        try step("free recovery space", build)
        return unclaimed
    }

    func boot(_ build: MacBuildDirectory) async throws -> any MacAgentGuest {
        try step("boot", build)
        return FakeMacGuest(driver: self, build: build, throughAgent: true)
    }
}

struct FakeMacGuest: MacProvisionedGuest, MacAgentGuest {
    let driver: FakeMacDriver, build: MacBuildDirectory
    /// Booted normally, so its steps go through the agent's request lane, which refuses deadlines over 120 s.
    var throughAgent = false
    func root(_ script: String, timeout: TimeInterval) async throws -> String {
        if throughAgent { XCTAssertLessThanOrEqual(timeout, 120, "a step through the agent must fit its 120 s request deadline") }
        let name = script.contains("install.sh") ? "bootstrap" : script.contains("--grant-tcc") ? "tcc" : script.contains("openssh") ? "finish" : "other"
        try driver.step("root \(name)", build, script: script)
        return name == "finish" ? "142.0.7444.60\n" : ""
    }
    func upload(_ local: URL, to remote: String) async throws {
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("lb-payload-\(UUID().uuidString).tgz")
        try FileManager.default.copyItem(at: local, to: copy)
        try driver.step("upload \(remote)", build, payload: copy)
    }
    func claimDisk() async throws { try driver.step("claim disk", build); driver.unclaimed = false }
    func shutDown() async throws { try driver.step("shut down", build) }
    func disableSIP(as user: MacProvisioningUser) async throws { try driver.step("disable SIP", build) }
    func abandon() async {}
}
