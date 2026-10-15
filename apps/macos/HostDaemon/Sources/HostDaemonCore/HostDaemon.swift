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
    public let detail: String?
    public init(lifecycle: DaemonLifecycle, vmID: String, channelEpoch: Int = 0, detail: String? = nil) {
        self.lifecycle = lifecycle; self.vmID = vmID; self.channelEpoch = channelEpoch; self.detail = detail
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

/// The single owner of VM lifecycle, guest-channel epoch, and readiness.
public actor HostDaemon {
    private let backend: any VMBackend
    private var channel: (any GuestChannel)?
    private var statusValue: DaemonStatus { didSet { if statusValue.lifecycle != oldValue.lifecycle { bumpStateVersion() } } }
    private var stateVersion = 0
    private var watchers: [UUID: CheckedContinuation<Void, Never>] = [:]
    private var connectorReport: ConnectorReport?
    private let now: @Sendable () -> Date
    public init(vmID: String = "vm_01", backend: any VMBackend, now: @escaping @Sendable () -> Date = { Date() }) {
        self.backend = backend
        self.statusValue = DaemonStatus(lifecycle: .firstRun, vmID: vmID)
        self.now = now
    }
    public func status() -> DaemonStatus { statusValue }
    public func attach(channel: any GuestChannel) {
        self.channel = channel
        statusValue = DaemonStatus(lifecycle: .ready, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch + 1)
    }
    public func start() async throws {
        if statusValue.lifecycle == .ready { return }
        if statusValue.lifecycle == .paused { try await resume(); return }
        guard statusValue.lifecycle == .firstRun || statusValue.lifecycle == .stopped else { throw HostDaemonError.invalidState("VM cannot start from \(statusValue.lifecycle.rawValue)") }
        statusValue = DaemonStatus(lifecycle: .starting, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch)
        do {
            try await backend.start()
            if let provider = backend as? any GuestChannelProvider {
                let guestChannel = try await provider.makeGuestChannel()
                if let readiness = guestChannel as? any GuestReadinessProvider { try await readiness.waitUntilReady() }
                channel = guestChannel
            }
            statusValue = DaemonStatus(lifecycle: .ready, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch + 1)
        }
        catch { await channel?.close(); channel = nil; try? await backend.stop(); statusValue = DaemonStatus(lifecycle: .error, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch, detail: String(describing: error)); throw error }
    }
    public func pause() async throws { guard statusValue.lifecycle == .ready else { throw HostDaemonError.invalidState("VM is not ready") }; try await backend.pause(); statusValue = DaemonStatus(lifecycle: .paused, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch) }
    public func resume() async throws { guard statusValue.lifecycle == .paused else { throw HostDaemonError.invalidState("VM is not paused") }; try await backend.resume(); statusValue = DaemonStatus(lifecycle: .ready, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch + 1) }
    public func stop() async throws { guard statusValue.lifecycle != .stopped else { return }; statusValue = DaemonStatus(lifecycle: .stopping, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch); await channel?.close(); try await backend.stop(); channel = nil; statusValue = DaemonStatus(lifecycle: .stopped, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch + 1) }
    public func reset(confirm: String) async throws { guard confirm == "RESET" else { throw HostDaemonError.invalidState("reset requires confirmation RESET") }; statusValue = DaemonStatus(lifecycle: .resetting, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch); await channel?.close(); try await backend.reset(); channel = nil; statusValue = DaemonStatus(lifecycle: .stopped, vmID: statusValue.vmID, channelEpoch: statusValue.channelEpoch + 1) }
    public func request(_ envelope: Data) async throws -> Data {
        guard let object = try? JSONSerialization.jsonObject(with: envelope) as? [String: Any],
              let operation = object["operation"] as? String,
              let vmID = object["vm_id"] as? String else {
            guard statusValue.lifecycle == .ready, let channel else { throw HostDaemonError.guestUnavailable }
            return try await channel.send(envelope)
        }
        // Machine-level operations for the connector; they are not in the public catalog and ignore vm_id.
        switch operation {
        case "host.watch":
            let input = object["input"] as? [String: Any] ?? [:]
            let since = (input["since"] as? NSNumber)?.intValue ?? 0
            let timeout = min(max((input["timeout_ms"] as? NSNumber)?.intValue ?? 25_000, 0), 50_000)
            await waitForChange(since: since, timeoutMs: timeout)
            return hostSuccess(object, result: ["version": stateVersion, "lifecycle": statusValue.lifecycle.rawValue, "capacity": ["memory_bytes": ProcessInfo.processInfo.physicalMemory, "cpus": ProcessInfo.processInfo.activeProcessorCount]])
        case "connector.report":
            guard let input = object["input"] as? [String: Any], let state = input["state"] as? String, !state.isEmpty else {
                return hostFailure(object, code: "invalid_input", message: "connector.report requires state")
            }
            connectorReport = ConnectorReport(state: state, detail: input["detail"] as? String, reportedAt: now())
            return hostSuccess(object, result: ["recorded": true])
        default: break
        }
        guard vmID == statusValue.vmID else { return hostFailure(object, code: "vm_not_found", message: "request VM does not match host") }
        switch operation {
        case "system.info":
            return hostSuccess(object, result: ["vm_id": statusValue.vmID, "lifecycle": statusValue.lifecycle.rawValue, "channel_epoch": statusValue.channelEpoch, "runtime": "host"])
        case "vm.list":
            return hostSuccess(object, result: ["vms": [["vm_id": statusValue.vmID, "status": statusValue.lifecycle.rawValue]]])
        case "vm.status":
            return hostSuccess(object, result: ["vm_id": statusValue.vmID, "status": statusValue.lifecycle.rawValue, "channel_epoch": statusValue.channelEpoch])
        case "vm.start":
            do { try await start(); return hostSuccess(object, result: ["vm_id": statusValue.vmID, "status": statusValue.lifecycle.rawValue]) }
            catch { return hostFailure(object, code: "conflict", message: String(describing: error)) }
        case "vm.stop":
            do { try await stop(); return hostSuccess(object, result: ["vm_id": statusValue.vmID, "status": statusValue.lifecycle.rawValue]) }
            catch { return hostFailure(object, code: "conflict", message: String(describing: error)) }
        case "vm.pause":
            do { try await pause(); return hostSuccess(object, result: ["vm_id": statusValue.vmID, "status": statusValue.lifecycle.rawValue]) }
            catch { return hostFailure(object, code: "conflict", message: String(describing: error)) }
        case "vm.reset":
            guard let input = object["input"] as? [String: Any], input["discard_state"] as? Bool == true, input["confirm"] as? String == "RESET" else {
                return hostFailure(object, code: "invalid_input", message: "reset requires discard_state=true and confirm=RESET")
            }
            do { try await reset(confirm: "RESET"); return hostSuccess(object, result: ["vm_id": statusValue.vmID, "status": statusValue.lifecycle.rawValue, "discarded": true]) }
            catch { return hostFailure(object, code: "conflict", message: String(describing: error)) }
        case "vm.logs":
            return hostSuccess(object, result: ["lines": statusValue.detail.map { [$0] } ?? []])
        case "relay.status":
            let fresh = connectorReport.map { now().timeIntervalSince($0.reportedAt) <= Self.connectorReportTTL } ?? false
            let state = fresh ? connectorReport!.state : "not_running"
            var result: [String: Any] = ["connector": state, "connected": state == "connected", "detail": NSNull(), "reported_at": NSNull()]
            if let report = connectorReport {
                result["reported_at"] = ISO8601DateFormatter().string(from: report.reportedAt)
                result["detail"] = fresh ? (report.detail as Any? ?? NSNull()) : "last connector report is older than 120 s"
            }
            return hostSuccess(object, result: result)
        default:
            guard statusValue.lifecycle == .ready, let channel else { throw HostDaemonError.guestUnavailable }
            return try await channel.send(envelope)
        }
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
            "vm_id": request["vm_id"] as? String ?? statusValue.vmID,
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
