import Foundation

public enum RuntimeLifecycle: String, Codable, Sendable {
    case starting
    case ready
    case paused
    case stopping
    case stopped
    case error

    /// The runtime state reported for the sandbox.
    var sandboxState: String {
        switch self {
        case .ready: return "running"
        case .paused: return "sleeping"
        default: return rawValue
        }
    }

    /// What the record keeps, so a daemon restart knows what to bring back; transitions are not kept.
    var saved: SavedLifecycle? {
        switch self {
        case .ready: return .running
        case .paused: return .sleeping
        case .stopped, .error: return .stopped
        case .starting, .stopping: return nil
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

public protocol VMBackend: Sendable {
    func start() async throws
    func stop() async throws
    func pause() async throws
    func resume() async throws
}

/// A backend that can persist and restore a running VM without reprovisioning it.
public protocol HibernateBackend: VMBackend {
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

/// One line for a report: our own errors say what they mean; Virtualization's NSErrors carry a localized sentence.
func explain(_ error: Error) -> String { (error as? HostDaemonError)?.description ?? error.localizedDescription }

public enum HostDaemonError: Error, CustomStringConvertible, Sendable {
    case invalidState(String)
    case unsupported(String)
    case guestUnavailable
    public var description: String {
        switch self { case .invalidState(let message), .unsupported(let message): return message; case .guestUnavailable: return "guest channel is unavailable" }
    }
}

/// The admission knob (L9): running sandboxes may reserve this share of the host's RAM; the rest is the host's.
public let admissionFraction = 0.75

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
    private var watchers: [UUID: CheckedContinuation<Void, Never>] = [:]
    private var connectorReport: ConnectorReport?
    private let hostCPUs: Int
    private let hostMemoryBytes: UInt64
    /// What running sandboxes may reserve: `admissionFraction` of RAM, or a dev cap.
    private let budgetBytes: UInt64
    /// Changes only when what sandboxes reserve changes (a lifecycle event), so the connector writes capacity only then.
    private var capacityRevision = 0
    private var lastReserved: (bytes: UInt64, running: Int)?
    /// Sandboxes admitted and starting, counted against the budget until their runtime reports `starting` or later.
    private var admitted: Set<String> = []
    /// Admission decisions run one at a time, so two starts never both take the same room.
    private var admissionBusy = false
    private var admissionWaiters: [CheckedContinuation<Void, Never>] = []
    private let now: @Sendable () -> Date

    private let changes: ChangeSignal

    /// Loads every sandbox under `sandboxesDirectory`; nothing boots until `recover()`. Host capacity defaults to this
    /// Mac's, and the admission budget to `admissionFraction` of its RAM (`admissionBytes` caps it in dev runs).
    public init(sandboxesDirectory: URL, factory: any SandboxBackendFactory, hostCPUs: Int? = nil, hostMemoryBytes: UInt64? = nil, admissionBytes: UInt64? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        root = sandboxesDirectory; self.factory = factory; self.now = now
        self.hostCPUs = hostCPUs ?? ProcessInfo.processInfo.activeProcessorCount
        let memory = hostMemoryBytes ?? ProcessInfo.processInfo.physicalMemory
        self.hostMemoryBytes = memory
        budgetBytes = admissionBytes ?? UInt64(Double(memory) * admissionFraction)
        let changes = ChangeSignal(); self.changes = changes
        var found: [String: SandboxRuntime] = [:], strays: [String] = []
        for name in ((try? FileManager.default.contentsOfDirectory(atPath: sandboxesDirectory.path)) ?? []).sorted() where !name.hasPrefix(".") {
            let directory = SandboxDirectory(sandboxesDirectory.appendingPathComponent(name, isDirectory: true))
            if let record = try? directory.load(), record.sandboxID == name { found[name] = SandboxRuntime(record: record, directory: directory, factory: factory, now: now, onChange: changes.fire) } else { strays.append(name) }
        }
        runtimes = found; self.strays = strays
        changes.host = self
    }

    private func makeRuntime(_ record: SandboxRecord, _ directory: SandboxDirectory) -> SandboxRuntime {
        SandboxRuntime(record: record, directory: directory, factory: factory, now: now, onChange: changes.fire)
    }

    public func runtime(_ sandboxID: String) -> SandboxRuntime? { runtimes[sandboxID] }

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

    /// SIGTERM (D11): hibernate every running sandbox, all at once.
    public func shutdown() async {
        await withTaskGroup(of: Void.self) { group in for runtime in runtimes.values { group.addTask { await runtime.hibernate() } } }
    }

    public func request(_ envelope: Data) async throws -> Data {
        guard let object = try? JSONSerialization.jsonObject(with: envelope) as? [String: Any], let operation = object["operation"] as? String else {
            return hostFailure([:], code: "invalid_input", message: "the request is not a JSON envelope with an operation")
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
            let states = all.map { ["sandbox_id": $0.record.sandboxID, "state": $0.status.lifecycle.sandboxState, "cpus": $0.record.cpus, "memory_bytes": $0.record.memoryBytes] as [String: Any] }
            return hostSuccess(object, result: ["version": version, "capacity": await capacity(), "sandboxes": states])
        case "connector.report":
            guard let state = input["state"] as? String, !state.isEmpty else { return hostFailure(object, code: "invalid_input", message: "connector.report requires state") }
            connectorReport = ConnectorReport(state: state, detail: input["detail"] as? String, reportedAt: now())
            return hostSuccess(object, result: ["recorded": true])
        case "sandbox.mirror":
            guard let rows = input["sandboxes"] as? [[String: Any]] else { return hostFailure(object, code: "invalid_input", message: "sandbox.mirror requires sandboxes") }
            return await mirror(object, rows: rows)
        default: break
        }
        let host = HostOperation(rawValue: operation)
        if host == .sandboxList { return hostSuccess(object, result: ["sandboxes": await snapshots().map(view)]) }
        if host == .relayStatus { return relayStatus(object) }
        guard let sandboxID = object["sandbox_id"] as? String, !sandboxID.isEmpty else { return hostFailure(object, code: "invalid_input", message: "\(operation) needs a sandbox_id") }
        if host == .sandboxCreate { return await create(object, sandboxID: sandboxID, input: input) }
        guard let runtime = runtimes[sandboxID], await runtime.record.inCatalog else { return hostFailure(object, code: "sandbox_not_found", message: "no sandbox \(sandboxID) on this machine") }
        guard let host else { return try await runtime.forward(envelope) }
        let sandbox = await runtime.snapshot()
        let name = sandbox.record.name
        switch host {
        case .sandboxCreate, .sandboxList, .relayStatus: preconditionFailure("answered above")
        case .networkEgress: return try await runtime.forward(envelope)
        case .systemInfo:
            return hostSuccess(object, result: ["sandbox_id": sandboxID, "lifecycle": sandbox.status.lifecycle.rawValue, "channel_epoch": sandbox.status.channelEpoch, "runtime": "host"])
        case .sandboxStatus:
            var result = view(sandbox); result["lifecycle"] = sandbox.status.lifecycle.rawValue; result["channel_epoch"] = sandbox.status.channelEpoch
            if let detail = sandbox.status.detail { result["detail"] = detail }
            if let boot = sandbox.lastBoot { result["last_boot"] = boot }
            return hostSuccess(object, result: result)
        case .sandboxLogs:
            return hostSuccess(object, result: ["lines": [sandbox.lastBoot?["detail"], sandbox.status.detail].compactMap { $0 }])
        case .sandboxRename:
            guard let next = input["name"] as? String, !next.isEmpty else { return hostFailure(object, code: "invalid_input", message: "sandbox.rename requires name") }
            do { try await runtime.rename(next) } catch { return hostFailure(object, code: "internal", message: "renamed \(name) to \(next), but the guest did not take the new hostname: \(explain(error))") }
            bumpStateVersion()
            return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "name": next, "previous_name": name], actions: [["kind": "renamed", "detail": "renamed \(name) to \(next)"]]))
        case .sandboxResize:
            let cpus = (input["cpus"] as? NSNumber)?.intValue, memory = (input["memory_bytes"] as? NSNumber)?.uint64Value
            do {
                // A running or sleeping sandbox boots again at the new size, so that size must fit.
                let actions = [.ready, .paused].contains(sandbox.status.lifecycle)
                    ? try await start(runtime, memoryBytes: memory ?? sandbox.record.memoryBytes) { try await $0.resize(cpus: cpus, memoryBytes: memory) }
                    : (try await runtime.resize(cpus: cpus, memoryBytes: memory)).map { [$0] } ?? []
                let resized = await runtime.snapshot()
                return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "cpus": resized.record.cpus, "memory_bytes": resized.record.memoryBytes, "state": resized.status.lifecycle.sandboxState], actions: actions))
            } catch let refused as AdmissionRefused { return machineFull(object, refused) }
            catch { return hostFailure(object, code: "conflict", message: "could not resize \(name): \(explain(error))") }
        case .sandboxDelete:
            try? await runtime.stop()
            runtimes[sandboxID] = nil
            let removed = runtime.directory.contents()
            do { try FileManager.default.removeItem(at: runtime.directory.url) } catch { return hostFailure(object, code: "internal", message: "stopped \(name) but could not remove \(runtime.directory.url.path): \(explain(error))") }
            bumpStateVersion()
            return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "name": name, "removed": removed], actions: [["kind": "deleted", "detail": "removed \(name) from this machine"]]))
        case .sandboxStart:
            do {
                let actions = try await start(runtime) { try await $0.bringUp() }
                return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "state": await runtime.status().lifecycle.sandboxState], actions: actions))
            } catch let refused as AdmissionRefused { return machineFull(object, refused) }
            catch { return hostFailure(object, code: "conflict", message: explain(error)) }
        case .sandboxStop:
            do { try await runtime.stop(); return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "state": await runtime.status().lifecycle.sandboxState], actions: [])) }
            catch { return hostFailure(object, code: "conflict", message: explain(error)) }
        case .sandboxSleep:
            do { try await runtime.pause(); return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "state": await runtime.status().lifecycle.sandboxState], actions: [["kind": "slept", "detail": "\(name) is asleep"]])) }
            catch { return hostFailure(object, code: "conflict", message: explain(error)) }
        }
    }

    /// Follows the account catalog: names change, and a sandbox the catalog no longer lists stops answering. A push never
    /// creates or deletes a directory (only create and delete do); local directories the catalog lacks are reported.
    private func mirror(_ object: [String: Any], rows: [[String: Any]]) async -> Data {
        var names: [String: String] = [:]
        for row in rows { if let id = row["sandbox_id"] as? String, let name = row["name"] as? String { names[id] = name } }
        var unknown = strays
        for (id, runtime) in runtimes.sorted(by: { $0.key < $1.key }) {
            if let name = names[id] { await runtime.setInCatalog(true); try? await runtime.rename(name) } else { await runtime.setInCatalog(false); unknown.append(id) }
        }
        bumpStateVersion()
        return hostSuccess(object, result: ["sandboxes": names.keys.filter { runtimes[$0] != nil }.count, "missing": names.keys.filter { runtimes[$0] == nil }.sorted(), "unknown": unknown.sorted()])
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
        return hostSuccess(object, result: result)
    }

    /// Lays down the sandbox the agent API reserved (at the asked size or this Mac's default) and boots it.
    private func create(_ object: [String: Any], sandboxID: String, input: [String: Any]) async -> Data {
        guard let name = input["name"] as? String, !name.isEmpty else { return hostFailure(object, code: "invalid_input", message: "sandbox.create requires name") }
        guard !sandboxID.contains("/"), !sandboxID.hasPrefix(".") else { return hostFailure(object, code: "invalid_input", message: "sandbox id \(sandboxID) is not a directory name") }
        var actions: [[String: Any]] = []
        var facts: [String: String] = [:]
        let runtime: SandboxRuntime
        let existing = runtimes[sandboxID]
        if let existing {
            // A relayed create re-run after a connector restart: the sandbox is already here.
            runtime = existing; await existing.setInCatalog(true); try? await existing.rename(name)
        } else {
            let fallback = defaultSize(hostCPUs: hostCPUs, hostMemoryBytes: hostMemoryBytes)
            var record = SandboxRecord(sandboxID: sandboxID, name: name, cpus: (input["cpus"] as? NSNumber)?.intValue ?? fallback.cpus, memoryBytes: (input["memory_bytes"] as? NSNumber)?.uint64Value ?? fallback.memoryBytes)
            let directory = SandboxDirectory(root.appendingPathComponent(sandboxID, isDirectory: true))
            do {
                try FileManager.default.createDirectory(at: directory.url, withIntermediateDirectories: true)
                facts = try factory.provision(&record, in: directory)
                try directory.save(record)
            } catch {
                try? FileManager.default.removeItem(at: directory.url)
                return hostFailure(object, code: "internal", message: "could not lay down \(name): \(explain(error))")
            }
            runtime = makeRuntime(record, directory); runtimes[sandboxID] = runtime
            bumpStateVersion()
            actions.append(["kind": "created", "detail": "created \(name) with \(record.cpus) CPUs and \(record.memoryBytes / (1024 * 1024 * 1024)) GiB" + (facts["disk"].map { "; disk \($0)" } ?? "")])
        }
        do { actions += try await start(runtime) { try await $0.bringUp() } }
        catch {
            if existing == nil { try? await runtime.stop(); runtimes[sandboxID] = nil; try? FileManager.default.removeItem(at: runtime.directory.url); bumpStateVersion() }
            if let refused = error as? AdmissionRefused { return machineFull(object, refused) }
            return hostFailure(object, code: "sandbox_not_ready", message: "\(name) could not start: \(explain(error))")
        }
        let sandbox = await runtime.snapshot()
        var produced: [String: Any] = ["sandbox_id": sandboxID, "name": name, "cpus": sandbox.record.cpus, "memory_bytes": sandbox.record.memoryBytes, "state": sandbox.status.lifecycle.sandboxState]
        for (key, value) in facts { produced[key] = Int(value).map { $0 as Any } ?? value }
        return hostSuccess(object, result: report(input, produced: produced, actions: actions))
    }

    /// What this Mac can still take (L9): reservation-based, not live free memory. Unlisted sandboxes still hold
    /// what they run with.
    private func capacity() async -> [String: Any] {
        let holding = await snapshots(includingUnlisted: true).filter(\.reservesMemory)
        let reserved = holding.map(\.record.memoryBytes).reduce(0, +)
        if lastReserved?.bytes != reserved || lastReserved?.running != holding.count { capacityRevision += 1; lastReserved = (reserved, holding.count) }
        return ["cpus": hostCPUs, "total_bytes": hostMemoryBytes, "reserved_bytes": reserved, "room_bytes": budgetBytes > reserved ? budgetBytes - reserved : 0, "running": holding.count, "revision": capacityRevision]
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

    /// Admission (L9): a start or wake of `sandboxID` (at `memoryBytes`, else its own size) must fit in the budget.
    /// If it does not, least-recently-used running sandboxes sleep until it does, never one running a job or serving a
    /// request; each is reported as `made_room`. Nothing sleeps unless the start then fits; otherwise this throws
    /// `AdmissionRefused` naming every sandbox that holds memory. Callers hold the admission lock.
    func admit(start sandboxID: String, memoryBytes: UInt64? = nil, makeRoom: Bool = true) async throws -> [SandboxAction] {
        guard let runtime = runtimes[sandboxID] else { throw HostDaemonError.invalidState("no sandbox \(sandboxID) on this machine") }
        let sandbox = await runtime.snapshot()
        if memoryBytes == nil, sandbox.reservesMemory { return [] }
        let needed = memoryBytes ?? sandbox.record.memoryBytes
        let others = await snapshots(includingUnlisted: true).filter { $0.record.sandboxID != sandboxID }
        let holding = others.filter { $0.reservesMemory || admitted.contains($0.record.sandboxID) }
        var reserved = holding.map(\.record.memoryBytes).reduce(0, +)
        guard reserved + needed > budgetBytes else { return [] }
        let candidates = holding.filter { $0.status.lifecycle == .ready && !admitted.contains($0.record.sandboxID) }
            .sorted { ($0.record.lastActivityAt ?? .distantPast, $0.record.sandboxID) < ($1.record.lastActivityAt ?? .distantPast, $1.record.sandboxID) }
        var jobs: [String: Int?] = [:]
        for candidate in candidates { jobs[candidate.record.sandboxID] = await runtimes[candidate.record.sandboxID]?.runningJobs() }
        var victims: [SandboxRuntime] = []
        for candidate in candidates where reserved + needed > budgetBytes && (jobs[candidate.record.sandboxID] ?? nil) == 0 {
            if let victim = runtimes[candidate.record.sandboxID] { victims.append(victim); reserved -= candidate.record.memoryBytes }
        }
        guard makeRoom, reserved + needed <= budgetBytes else {
            let holders = holding.map { AdmissionRefused.Holder(sandboxID: $0.record.sandboxID, name: $0.record.name, memoryBytes: $0.record.memoryBytes, runningJobs: jobs[$0.record.sandboxID] ?? nil) }
            let listed = holding.map { held -> String in
                let jobs = jobs[held.record.sandboxID] ?? nil
                let doing = held.status.lifecycle != .ready || admitted.contains(held.record.sandboxID) ? "starting" : jobs.map { $0 == 1 ? "1 running job" : "\($0) running jobs" } ?? "busy, or did not say whether it runs jobs"
                return "\(held.record.name) (\(gibibytes(held.record.memoryBytes)), \(doing))"
            }
            let total = holding.map(\.record.memoryBytes).reduce(0, +)
            throw AdmissionRefused(message: "\(sandbox.record.name) needs \(gibibytes(needed)), but sandboxes reserve \(gibibytes(total)) of this machine's \(gibibytes(budgetBytes)) and \(makeRoom ? "not enough of them can sleep" : "none is slept at daemon start"): \(listed.isEmpty ? "none running" : listed.joined(separator: ", "))", neededBytes: needed, budgetBytes: budgetBytes, reservedBytes: total, holders: holders)
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
        return hostFailure(object, code: "machine_full", message: refused.message, details: ["needed_bytes": refused.neededBytes, "budget_bytes": refused.budgetBytes, "reserved_bytes": refused.reservedBytes, "sandboxes": holders])
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

    /// Returns once the state version passes `since`, or at the timeout.
    private func waitForChange(since: Int, timeoutMs: Int) async {
        guard stateVersion <= since, timeoutMs > 0 else { return }
        let id = UUID()
        let timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeoutMs) * 1_000_000)
            await self?.releaseWatcher(id)
        }
        await withCheckedContinuation { continuation in watchers[id] = continuation }
        timer.cancel()
    }

    private func releaseWatcher(_ id: UUID) { watchers.removeValue(forKey: id)?.resume() }

    fileprivate func bumpStateVersion() {
        stateVersion += 1
        let waiting = watchers; watchers = [:]
        for continuation in waiting.values { continuation.resume() }
    }

    private static let connectorReportTTL: TimeInterval = 120

    private func hostSuccess(_ request: [String: Any], result: Any) -> Data {
        hostEnvelope(request, values: ["ok": true, "result": result])
    }

    private func hostFailure(_ request: [String: Any], code: String, message: String, details: [String: Any]? = nil) -> Data {
        var error: [String: Any] = ["code": code, "message": message, "retryable": false]
        if let details { error["details"] = details }
        return hostEnvelope(request, values: ["ok": false, "error": error])
    }

    private func hostEnvelope(_ request: [String: Any], values: [String: Any]) -> Data {
        let envelope: [String: Any] = [
            "protocol_version": request["protocol_version"] as? String ?? "v1",
            "request_id": request["request_id"] as? String ?? "unknown",
            "operation": request["operation"] as? String ?? "unknown",
            "sandbox_id": request["sandbox_id"] as? String as Any? ?? NSNull(),
            "release_id": "agent-computer-contract-v1",
        ].merging(values) { _, latest in latest }
        return (try? JSONSerialization.data(withJSONObject: envelope)) ?? Data("{}".utf8)
    }
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

