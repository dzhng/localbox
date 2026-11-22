import Foundation

public enum RuntimeLifecycle: String, Codable, Sendable {
    case starting
    case ready
    /// Asleep in memory: a VM paused, or a process fixture stopped with SIGSTOP.
    case paused
    /// Asleep and down: a saved state to restore, or a cold boot owed, at the next use.
    case asleep
    /// Running, with its filesystem frozen and the VM paused for a disk clone (`SandboxRuntime.freezeAndClone`).
    /// Requests wait for it, and admission and the idle policy pass it by.
    case freezing
    case stopping
    case stopped
    case error

    /// The runtime state reported for the sandbox.
    var sandboxState: String {
        switch self {
        case .ready, .freezing: return "running"
        case .paused, .asleep: return "sleeping"
        default: return rawValue
        }
    }

    /// What the record keeps, so a daemon restart knows what to bring back; transitions are not kept, and an asleep
    /// sandbox's record says itself whether it comes back at start (`hibernated`) or waits (`asleep`).
    var saved: SavedLifecycle? {
        switch self {
        case .ready: return .running
        case .paused: return .sleeping
        case .stopped, .error: return .stopped
        case .starting, .stopping, .asleep, .freezing: return nil
        }
    }
}

public struct RuntimeStatus: Codable, Equatable, Sendable {
    public let lifecycle: RuntimeLifecycle
    public let channelEpoch: Int
    public let detail: String?
    public init(lifecycle: RuntimeLifecycle, channelEpoch: Int = 0, detail: String? = nil) {
        self.lifecycle = lifecycle; self.channelEpoch = channelEpoch; self.detail = detail
    }
}

public protocol GuestChannel: Sendable {
    func send(_ envelope: Data) async throws -> Data
    /// Re-introduces the sandbox under a new name (a new hello), so a running guest changes its hostname.
    func rename(to name: String) async throws
    func close() async
}

public protocol SandboxBackend: Sendable {
    func start() async throws
    func stop() async throws
    func pause() async throws
    func resume() async throws
}

/// A backend that can persist and restore a running VM without reprovisioning it.
public protocol HibernateBackend: SandboxBackend {
    func save(to url: URL) async throws
    func restore(from url: URL) async throws
}

/// Backends that expose the guest's ordered byte stream use this hook to attach it to the runtime after a start.
public protocol GuestChannelProvider: Sendable {
    func makeGuestChannel() async throws -> any GuestChannel
}

public protocol GuestReadinessProvider: Sendable {
    func waitUntilReady() async throws
}

/// Backends that notice their guest stopping on its own (an in-guest poweroff, a kernel panic) say why through
/// `handler`, so the runtime stops reporting a dead sandbox as running.
public protocol GuestStopReporting: Sendable {
    func onGuestStop(_ handler: @escaping @Sendable (String) -> Void) async
}

/// One line for a report: our own errors say what they mean; Virtualization's NSErrors carry a localized sentence.
func explain(_ error: Error) -> String { (error as? HostDaemonError)?.description ?? error.localizedDescription }

public enum HostDaemonError: Error, CustomStringConvertible, Sendable {
    case invalidState(String)
    case unsupported(String)
    case guestUnavailable
    /// A lane's answer missed its deadline, so the lane was closed: the guest (or its agent) is wedged.
    case guestUnresponsive(String)
    /// The VM service keeps the saved-state key in the keychain, which refuses while the console is locked.
    case screenLocked
    public var description: String {
        switch self {
        case .invalidState(let message), .unsupported(let message), .guestUnresponsive(let message): return message
        case .guestUnavailable: return "guest channel is unavailable"
        case .screenLocked: return "hibernate unavailable while the screen is locked"
        }
    }
}

/// The admission knob: running sandboxes may reserve this share of the host's RAM; the rest is the host's.
public let admissionFraction = 0.75

/// When an idle sandbox sleeps or is deleted, from its record: a running sandbox idle for `sleepAfter` sleeps; one idle
/// for `deleteAfter` (opt-in) is deleted, counting time asleep too.
struct IdlePolicy {
    enum Step { case none, sleep, delete }
    let sleepAfter: TimeInterval
    let deleteAfter: TimeInterval?
    init(_ record: SandboxRecord) {
        sleepAfter = TimeInterval(record.sleepAfterMs) / 1000
        deleteAfter = record.deleteAfterMs.map { TimeInterval($0) / 1000 }
    }
    func step(idleFor idle: TimeInterval, running: Bool) -> Step {
        if let deleteAfter, idle >= deleteAfter { return .delete }
        return running && idle >= sleepAfter ? .sleep : .none
    }
}

/// The Mac's power notices, from IOKit or, in dev runs, `host.simulate_power`.
public enum PowerEvent: String, Sendable {
    case willSleep = "will_sleep", willPowerOff = "will_power_off", didWake = "did_wake"
}

/// A start that cannot fit even after sleeping every sandbox that may sleep: what holds the memory.
struct AdmissionRefused: Error, Sendable {
    struct Holder: Sendable { let sandboxID: String; let name: String; let memoryBytes: UInt64; let runningJobs: Int? }
    let message: String
    let neededBytes: UInt64, budgetBytes: UInt64, reservedBytes: UInt64
    let holders: [Holder]
}

