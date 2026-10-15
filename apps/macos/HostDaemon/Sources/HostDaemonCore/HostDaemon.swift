import Foundation

public enum DaemonLifecycle: String, Codable, Sendable {
    case firstRun = "first-run"
    case starting
    case ready
    case disconnected
    case paused
    case stopping
    case stopped
    case error

    /// The runtime state reported for each sandbox on it.
    var sandboxState: String {
        switch self {
        case .ready: return "running"
        case .paused: return "sleeping"
        case .firstRun, .stopped: return "stopped"
        default: return rawValue
        }
    }
}

public struct DaemonStatus: Codable, Equatable, Sendable {
    public let lifecycle: DaemonLifecycle
    public let channelEpoch: Int
    public let detail: String?
    public init(lifecycle: DaemonLifecycle, channelEpoch: Int = 0, detail: String? = nil) {
        self.lifecycle = lifecycle; self.channelEpoch = channelEpoch; self.detail = detail
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

/// A backend that can persist and restore a running VM without reprovisioning it.
public protocol HibernateBackend: VMBackend {
    func validateSaveRestoreSupport() async throws
    func save(to url: URL) async throws
    func restore(from url: URL) async throws
}

/// Backends that expose the guest's ordered virtio-serial byte stream use this
/// hook to attach it to the lifecycle owner after a successful VM start.
public protocol GuestChannelProvider: Sendable {
    func makeGuestChannel() async throws -> any GuestChannel
}

public protocol GuestReadinessProvider: Sendable {
    func waitUntilReady() async throws
}

public enum HostDaemonError: Error, CustomStringConvertible, Sendable {
    case invalidState(String)
    case unsupported(String)
    case guestUnavailable
    public var description: String {
        switch self { case .invalidState(let message), .unsupported(let message): return message; case .guestUnavailable: return "guest channel is unavailable" }
    }
}

/// The single owner of runtime lifecycle, guest-channel epoch, readiness and the sandbox identity mirror.
/// Until each sandbox gets its own runtime, every sandbox on this Mac shares the one runtime.
public actor HostDaemon {
    private let backend: any VMBackend
    private var channel: (any GuestChannel)?
    private var statusValue: DaemonStatus { didSet { if statusValue.lifecycle != oldValue.lifecycle { bumpStateVersion() } } }
    private var mirror: SandboxMirror
    /// Starts above 0 so a connector's first watch (`since: 0`) answers at once.
    private var stateVersion = 1
    private var watchers: [UUID: CheckedContinuation<Void, Never>] = [:]
    private var connectorReport: ConnectorReport?
    private let hostCPUs: Int
    private let hostMemoryBytes: UInt64
    private let now: @Sendable () -> Date
    /// `mirrorFile` persists the identity mirror; nil keeps it in memory. Host capacity defaults to this Mac's.
    public init(backend: any VMBackend, mirrorFile: URL? = nil, hostCPUs: Int? = nil, hostMemoryBytes: UInt64? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        self.backend = backend
        self.statusValue = DaemonStatus(lifecycle: .firstRun)
        self.mirror = SandboxMirror(file: mirrorFile)
        self.hostCPUs = hostCPUs ?? ProcessInfo.processInfo.activeProcessorCount
        self.hostMemoryBytes = hostMemoryBytes ?? ProcessInfo.processInfo.physicalMemory
        self.now = now
    }
    public func status() -> DaemonStatus { statusValue }
    public func sandboxes() -> [SandboxIdentity] { mirror.identities }
    public func attach(channel: any GuestChannel) {
        self.channel = channel
        statusValue = DaemonStatus(lifecycle: .ready, channelEpoch: statusValue.channelEpoch + 1)
    }
    public func start() async throws {
        if statusValue.lifecycle == .ready { return }
        if statusValue.lifecycle == .paused { try await resume(); return }
        guard statusValue.lifecycle == .firstRun || statusValue.lifecycle == .stopped || statusValue.lifecycle == .error else { throw HostDaemonError.invalidState("runtime cannot start from \(statusValue.lifecycle.rawValue)") }
        statusValue = DaemonStatus(lifecycle: .starting, channelEpoch: statusValue.channelEpoch)
        do {
            try await backend.start()
            if let provider = backend as? any GuestChannelProvider {
                let guestChannel = try await provider.makeGuestChannel()
                if let readiness = guestChannel as? any GuestReadinessProvider { try await readiness.waitUntilReady() }
                channel = guestChannel
            }
            statusValue = DaemonStatus(lifecycle: .ready, channelEpoch: statusValue.channelEpoch + 1)
        }
        catch { await channel?.close(); channel = nil; try? await backend.stop(); statusValue = DaemonStatus(lifecycle: .error, channelEpoch: statusValue.channelEpoch, detail: String(describing: error)); throw error }
    }
    public func pause() async throws { guard statusValue.lifecycle == .ready else { throw HostDaemonError.invalidState("runtime is not running") }; try await backend.pause(); statusValue = DaemonStatus(lifecycle: .paused, channelEpoch: statusValue.channelEpoch) }
    public func resume() async throws { guard statusValue.lifecycle == .paused else { throw HostDaemonError.invalidState("runtime is not asleep") }; try await backend.resume(); statusValue = DaemonStatus(lifecycle: .ready, channelEpoch: statusValue.channelEpoch + 1) }
    public func stop() async throws { guard statusValue.lifecycle != .stopped else { return }; statusValue = DaemonStatus(lifecycle: .stopping, channelEpoch: statusValue.channelEpoch); await channel?.close(); try await backend.stop(); channel = nil; statusValue = DaemonStatus(lifecycle: .stopped, channelEpoch: statusValue.channelEpoch + 1) }

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
            let states = mirror.identities.map { ["sandbox_id": $0.sandboxID, "state": statusValue.lifecycle.sandboxState, "cpus": $0.cpus, "memory_bytes": $0.memoryBytes] as [String: Any] }
            return hostSuccess(object, result: ["version": stateVersion, "lifecycle": statusValue.lifecycle.rawValue, "capacity": ["memory_bytes": hostMemoryBytes, "cpus": hostCPUs], "sandboxes": states])
        case "connector.report":
            guard let state = input["state"] as? String, !state.isEmpty else { return hostFailure(object, code: "invalid_input", message: "connector.report requires state") }
            connectorReport = ConnectorReport(state: state, detail: input["detail"] as? String, reportedAt: now())
            return hostSuccess(object, result: ["recorded": true])
        case "sandbox.mirror":
            guard let rows = input["sandboxes"] as? [[String: Any]] else { return hostFailure(object, code: "invalid_input", message: "sandbox.mirror requires sandboxes") }
            let catalog = rows.compactMap { row -> SandboxIdentity? in
                guard let id = row["sandbox_id"] as? String, let name = row["name"] as? String else { return nil }
                return SandboxIdentity(sandboxID: id, name: name, cpus: (row["cpus"] as? NSNumber)?.intValue ?? 2, memoryBytes: (row["memory_bytes"] as? NSNumber)?.uint64Value ?? 2 * 1024 * 1024 * 1024)
            }
            do { if try mirror.follow(catalog) { bumpStateVersion() } } catch { return hostFailure(object, code: "internal", message: "could not write the sandbox mirror: \(error)") }
            return hostSuccess(object, result: ["sandboxes": mirror.identities.count])
        default: break
        }
        let host = HostOperation(rawValue: operation)
        if host == .sandboxList { return hostSuccess(object, result: ["sandboxes": mirror.identities.map(view)]) }
        if host == .relayStatus { return relayStatus(object) }
        guard let sandboxID = object["sandbox_id"] as? String, !sandboxID.isEmpty else { return hostFailure(object, code: "invalid_input", message: "\(operation) needs a sandbox_id") }
        if host == .sandboxCreate { return await create(object, sandboxID: sandboxID, input: input) }
        guard let sandbox = mirror.find(sandboxID) else { return hostFailure(object, code: "sandbox_not_found", message: "no sandbox \(sandboxID) on this machine") }
        guard let host else { return try await forward(envelope) }
        switch host {
        case .sandboxCreate, .sandboxList: preconditionFailure("answered above")
        case .networkEgress: return try await forward(envelope)
        case .systemInfo:
            return hostSuccess(object, result: ["sandbox_id": sandboxID, "lifecycle": statusValue.lifecycle.rawValue, "channel_epoch": statusValue.channelEpoch, "runtime": "host"])
        case .sandboxStatus:
            var result = view(sandbox); result["lifecycle"] = statusValue.lifecycle.rawValue; result["channel_epoch"] = statusValue.channelEpoch
            if let detail = statusValue.detail { result["detail"] = detail }
            return hostSuccess(object, result: result)
        case .sandboxLogs:
            return hostSuccess(object, result: ["lines": statusValue.detail.map { [$0] } ?? []])
        case .sandboxRename:
            guard let name = input["name"] as? String, !name.isEmpty else { return hostFailure(object, code: "invalid_input", message: "sandbox.rename requires name") }
            var renamed = sandbox; renamed.name = name
            do { try mirror.upsert(renamed) } catch { return hostFailure(object, code: "internal", message: "could not write the sandbox mirror: \(error)") }
            bumpStateVersion()
            return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "name": name, "previous_name": sandbox.name], actions: [["kind": "renamed", "detail": "renamed \(sandbox.name) to \(name)"]]))
        case .sandboxResize:
            var resized = sandbox
            if let cpus = (input["cpus"] as? NSNumber)?.intValue { resized.cpus = cpus }
            if let memory = (input["memory_bytes"] as? NSNumber)?.uint64Value { resized.memoryBytes = memory }
            do { try mirror.upsert(resized) } catch { return hostFailure(object, code: "internal", message: "could not write the sandbox mirror: \(error)") }
            bumpStateVersion()
            return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "cpus": resized.cpus, "memory_bytes": resized.memoryBytes, "applies": "at the next cold boot"], actions: []))
        case .sandboxDelete:
            do { try mirror.remove(sandboxID) } catch { return hostFailure(object, code: "internal", message: "could not write the sandbox mirror: \(error)") }
            bumpStateVersion()
            return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "name": sandbox.name, "removed": ["sandbox identity"]], actions: [["kind": "deleted", "detail": "removed \(sandbox.name) from this machine"]]))
        case .sandboxStart:
            do {
                let action = try await bringUp()
                return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "state": statusValue.lifecycle.sandboxState], actions: action.map { [$0] } ?? []))
            } catch { return hostFailure(object, code: "conflict", message: String(describing: error)) }
        case .sandboxStop:
            do { try await stop(); return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "state": statusValue.lifecycle.sandboxState], actions: [])) }
            catch { return hostFailure(object, code: "conflict", message: String(describing: error)) }
        case .sandboxSleep:
            do { try await pause(); return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "state": statusValue.lifecycle.sandboxState], actions: [["kind": "slept", "detail": "\(sandbox.name) is asleep"]])) }
            catch { return hostFailure(object, code: "conflict", message: String(describing: error)) }
        case .relayStatus: return relayStatus(object)
        }
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

    /// Adds the sandbox the agent API reserved, at the asked size or this Mac's default, and starts the runtime if it is down.
    private func create(_ object: [String: Any], sandboxID: String, input: [String: Any]) async -> Data {
        guard let name = input["name"] as? String, !name.isEmpty else { return hostFailure(object, code: "invalid_input", message: "sandbox.create requires name") }
        let fallback = defaultSize(hostCPUs: hostCPUs, hostMemoryBytes: hostMemoryBytes)
        let cpus = (input["cpus"] as? NSNumber)?.intValue ?? fallback.cpus
        let memory = (input["memory_bytes"] as? NSNumber)?.uint64Value ?? fallback.memoryBytes
        do { try mirror.upsert(SandboxIdentity(sandboxID: sandboxID, name: name, cpus: cpus, memoryBytes: memory)) }
        catch { return hostFailure(object, code: "internal", message: "could not write the sandbox mirror: \(error)") }
        bumpStateVersion()
        var actions: [[String: Any]] = [["kind": "created", "detail": "created \(name) with \(cpus) CPUs and \(memory / (1024 * 1024 * 1024)) GiB"]]
        do { if let action = try await bringUp() { actions.append(action) } }
        catch { _ = try? mirror.remove(sandboxID); bumpStateVersion(); return hostFailure(object, code: "sandbox_not_ready", message: "\(name) could not start: \(error)") }
        return hostSuccess(object, result: report(input, produced: ["sandbox_id": sandboxID, "name": name, "cpus": cpus, "memory_bytes": memory, "state": statusValue.lifecycle.sandboxState], actions: actions))
    }

    /// Runs the runtime and says what that took: nothing, a wake, or a cold boot.
    private func bringUp() async throws -> [String: Any]? {
        switch statusValue.lifecycle {
        case .ready: return nil
        case .paused: try await resume(); return ["kind": "woke", "detail": "woke the runtime from sleep"]
        default: try await start(); return ["kind": "cold_booted", "detail": "cold-booted the runtime"]
        }
    }

    private func forward(_ envelope: Data) async throws -> Data {
        guard statusValue.lifecycle == .ready, let channel else { throw HostDaemonError.guestUnavailable }
        return try await channel.send(envelope)
    }

    private func view(_ sandbox: SandboxIdentity) -> [String: Any] {
        ["sandbox_id": sandbox.sandboxID, "name": sandbox.name, "cpus": sandbox.cpus, "memory_bytes": sandbox.memoryBytes, "state": statusValue.lifecycle.sandboxState]
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

    private func bumpStateVersion() {
        stateVersion += 1
        let waiting = watchers; watchers = [:]
        for continuation in waiting.values { continuation.resume() }
    }

    private static let connectorReportTTL: TimeInterval = 120

    private func hostSuccess(_ request: [String: Any], result: Any) -> Data {
        hostEnvelope(request, values: ["ok": true, "result": result])
    }

    private func hostFailure(_ request: [String: Any], code: String, message: String) -> Data {
        hostEnvelope(request, values: ["ok": false, "error": ["code": code, "message": message, "retryable": false]])
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

struct ConnectorReport: Sendable {
    let state: String
    let detail: String?
    let reportedAt: Date
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