public actor FakeGuestChannel: GuestChannel {
    private let handler: @Sendable (Data) async throws -> Data
    private(set) public var closed = false
    public private(set) var names: [String] = []
    public init(handler: @escaping @Sendable (Data) async throws -> Data) { self.handler = handler }
    public func send(_ envelope: Data) async throws -> Data { guard !closed else { throw HostDaemonError.guestUnavailable }; return try await handler(envelope) }
    public func rename(to name: String) { names.append(name) }
    public func close() { closed = true }
}

/// A VM that only records its lifecycle; its guest answers with `guest`, and `save` fails with `saveError` when set.
public actor FakeVMBackend: HibernateBackend, GuestChannelProvider {
    public private(set) var running = false
    private let guest: @Sendable (Data) async throws -> Data
    private let saveError: String?
    public init(saveError: String? = nil, guest: @escaping @Sendable (Data) async throws -> Data = { $0 }) { self.saveError = saveError; self.guest = guest }
    public func start() { running = true }
    public func stop() { running = false }
    public func pause() { running = false }
    public func resume() { running = true }
    public func save(to url: URL) throws {
        if let saveError { throw HostDaemonError.unsupported(saveError) }
        try Data("saved".utf8).write(to: url); running = false
    }
    public func restore(from url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { throw HostDaemonError.invalidState("saved machine state is missing") }
        running = true
    }
    public func makeGuestChannel() -> any GuestChannel { FakeGuestChannel(handler: guest) }
}

/// Makes `FakeVMBackend`s; `boots` counts the backends made, one per boot or restore.
public final class FakeBackendFactory: SandboxBackendFactory, @unchecked Sendable {
    private let lock = NSLock()
    private var made = 0
    private let saveError: String?
    private let guest: @Sendable (Data) async throws -> Data
    public init(saveError: String? = nil, guest: @escaping @Sendable (Data) async throws -> Data = { $0 }) { self.saveError = saveError; self.guest = guest }
    public var boots: Int { lock.lock(); defer { lock.unlock() }; return made }
    public func provision(_ record: inout SandboxRecord, in directory: SandboxDirectory) throws -> [String: String] { record.mac = randomLocalMAC(); return [:] }
    public func backend(for record: SandboxRecord, in directory: SandboxDirectory) throws -> any VMBackend {
        lock.lock(); made += 1; lock.unlock()
        return FakeVMBackend(saveError: saveError, guest: guest)
    }
}