/// The single owner of this Mac's sandboxes: one `SandboxRuntime` per directory under `sandboxes/`, each request
/// routed by `sandbox_id`, and the machine-level operations the connector and CLI use.
public actor SandboxHost {
    private let root: URL
    private let factory: any SandboxBackendFactory
    private var runtimes: [String: SandboxRuntime] = [:]
    /// Directories under `root` without a readable record; reported, never deleted.
    private var strays: [String] = []
    /// Starts above 0 so a connector's first watch (`since: 0`) answers at once.
    private var stateVersion = 1
    private let watchers = WaitList<Void>()
    private var connectorReport: ConnectorReport?
    private let hostCPUs: Int
    private let hostMemoryBytes: UInt64
    /// What running sandboxes may reserve: `admissionFraction` of RAM, or a dev cap.
    private let budgetBytes: UInt64
    /// Changes only when what sandboxes reserve changes (a lifecycle event), so the connector writes capacity only then.
    private var capacityRevision = 0
    /// Running macOS guests one Mac may hold, sandboxes and image builds together (Apple's licence; Virtualization refuses
    /// a third).
    static let macOSRunningLimit = 2
    /// Free disk as last reported. Free space moves by a few bytes all the time; the connector reports capacity to
    /// Convex whenever it changes, so the figure only moves once it is a gibibyte off, and an idle Mac makes no calls.
    private var reportedFreeDisk: UInt64?
    static let freeDiskReportStep: UInt64 = 1 << 30
    private var lastReserved: (bytes: UInt64, running: Int)?
    /// Sandboxes admitted and starting, counted against the budget until their runtime reports `starting` or later.
    private var admitted: Set<String> = []
    /// Admission decisions run one at a time, so two starts never both take the same room.
    private var admissionBusy = false
    private var admissionWaiters: [CheckedContinuation<Void, Never>] = []
    private let now: @Sendable () -> Date
    /// Sandboxes the idle policy deleted, kept for `host.watch` until the catalog stops listing them.
    private var idleDeletions: [String: (name: String, reason: String)] = [:]
    private var idleBusy = false
    /// Sandboxes the Mac's sleep took down, brought back when it wakes.
    private var poweredDown: Set<String> = []
    /// `host.simulate_power` is a dev tool (`LOCALBOX_DEV=1`).
    private let allowsSimulatedPower: Bool
    /// The installed CLI, which answers agent setup for remote callers (`LOCALBOX_CLI`).
    private let agentSetup: AgentSetupCLI?
    /// Sandboxes being laid down: provisioning runs off this actor, so a re-run create must not lay down a second copy.
    private var provisioning: Set<String> = []
    /// The guest agent build this Mac ships (`LOCALBOX_GUEST_AGENT`); every sandbox is kept at it.
    private let agentUpdater: GuestAgentUpdater?
    /// The journal a create that waits for its image's copy begins in (`SandboxCreateAfterCopy`).
    nonisolated let operations: HostOperationStore
    /// This Mac's images, asked only for free disk (capacity): the host does no image file I/O.
    nonisolated let store: ImageStore
    /// macOS image builds holding a macOS VM slot (`takeMacOSSlot`), by operation key: with running macOS sandboxes, the
    /// one count of this Mac's macOS VMs.
    private var macOSBuilds: Set<String> = []

    private let changes: ChangeSignal

    /// Loads every sandbox under `sandboxesDirectory`; nothing boots until `recover()`. Host capacity defaults to this
    /// Mac's, and the admission budget to `admissionFraction` of its RAM (`admissionBytes` caps it in dev runs).
    public init(sandboxesDirectory: URL, factory: any SandboxBackendFactory, operations: HostOperationStore, store: ImageStore, hostCPUs: Int? = nil, hostMemoryBytes: UInt64? = nil, admissionBytes: UInt64? = nil,
                allowsSimulatedPower: Bool = false, agentSetup: AgentSetupCLI? = nil, agentUpdater: GuestAgentUpdater? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        root = sandboxesDirectory; self.factory = factory; self.operations = operations; self.store = store; self.now = now; self.allowsSimulatedPower = allowsSimulatedPower; self.agentSetup = agentSetup; self.agentUpdater = agentUpdater
        self.hostCPUs = hostCPUs ?? ProcessInfo.processInfo.activeProcessorCount
        let memory = hostMemoryBytes ?? ProcessInfo.processInfo.physicalMemory
        self.hostMemoryBytes = memory
        budgetBytes = admissionBytes ?? UInt64(Double(memory) * admissionFraction)
        let changes = ChangeSignal(); self.changes = changes
        var found: [String: SandboxRuntime] = [:], strays: [String] = []
        for name in ((try? FileManager.default.contentsOfDirectory(atPath: sandboxesDirectory.path)) ?? []).sorted() where !name.hasPrefix(".") {
            let directory = SandboxDirectory(sandboxesDirectory.appendingPathComponent(name, isDirectory: true))
            if let record = try? directory.load(), record.sandboxID == name { found[name] = SandboxRuntime(record: record, directory: directory, factory: factory, agentUpdater: agentUpdater, now: now, onChange: changes.fire) } else { strays.append(name) }
        }
        runtimes = found; self.strays = strays
        changes.host = self
    }

    private func makeRuntime(_ record: SandboxRecord, _ directory: SandboxDirectory) -> SandboxRuntime {
        SandboxRuntime(record: record, directory: directory, factory: factory, agentUpdater: agentUpdater, now: now, onChange: changes.fire)
    }

    public func runtime(_ sandboxID: String) -> SandboxRuntime? { runtimes[sandboxID] }

    /// `image.capture`'s source (P2): a sleeping sandbox wakes through admission like any start, so the disk it saves
    /// holds what the sleep kept in memory or in its save file; a running one is left as it is. Returns what that took.
    func wakeForCapture(_ runtime: SandboxRuntime) async throws -> [SandboxAction] {
        try await start(runtime) { try await $0.bringUp() }
    }

    /// The sandboxes the account catalog lists here, in id order.
    public func sandboxes() async -> [SandboxRecord] { await snapshots().map(\.record) }

    /// At daemon start: restore hibernated sandboxes, cold-boot those owed one, all at once. Returns each one's action.
    /// Each passes admission without making room, so one that no longer fits stays down until it is started.
    @discardableResult public func recover() async -> [String: SandboxAction] {
        await withTaskGroup(of: (String, SandboxAction?).self) { group in
            for (id, runtime) in runtimes {
                group.addTask {
                    guard await runtime.owesRecovery else { return (id, nil) }
                    do { return (id, try await self.start(runtime, makeRoom: false) { try await $0.recover() }.last) }
                    catch let refused as AdmissionRefused { return (id, ["kind": "error", "detail": "left \(await runtime.record.name) down: \(refused.message)"]) }
                    catch { return (id, ["kind": "error", "detail": explain(error)]) }
                }
            }
            var actions: [String: SandboxAction] = [:]
            for await (id, action) in group { if let action { actions[id] = action } }
            return actions
        }
    }

    /// SIGTERM and power-off: hibernate every running sandbox, all at once; one that cannot be saved stops and
    /// owes a cold boot. `finished` hears each sandbox as it is done (its name, and why it was not saved), for a
    /// supervisor's progress. Returns what each did.
    @discardableResult public func shutdown(finished: @escaping @Sendable (_ name: String, _ failure: String?) -> Void = { _, _ in }) async -> [String: SandboxAction] {
        // A freezing sandbox is saved once its clone ends and it thaws (`hibernate` waits for the operation).
        await concurrently(await runtimes(in: [.ready, .paused, .freezing])) { runtime in
            let name = await runtime.record.name
            let failure = await runtime.hibernate()
            finished(name, failure)
            if let failure { return ["kind": "stopped", "detail": "stopped \(name), which cold-boots at the next start: \(failure)"] }
            return ["kind": "slept", "detail": "hibernated \(name)"]
        }
    }

    /// The Mac's power. Before it sleeps, every running sandbox sleeps (hibernates, or pauses in memory where
    /// saving fails) and comes back when it wakes, reported with its next result; before it powers off, every sandbox
    /// is saved or stopped as on SIGTERM. Returns what each sandbox did.
    @discardableResult public func power(_ event: PowerEvent) async -> [String: SandboxAction] {
        switch event {
        case .willPowerOff: return await shutdown()
        case .willSleep:
            let slept = await concurrently(await runtimes(in: [.ready])) { runtime in
                do { return try await runtime.sleep(power: true) } catch { return ["kind": "error", "detail": "could not sleep \(await runtime.record.name): \(explain(error))"] }
            }
            poweredDown.formUnion(slept.filter { $0.value["kind"] == "slept" }.keys)
            return slept
        case .didWake:
            let woken = runtimes.filter { poweredDown.contains($0.key) }
            poweredDown = []
            return await concurrently(woken) { runtime in
                do {
                    guard let action = try await self.start(runtime, makeRoom: false, { try await $0.bringUp() }).last else { return nil }
                    await runtime.report(action); return action
                } catch { return ["kind": "error", "detail": "could not wake \(await runtime.record.name): \(explain(error))"] }
            }
        }
    }

    /// The idle policy, run every second by the daemon: a running sandbox idle for its `sleepAfter` sleeps, and
    /// one idle for its `deleteAfter` is deleted here and handed to the connector (`host.watch` `deleted`) to remove
    /// from the catalog. Idle means no request in flight and no running Localbox job; the guest is asked about jobs
    /// once the time is up, then every second while one runs. Returns what it did.
    @discardableResult public func idleTick() async -> [String: SandboxAction] {
        guard !idleBusy else { return [:] }
        idleBusy = true; defer { idleBusy = false }
        var done: [String: SandboxAction] = [:]
        for (id, runtime) in runtimes.sorted(by: { $0.key < $1.key }) {
            // An agent update deferred by a running job (or a request) is tried again each tick.
            if let updated = await runtime.updateAgentIfDue() { done[id] = updated; continue }
            let sandbox = await runtime.snapshot()
            guard let since = await runtime.idleSince(), ![.starting, .stopping, .freezing].contains(sandbox.status.lifecycle) else { continue }
            let idle = now().timeIntervalSince(since), policy = IdlePolicy(sandbox.record)
            let running = sandbox.status.lifecycle == .ready
            var step = policy.step(idleFor: idle, running: running)
            if step == .delete, !sandbox.record.inCatalog { step = .none }
            let watching = await runtime.watchingJobs
            if running, step != .none || watching {
                guard let jobs = await runtime.runningJobs() else { continue }
                await runtime.looked(runningJobs: jobs)
                if jobs > 0 { continue }
            }
            guard step != .none else { continue }
            if step == .delete { done[id] = await deleteIdle(id, runtime, idleFor: idle, deleteAfter: policy.deleteAfter!); continue }
            await lockAdmission()
            if let action = try? await runtime.sleep() { done[id] = action }
            unlockAdmission()
        }
        return done
    }

    private func deleteIdle(_ id: String, _ runtime: SandboxRuntime, idleFor idle: TimeInterval, deleteAfter: TimeInterval) async -> SandboxAction {
        let name = await runtime.record.name
        let reason = "idle for \(spoken(idle)), past its delete-after of \(spoken(deleteAfter))"
        var detail = "deleted \(name): \(reason)"
        if let failure = await discard(id, runtime) { detail += "; \(failure)" }
        idleDeletions[id] = (name, reason)
        return ["kind": "deleted", "detail": detail]
    }

    /// Stops a sandbox, forgets it and removes its directory (disk included). Returns what could not be removed.
    private func discard(_ id: String, _ runtime: SandboxRuntime) async -> String? {
        runtimes[id] = nil
        await runtime.discard()
        defer { bumpStateVersion() }
        do { try FileManager.default.removeItem(at: runtime.directory.url); return nil } catch { return "could not remove \(runtime.directory.url.path): \(explain(error))" }
    }

    /// The runtimes whose lifecycle is one of `lifecycles`.
    private func runtimes(in lifecycles: Set<RuntimeLifecycle>) async -> [String: SandboxRuntime] {
        var chosen: [String: SandboxRuntime] = [:]
        for (id, runtime) in runtimes where lifecycles.contains(await runtime.status().lifecycle) { chosen[id] = runtime }
        return chosen
    }

    /// Runs `body` on every runtime at once; returns the actions it gave.
    private func concurrently(_ chosen: [String: SandboxRuntime], _ body: @escaping @Sendable (SandboxRuntime) async -> SandboxAction?) async -> [String: SandboxAction] {
        await withTaskGroup(of: (String, SandboxAction?).self) { group in
            for (id, runtime) in chosen { group.addTask { (id, await body(runtime)) } }
            var actions: [String: SandboxAction] = [:]
            for await (id, action) in group { if let action { actions[id] = action } }
            return actions
        }
    }

    /// Every request but the image operations (`HostDaemon` routes those to `ImageHost`).
    public func request(_ envelope: Data) async throws -> Data {
        guard let object = try? JSONSerialization.jsonObject(with: envelope) as? [String: Any], let operation = object["operation"] as? String else {
            return Reply.failure([:], code: "invalid_input", message: "the request is not a JSON envelope with an operation")
        }
        let input = object["input"] as? [String: Any] ?? [:]
        // Machine-level operations for the connector; they are not in the public catalog and name no sandbox.
        switch operation {
        case "host.watch":
            let since = (input["since"] as? NSNumber)?.intValue ?? 0
            let timeout = min(max((input["timeout_ms"] as? NSNumber)?.intValue ?? 25_000, 0), 50_000)
            await waitForChange(since: since, timeoutMs: timeout)
            let version = stateVersion
            let all = await snapshots()
            // `name`, `os` and `lifecycle` (which tells a paused sandbox from one saved to disk, both `sleeping`) are
            // for `localbox app status`, which shows this Mac's sandboxes from this one answer.
            let states = all.map { ["sandbox_id": $0.record.sandboxID, "name": $0.record.name, "os": $0.record.os.rawValue, "state": $0.status.lifecycle.sandboxState,
                                    "lifecycle": $0.status.lifecycle.rawValue, "cpus": $0.record.cpus, "memory_bytes": $0.record.memoryBytes] as [String: Any] }
            let deleted = idleDeletions.sorted { $0.key < $1.key }.map { ["sandbox_id": $0.key, "name": $0.value.name, "reason": $0.value.reason] }
            return Reply.success(object, ["version": version, "capacity": await capacity(), "sandboxes": states, "deleted": deleted, "operations": await workInProgress()])
        case "connector.report":
            guard let state = input["state"] as? String, !state.isEmpty else { return Reply.failure(object, code: "invalid_input", message: "connector.report requires state") }
            connectorReport = ConnectorReport(state: state, detail: input["detail"] as? String, reportedAt: now())
            return Reply.success(object, ["recorded": true])
        case "sandbox.mirror":
            guard let rows = input["sandboxes"] as? [[String: Any]] else { return Reply.failure(object, code: "invalid_input", message: "sandbox.mirror requires sandboxes") }
            let machineID = input["machine_id"] as? String
            let source: MirrorSource
            switch input["source"] as? String {
            case "catalog" where !(machineID ?? "").isEmpty: source = .catalog(machineID: machineID!)
            case "signed_out": source = .signedOut
            default: return Reply.failure(object, code: "invalid_input", message: "sandbox.mirror takes source catalog with machine_id (the signed-in connector's list) or signed_out")
            }
            return await mirror(object, rows: rows, source: source)
        case "host.simulate_power":
            guard allowsSimulatedPower else { return Reply.failure(object, code: "unsupported", message: "host.simulate_power needs a daemon started with LOCALBOX_DEV=1") }
            guard let event = (input["event"] as? String).flatMap(PowerEvent.init(rawValue:)) else { return Reply.failure(object, code: "invalid_input", message: "host.simulate_power takes event will_sleep, will_power_off or did_wake") }
            let actions = await power(event)
            return Reply.success(object, ["event": event.rawValue, "sandboxes": actions.sorted { $0.key < $1.key }.map { ["sandbox_id": $0.key].merging($0.value) { first, _ in first } }])
        default: break
        }
        let host = HostOperation(rawValue: operation)
        if host == .sandboxList { return Reply.success(object, ["sandboxes": await snapshots().map(view)]) }
        if host == .relayStatus { return relayStatus(object) }
        if let host, host.isAgentSetup { return await runAgentSetup(object, operation: operation, input: input) }
        guard let sandboxID = object["sandbox_id"] as? String, !sandboxID.isEmpty else { return Reply.failure(object, code: "invalid_input", message: "\(operation) needs a sandbox_id") }
        if host == .sandboxCreate { return await createRequest(object, sandboxID: sandboxID, input: input) }
        // A sandbox still waiting for its image is only a journaled create here; deleting it stops that create first.
        let stoppedCreating = host == .sandboxDelete ? await SandboxCreateAfterCopy.cancel(on: operations, sandboxID: sandboxID) : nil
        guard let runtime = runtimes[sandboxID], await runtime.record.inCatalog else {
            if let name = stoppedCreating {
                return Reply.success(object, report(input, produced: ["sandbox_id": sandboxID, "name": name, "removed": ["the create waiting for its image"]], actions: [["kind": "deleted", "detail": "stopped creating \(name), which was waiting for its image"]]))
            }
            return Reply.failure(object, code: "sandbox_not_found", message: "no sandbox \(sandboxID) on this machine")
        }
        let response: Data
        var woke: [SandboxAction] = []
        if let host {
            response = await hostOperation(host, object, input, runtime: runtime)
        } else {
            // Any guest operation on a sleeping sandbox wakes it first, through admission like a start. Reading or
            // changing the sandbox from outside (status, logs, rename, resize, stop, sleep, delete) leaves it asleep.
            if [.paused, .asleep].contains(await runtime.settled()) {
                do { woke = try await start(runtime) { try await $0.bringUp() } }
                catch let refused as AdmissionRefused { return withActions(machineFull(object, refused), await runtime.takeUnreported()) }
                catch { return withActions(Reply.failure(object, code: "sandbox_not_ready", message: "could not wake \(await runtime.record.name): \(explain(error))"), await runtime.takeUnreported()) }
            }
            response = try await runtime.forward(envelope)
        }
        return withActions(response, await runtime.takeUnreported() + woke)
    }

    /// The catalog's per-sandbox operations the host answers itself.
    private func hostOperation(_ host: HostOperation, _ object: [String: Any], _ input: [String: Any], runtime: SandboxRuntime) async -> Data {
        let sandbox = await runtime.snapshot()
        let name = sandbox.record.name, sandboxID = sandbox.record.sandboxID
        switch host {
        case .sandboxCreate, .sandboxList, .relayStatus, .skillStatus, .skillInstall, .skillUpdate, .skillUninstall, .cliStatus, .agentsSetupStatus, .agentsSetupSet,
             .imageCreate, .imageCopy, .imageDelete, .imageWait:
            preconditionFailure("answered by request(), or by ImageHost (HostOperation.isImage)")
        case .systemInfo:
            return Reply.success(object, ["sandbox_id": sandboxID, "lifecycle": sandbox.status.lifecycle.rawValue, "channel_epoch": sandbox.status.channelEpoch, "runtime": "host", "agent_version": sandbox.agentVersion as Any? ?? NSNull()])
        case .sandboxStatus:
            var result = view(sandbox); result["lifecycle"] = sandbox.status.lifecycle.rawValue; result["channel_epoch"] = sandbox.status.channelEpoch
            result["sleep_after_ms"] = sandbox.record.sleepAfterMs; result["delete_after_ms"] = sandbox.record.deleteAfterMs as Any? ?? NSNull()
            if let detail = sandbox.status.detail { result["detail"] = detail }
            if let boot = sandbox.lastBoot { result["last_boot"] = boot }
            return Reply.success(object, result)
        case .sandboxLogs:
            return Reply.success(object, ["lines": [sandbox.lastBoot?["detail"], sandbox.status.detail].compactMap { $0 }])
        case .sandboxRename:
            guard let next = input["name"] as? String, !next.isEmpty else { return Reply.failure(object, code: "invalid_input", message: "sandbox.rename requires name") }
            do { try await runtime.rename(next) } catch { return Reply.failure(object, code: "internal", message: "renamed \(name) to \(next), but the guest did not take the new hostname: \(explain(error))") }
            bumpStateVersion()
            return Reply.success(object, report(input, produced: ["sandbox_id": sandboxID, "name": next, "previous_name": name], actions: [["kind": "renamed", "detail": "renamed \(name) to \(next)"]]))
        case .sandboxResize:
            let cpus = (input["cpus"] as? NSNumber)?.intValue, memory = (input["memory_bytes"] as? NSNumber)?.uint64Value
            do {
                // A running or sleeping sandbox boots again at the new size, so that size must fit.
                let actions = [.ready, .paused].contains(sandbox.status.lifecycle)
                    ? try await start(runtime, memoryBytes: memory ?? sandbox.record.memoryBytes) { try await $0.resize(cpus: cpus, memoryBytes: memory) }
                    : (try await runtime.resize(cpus: cpus, memoryBytes: memory)).map { [$0] } ?? []
                let resized = await runtime.snapshot()
                return Reply.success(object, report(input, produced: ["sandbox_id": sandboxID, "cpus": resized.record.cpus, "memory_bytes": resized.record.memoryBytes, "state": resized.status.lifecycle.sandboxState], actions: actions))
            } catch let refused as AdmissionRefused { return machineFull(object, refused) }
            catch { return Reply.failure(object, code: "conflict", message: "could not resize \(name): \(explain(error))") }
        case .sandboxDelete:
            let removed = runtime.directory.contents()
            if let failure = await discard(sandboxID, runtime) { return Reply.failure(object, code: "internal", message: "stopped \(name) but \(failure)") }
            return Reply.success(object, report(input, produced: ["sandbox_id": sandboxID, "name": name, "removed": removed], actions: [["kind": "deleted", "detail": "removed \(name) from this machine"]]))
        case .sandboxStart:
            do {
                let actions = try await start(runtime) { try await $0.bringUp() }
                return Reply.success(object, report(input, produced: ["sandbox_id": sandboxID, "state": await runtime.status().lifecycle.sandboxState], actions: actions))
            } catch let refused as AdmissionRefused { return machineFull(object, refused) }
            catch { return Reply.failure(object, code: "conflict", message: explain(error)) }
        case .sandboxStop:
            do { try await runtime.stop(); return Reply.success(object, report(input, produced: ["sandbox_id": sandboxID, "state": await runtime.status().lifecycle.sandboxState], actions: [])) }
            catch { return Reply.failure(object, code: "conflict", message: explain(error)) }
        case .sandboxSleep:
            do {
                await lockAdmission(); defer { unlockAdmission() }
                let slept = try await runtime.sleep()
                return Reply.success(object, report(input, produced: ["sandbox_id": sandboxID, "state": await runtime.status().lifecycle.sandboxState], actions: [slept]))
            } catch { return Reply.failure(object, code: "conflict", message: explain(error)) }
        }
    }

    /// Attaches what the host did for a request (a wake, a boot no request asked for) to its response: prepended to
    /// `result.actions` when the result is an object, else as a top-level `host_actions` (an error, a non-object result).
    private func withActions(_ response: Data, _ actions: [SandboxAction]) -> Data {
        guard !actions.isEmpty, var envelope = try? JSONSerialization.jsonObject(with: response) as? [String: Any] else { return response }
        if var result = envelope["result"] as? [String: Any] {
            result["actions"] = actions as [Any] + (result["actions"] as? [Any] ?? []); envelope["result"] = result
        } else { envelope["host_actions"] = actions }
        return (try? JSONSerialization.data(withJSONObject: envelope)) ?? response
    }

    /// Who sent a mirror push. `catalog` is the signed-in connector's subscription, the catalog's word on the
    /// sandboxes of machine `machineID`; `signedOut` is `localbox logout`, which hides every sandbox and deletes nothing.
    enum MirrorSource { case catalog(machineID: String), signedOut }

    /// Follows the account catalog: names and idle policies change; every row carries `sandbox_id`, `name` and
    /// `sleep_after_ms`, or the push is refused whole. A `catalog` push deletes a sandbox it no longer
    /// lists that this machine's catalog listed before (deleted while this Mac was offline): stopped, its directory and
    /// disk removed, reported in `deleted`. A sandbox this machine's catalog never listed (created and not yet listed,
    /// or hidden by a sign-out and so listed by an earlier sign-in) only stops answering and is reported in `unknown`,
    /// as are directories without a record. An empty `catalog` push deletes nothing. A push never creates a directory.
    private func mirror(_ object: [String: Any], rows: [[String: Any]], source: MirrorSource) async -> Data {
        var names: [String: String] = [:], policies: [String: (sleep: Int, delete: Int?)] = [:]
        for row in rows {
            guard let id = row["sandbox_id"] as? String, let name = row["name"] as? String, let sleep = (row["sleep_after_ms"] as? NSNumber)?.intValue else {
                return Reply.failure(object, code: "invalid_input", message: "sandbox.mirror rows need sandbox_id, name and sleep_after_ms")
            }
            names[id] = name; policies[id] = (sleep, (row["delete_after_ms"] as? NSNumber)?.intValue)
        }
        var catalogMachine: String?
        if case .catalog(let machineID) = source { catalogMachine = machineID }
        var unknown = strays, deleted: [[String: String]] = []
        for (id, runtime) in runtimes.sorted(by: { $0.key < $1.key }) {
            if let name = names[id] {
                if let catalogMachine { await runtime.setListedBy(catalogMachine) }
                await runtime.setInCatalog(true); try? await runtime.rename(name)
                await runtime.setPolicy(sleepAfterMs: policies[id]!.sleep, deleteAfterMs: policies[id]!.delete)
            } else if let catalogMachine, await runtime.record.inCatalog, await runtime.record.listedBy == catalogMachine {
                let name = await runtime.record.name
                var detail = "deleted \(name): the account catalog no longer lists it"
                if let failure = await discard(id, runtime) { detail += "; \(failure)" }
                deleted.append(["sandbox_id": id, "name": name, "detail": detail])
            } else { await runtime.setInCatalog(false); unknown.append(id) }
        }
        // The catalog no longer lists an idle-deleted sandbox once the connector removed it.
        idleDeletions = idleDeletions.filter { names[$0.key] != nil }
        bumpStateVersion()
        return Reply.success(object, ["sandboxes": names.keys.filter { runtimes[$0] != nil }.count, "missing": names.keys.filter { runtimes[$0] == nil }.sorted(), "unknown": unknown.sorted(), "deleted": deleted])
    }

    /// The connector's last report; machine-level, so it answers with or without sandboxes.
    private func relayStatus(_ object: [String: Any]) -> Data {
        let fresh = connectorReport.map { now().timeIntervalSince($0.reportedAt) <= Self.connectorReportTTL } ?? false
        let state = fresh ? connectorReport!.state : "not_running"
        var result: [String: Any] = ["connector": state, "connected": state == "connected", "detail": NSNull(), "reported_at": NSNull()]
        if let report = connectorReport {
            result["reported_at"] = ISO8601DateFormatter().string(from: report.reportedAt)
            result["detail"] = fresh ? (report.detail as Any? ?? NSNull()) : "last connector report is older than 120 s"
        }
        return Reply.success(object, result)
    }

    /// `sandbox.create`: creates the sandbox now, or, with `after_copy` (the copy of its image this Mac is receiving),
    /// answers at once and `SandboxCreateAfterCopy` creates it once the copy lands.
    private func createRequest(_ object: [String: Any], sandboxID: String, input: [String: Any]) async -> Data {
        guard let creation = SandboxCreation(input) else { return Reply.failure(object, code: "invalid_input", message: "sandbox.create requires name, image, cpus, memory_bytes and sleep_after_ms") }
        guard let copyKey = input["after_copy"] as? String else {
            do { let created = try await create(sandboxID, creation); return Reply.success(object, report(input, produced: created.produced, actions: created.actions)) }
            catch let refused as AdmissionRefused { return machineFull(object, refused) }
            catch let failure as HostOperationFailure { return Reply.failure(object, failure) }
            catch { return Reply.failure(object, code: "internal", message: explain(error)) }
        }
        guard Self.isDirectoryName(sandboxID) else { return Reply.failure(object, code: "invalid_input", message: "sandbox id \(sandboxID) is not a directory name") }
        guard let key = object["mutation_id"] as? String, !key.isEmpty else { return Reply.failure(object, code: "invalid_input", message: "sandbox.create with after_copy needs a mutation id") }
        do {
            let record = try await SandboxCreateAfterCopy.begin(on: operations, key: key, sandboxID: sandboxID, copyKey: copyKey, create: creation)
            let state = record.state == .running ? "copying" : record.state == .succeeded ? "created" : "failed"
            return Reply.success(object, report(input, produced: ["sandbox_id": sandboxID, "name": creation.name, "state": state, "operation_id": key, "copy_operation_id": copyKey], actions: []))
        } catch let refused as HostOperationFailure { return Reply.failure(object, refused) }
        catch { return Reply.failure(object, code: "internal", message: "could not start creating \(creation.name): \(explain(error))") }
    }

    private static func isDirectoryName(_ id: String) -> Bool { !id.isEmpty && !id.contains("/") && !id.hasPrefix(".") }

    /// Lays down the sandbox the agent API reserved, from the image it resolved, at the size and idle policy it chose,
    /// and boots it. A create re-run after a connector restart finds the sandbox already here and only boots it. Throws a
    /// `HostOperationFailure`, or `AdmissionRefused` when it does not fit.
    func create(_ sandboxID: String, _ creation: SandboxCreation) async throws -> CreateReport {
        let name = creation.name
        guard Self.isDirectoryName(sandboxID) else { throw HostOperationFailure(code: "invalid_input", message: "sandbox id \(sandboxID) is not a directory name") }
        var actions: [SandboxAction] = []
        var facts: [String: String] = [:]
        let runtime: SandboxRuntime
        let existing = runtimes[sandboxID]
        if existing == nil, provisioning.contains(sandboxID) { throw HostOperationFailure(code: "conflict", message: "\(name) is already being created") }
        if let existing {
            runtime = existing; await existing.setInCatalog(true); try? await existing.rename(name)
        } else {
            var record = SandboxRecord(sandboxID: sandboxID, name: name, imageID: creation.image, cpus: creation.cpus, memoryBytes: creation.memoryBytes, sleepAfterMs: creation.sleepAfterMs)
            record.deleteAfterMs = creation.deleteAfterMs
            let directory = SandboxDirectory(root.appendingPathComponent(sandboxID, isDirectory: true))
            provisioning.insert(sandboxID)
            do {
                try FileManager.default.createDirectory(at: directory.url, withIntermediateDirectories: true)
                facts = try await factory.provision(&record, in: directory)
                try directory.save(record)
                provisioning.remove(sandboxID)
            } catch {
                try? FileManager.default.removeItem(at: directory.url)
                provisioning.remove(sandboxID)
                if let missing = error as? ImageNotHere { throw HostOperationFailure(code: "image_not_found", message: "could not lay down \(name): \(missing)") }
                throw HostOperationFailure(code: "internal", message: "could not lay down \(name): \(explain(error))")
            }
            runtime = makeRuntime(record, directory); runtimes[sandboxID] = runtime
            bumpStateVersion()
            actions.append(["kind": "created", "detail": "created \(name) with \(record.cpus) CPUs and \(record.memoryBytes / (1024 * 1024 * 1024)) GiB" + (facts["disk"].map { "; disk \($0)" } ?? "")])
        }
        do { actions += try await start(runtime) { try await $0.bringUp() } }
        catch {
            if existing == nil { _ = await discard(sandboxID, runtime) }
            if error is AdmissionRefused { throw error }
            throw HostOperationFailure(code: "sandbox_not_ready", message: "\(name) could not start: \(explain(error))")
        }
        let sandbox = await runtime.snapshot()
        return CreateReport(sandboxID: sandboxID, name: name, cpus: sandbox.record.cpus, memoryBytes: sandbox.record.memoryBytes, state: sandbox.status.lifecycle.sandboxState, facts: facts, actions: actions)
    }

    /// What this Mac can still take: reservation-based, not live free memory. Unlisted sandboxes still hold what they
    /// run with. Free disk and the macOS version are what placement checks before copying an image here.
    private func capacity() async -> [String: Any] {
        let holding = await snapshots(includingUnlisted: true).filter(\.reservesMemory)
        let reserved = holding.map(\.record.memoryBytes).reduce(0, +)
        if lastReserved?.bytes != reserved || lastReserved?.running != holding.count { capacityRevision += 1; lastReserved = (reserved, holding.count) }
        return ["cpus": hostCPUs, "total_bytes": hostMemoryBytes, "reserved_bytes": reserved, "room_bytes": budgetBytes > reserved ? budgetBytes - reserved : 0, "running": holding.count, "revision": capacityRevision,
                "free_disk_bytes": reportFreeDisk(try? store.freeBytes()).map { $0 as Any } ?? NSNull(), "macos_version": ProcessInfo.processInfo.operatingSystemVersion.dotted]
    }

    /// Free disk as capacity reports it: the last figure until the volume moves a gibibyte from it.
    private func reportFreeDisk(_ current: UInt64?) -> UInt64? {
        guard let current else { return reportedFreeDisk }
        if let last = reportedFreeDisk, (current > last ? current - last : last - current) < Self.freeDiskReportStep { return last }
        reportedFreeDisk = current
        return current
    }
    /// Admits `runtime` (making room unless told not to), then runs `body`, which starts it. Returns the made_room
    /// actions followed by what `body` did. The sandbox counts against the budget from admission on.
    private func start(_ runtime: SandboxRuntime, memoryBytes: UInt64? = nil, makeRoom: Bool = true, _ body: @Sendable (SandboxRuntime) async throws -> SandboxAction?) async throws -> [SandboxAction] {
        let id = await runtime.record.sandboxID
        await lockAdmission()
        let made: [SandboxAction]
        do { made = try await admit(start: id, memoryBytes: memoryBytes, makeRoom: makeRoom) } catch { unlockAdmission(); throw error }
        admitted.insert(id); unlockAdmission()
        defer { admitted.remove(id) }
        return made + ((try await body(runtime)).map { [$0] } ?? [])
    }

    /// Admission for a start or wake of `sandboxID` (at `memoryBytes`, else its own size); one that already holds its
    /// memory is admitted as it is. Callers hold the admission lock.
    func admit(start sandboxID: String, memoryBytes: UInt64? = nil, makeRoom: Bool = true) async throws -> [SandboxAction] {
        guard let runtime = runtimes[sandboxID] else { throw HostDaemonError.invalidState("no sandbox \(sandboxID) on this machine") }
        let sandbox = await runtime.snapshot()
        if memoryBytes == nil, sandbox.reservesMemory { return [] }
        let record = sandbox.record
        return try await admit(Applicant(sandboxID: sandboxID, name: record.name, macOS: record.os == .macos, memoryBytes: memoryBytes ?? record.memoryBytes,
                                         asMacOS: "\(record.name) is a macOS sandbox"), makeRoom: makeRoom)
    }

    /// A macOS image build's VM takes one of the two macOS VM slots through the same admission as a macOS sandbox start,
    /// before it boots: the least recently used idle macOS sandbox sleeps for it (each reported as `made_room`), or it is
    /// refused (`AdmissionRefused`) naming what holds the slots. The slot is held under `key` (the build's operation)
    /// until `releaseMacOSSlot`; taking it again under the same key takes nothing. A build's VM is not counted against
    /// the memory budget.
    func takeMacOSSlot(build key: String, image: String) async throws -> [SandboxAction] {
        await lockAdmission(); defer { unlockAdmission() }
        if macOSBuilds.contains(key) { return [] }
        let made = try await admit(Applicant(sandboxID: nil, name: "building \(image)", macOS: true, memoryBytes: nil, asMacOS: "building macOS image \(image) needs a macOS VM"), makeRoom: true)
        macOSBuilds.insert(key)
        return made
    }

    /// The build under `key` no longer runs a VM, so its macOS VM slot is free.
    func releaseMacOSSlot(build key: String) { macOSBuilds.remove(key) }

    /// What asks admission for room: a sandbox (by id) with the memory it reserves, or a macOS image build (no sandbox, no
    /// memory counted). `asMacOS` opens the refusal when the macOS limit is what stops it.
    struct Applicant {
        let sandboxID: String?
        let name: String
        let macOS: Bool
        let memoryBytes: UInt64?
        let asMacOS: String
    }

    /// Admission: `applicant` must fit in the memory budget, and a macOS VM in the two macOS VM slots.
    /// If it does not, least-recently-used running sandboxes (and VMs asleep in memory, which keep their RAM) sleep
    /// until it does, never one running a job or serving a request; each is reported as `made_room`. Nothing sleeps
    /// unless the start then fits; otherwise this throws `AdmissionRefused` naming every sandbox that holds memory (or,
    /// for the macOS limit, every macOS VM). Callers hold the admission lock.
    private func admit(_ applicant: Applicant, makeRoom: Bool) async throws -> [SandboxAction] {
        let needed = applicant.memoryBytes ?? 0
        let others = await snapshots(includingUnlisted: true).filter { $0.record.sandboxID != applicant.sandboxID }
        let holding = others.filter { $0.reservesMemory || admitted.contains($0.record.sandboxID) }
        var reserved = holding.map(\.record.memoryBytes).reduce(0, +)
        func overBudget() -> Bool { applicant.memoryBytes != nil && reserved + needed > budgetBytes }
        let macOSHolding = applicant.macOS ? holding.filter { $0.record.os == .macos } : []
        let builds = applicant.macOS ? macOSBuilds.count : 0
        var macOSRunning = macOSHolding.count + builds
        guard overBudget() || macOSRunning >= Self.macOSRunningLimit else { return [] }
        let candidates = holding.filter { [.ready, .paused].contains($0.status.lifecycle) && !admitted.contains($0.record.sandboxID) }
            .sorted { ($0.record.lastActivityAt ?? .distantPast, $0.record.sandboxID) < ($1.record.lastActivityAt ?? .distantPast, $1.record.sandboxID) }
        var jobs: [String: Int?] = [:]
        // A sandbox asleep in memory was idle when it slept and runs nothing meanwhile.
        for candidate in candidates { jobs[candidate.record.sandboxID] = candidate.status.lifecycle == .paused ? 0 : await runtimes[candidate.record.sandboxID]?.runningJobs() }
        var victims: [SandboxRuntime] = [], chosen: Set<String> = []
        func choose(_ candidate: RuntimeSnapshot) {
            guard let victim = runtimes[candidate.record.sandboxID] else { return }
            victims.append(victim); chosen.insert(candidate.record.sandboxID); reserved -= candidate.record.memoryBytes
        }
        func describe(_ held: RuntimeSnapshot) -> String {
            let jobs = jobs[held.record.sandboxID] ?? nil
            let doing = held.status.lifecycle == .paused ? "asleep in memory" : held.status.lifecycle == .freezing ? "frozen for a disk clone" : held.status.lifecycle != .ready || admitted.contains(held.record.sandboxID) ? "starting" : jobs.map { $0 == 1 ? "1 running job" : "\($0) running jobs" } ?? "busy, or did not say whether it runs jobs"
            return "\(held.record.name) (\(gibibytes(held.record.memoryBytes)), \(doing))"
        }
        // macOS runs at most two macOS guests per Mac (its licence, enforced by Virtualization), sandboxes and image builds
        // together; a third sleeps the least recently used idle macOS sandbox, or is refused with the reason, never with
        // Virtualization's raw error. At daemon start (no making room) nothing is chosen to sleep.
        if makeRoom {
            for candidate in candidates where candidate.record.os == .macos && macOSRunning >= Self.macOSRunningLimit && (jobs[candidate.record.sandboxID] ?? nil) == 0 {
                choose(candidate); macOSRunning -= 1
            }
        }
        if macOSRunning >= Self.macOSRunningLimit {
            let holders = macOSHolding.map { AdmissionRefused.Holder(sandboxID: $0.record.sandboxID, name: $0.record.name, memoryBytes: $0.record.memoryBytes, runningJobs: jobs[$0.record.sandboxID] ?? nil) }
            let running = builds == 0 ? "\(Self.macOSRunningLimit) macOS sandboxes" : "\(Self.macOSRunningLimit) macOS VMs"
            let held = macOSHolding.map(describe) + (builds == 0 ? [] : [builds == 1 ? "a macOS image build (it can't sleep)" : "\(builds) macOS image builds (they can't sleep)"])
            throw AdmissionRefused(message: "\(applicant.asMacOS), and this Mac already runs \(running), the most macOS allows; \(makeRoom ? "none of them can sleep" : "none is slept at daemon start"): \(held.joined(separator: ", "))", neededBytes: needed, budgetBytes: budgetBytes, reservedBytes: holding.map(\.record.memoryBytes).reduce(0, +), holders: holders)
        }
        if makeRoom {
            for candidate in candidates where overBudget() && !chosen.contains(candidate.record.sandboxID) && (jobs[candidate.record.sandboxID] ?? nil) == 0 { choose(candidate) }
        }
        guard !overBudget() else {
            let holders = holding.map { AdmissionRefused.Holder(sandboxID: $0.record.sandboxID, name: $0.record.name, memoryBytes: $0.record.memoryBytes, runningJobs: jobs[$0.record.sandboxID] ?? nil) }
            let total = holding.map(\.record.memoryBytes).reduce(0, +)
            throw AdmissionRefused(message: "\(applicant.name) needs \(gibibytes(needed)), but sandboxes reserve \(gibibytes(total)) of this machine's \(gibibytes(budgetBytes)) and \(makeRoom ? "not enough of them can sleep" : "none is slept at daemon start"): \(holding.isEmpty ? "none running" : holding.map(describe).joined(separator: ", "))", neededBytes: needed, budgetBytes: budgetBytes, reservedBytes: total, holders: holders)
        }
        var actions: [SandboxAction] = []
        for victim in victims { actions.append(["kind": "made_room", "detail": try await victim.sleepForRoom()]) }
        return actions
    }

    private func lockAdmission() async {
        guard admissionBusy else { admissionBusy = true; return }
        await withCheckedContinuation { admissionWaiters.append($0) }
    }

    /// Hands the lock to the next waiter, or frees it.
    private func unlockAdmission() {
        if admissionWaiters.isEmpty { admissionBusy = false } else { admissionWaiters.removeFirst().resume() }
    }

    private func machineFull(_ object: [String: Any], _ refused: AdmissionRefused) -> Data {
        let holders = refused.holders.map { ["sandbox_id": $0.sandboxID, "name": $0.name, "memory_bytes": $0.memoryBytes, "running_jobs": $0.runningJobs as Any? ?? NSNull()] as [String: Any] }
        return Reply.failure(object, code: "machine_full", message: refused.message, details: ["needed_bytes": refused.neededBytes, "budget_bytes": refused.budgetBytes, "reserved_bytes": refused.reservedBytes, "sandboxes": holders])
    }

    private func snapshots(includingUnlisted: Bool = false) async -> [RuntimeSnapshot] {
        var all: [RuntimeSnapshot] = []
        for id in runtimes.keys.sorted() { if let runtime = runtimes[id] { let snapshot = await runtime.snapshot(); if includingUnlisted || snapshot.record.inCatalog { all.append(snapshot) } } }
        return all
    }

    private func view(_ sandbox: RuntimeSnapshot) -> [String: Any] {
        ["sandbox_id": sandbox.record.sandboxID, "name": sandbox.record.name, "cpus": sandbox.record.cpus, "memory_bytes": sandbox.record.memoryBytes, "state": sandbox.status.lifecycle.sandboxState]
    }

    private func report(_ requested: [String: Any], produced: [String: Any], actions: [[String: Any]]) -> [String: Any] {
        ["requested": requested, "produced": produced, "actions": actions]
    }

    /// This Mac's image work for `host.watch`: every running operation, and each image's latest operation when it
    /// failed, as `image.wait` shows a record (no checkpoint). A sandbox waiting for its image's copy also names the
    /// sandbox (`sandbox: { sandbox_id, name }`), which only its checkpoint knows. Progress does not bump the watch
    /// version; a caller showing it polls while anything here runs.
    private func workInProgress() async -> [[String: Any]] {
        let records = await operations.current()
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        return records.compactMap { record in
            guard let data = try? encoder.encode(record), var view = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            view["checkpoint"] = nil
            if record.kind == SandboxCreateAfterCopy.kind, let waiting = try? record.checkpoint.decoded(as: SandboxCreateAfterCopy.Checkpoint.self) {
                view["sandbox"] = ["sandbox_id": waiting.sandboxID, "name": waiting.create.name]
            }
            return view
        }
    }

    /// Returns once the state version passes `since`, or at the timeout.
    private func waitForChange(since: Int, timeoutMs: Int) async {
        guard stateVersion <= since, timeoutMs > 0 else { return }
        await watchers.wait(for: (), timeout: TimeInterval(timeoutMs) / 1000)
    }

    fileprivate func bumpStateVersion() {
        stateVersion += 1
        watchers.wakeAll()
    }

    /// Agent setup belongs to the CLI; the daemon runs it here and answers with its envelope's result or error.
    private func runAgentSetup(_ object: [String: Any], operation: String, input: [String: Any]) async -> Data {
        guard let agentSetup else { return Reply.failure(object, code: "unsupported", message: "this daemon was started without LOCALBOX_CLI, so it cannot run \(operation)") }
        let outcome = await agentSetup.operation(operation, input: input)
        if outcome.timedOut { return Reply.failure(object, code: "operation_timeout", message: "localbox agents op \(operation) did not finish within \(Int(agentSetup.timeout)) s") }
        guard let envelope = try? JSONSerialization.jsonObject(with: outcome.stdout) as? [String: Any], let ok = envelope["ok"] as? Bool else {
            let said = outcome.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return Reply.failure(object, code: "internal", message: "localbox agents op \(operation) exited \(outcome.status) without a response\(said.isEmpty ? "" : ": \(said.suffix(500))")")
        }
        if ok { return Reply.success(object, envelope["result"] ?? NSNull()) }
        let error = envelope["error"] as? [String: Any] ?? [:]
        return Reply.failure(object, code: error["code"] as? String ?? "internal", message: error["message"] as? String ?? "\(operation) failed", details: error["details"] as? [String: Any])
    }

    private static let connectorReportTTL: TimeInterval = 120
}

/// What `sandbox.create` asks for: the sandbox the agent API reserved, from the image it resolved (an id), at the size
/// and idle policy it chose.
struct SandboxCreation: Codable, Sendable {
    let name: String
    let image: String
    let cpus: Int
    let memoryBytes: UInt64
    let sleepAfterMs: Int
    let deleteAfterMs: Int?
    enum CodingKeys: String, CodingKey { case name, image, cpus, memoryBytes = "memory_bytes", sleepAfterMs = "sleep_after_ms", deleteAfterMs = "delete_after_ms" }

    init?(_ input: [String: Any]) {
        guard let name = input["name"] as? String, !name.isEmpty, let image = input["image"] as? String, !image.isEmpty, let cpus = (input["cpus"] as? NSNumber)?.intValue,
              let memoryBytes = (input["memory_bytes"] as? NSNumber)?.uint64Value, let sleepAfterMs = (input["sleep_after_ms"] as? NSNumber)?.intValue else { return nil }
        self.name = name; self.image = image; self.cpus = cpus; self.memoryBytes = memoryBytes; self.sleepAfterMs = sleepAfterMs
        deleteAfterMs = (input["delete_after_ms"] as? NSNumber)?.intValue
    }
}

/// What a create made: the report's `produced` facts and the actions it took.
struct CreateReport: Sendable {
    let sandboxID: String, name: String, cpus: Int, memoryBytes: UInt64, state: String
    /// What provisioning said (`disk: cloned`, `disk_allocated_bytes`), numbers kept as numbers in `produced`.
    let facts: [String: String]
    let actions: [SandboxAction]
    var produced: [String: Any] {
        var produced: [String: Any] = ["sandbox_id": sandboxID, "name": name, "cpus": cpus, "memory_bytes": memoryBytes, "state": state]
        for (key, value) in facts { produced[key] = Int(value).map { $0 as Any } ?? value }
        return produced
    }
}

extension HostOperation {
    /// The skill, the CLI link and the agent setup setting: machine-level, answered by the installed CLI.
    var isAgentSetup: Bool { ["skill.", "cli.", "agents."].contains { rawValue.hasPrefix($0) } }
}

/// Lets runtimes tell the host their lifecycle changed, so `host.watch` answers.
private final class ChangeSignal: @unchecked Sendable {
    weak var host: SandboxHost?
    @Sendable func fire() { let host = host; Task { await host?.bumpStateVersion() } }
}

struct ConnectorReport: Sendable {
    let state: String
    let detail: String?
    let reportedAt: Date
}
