import Foundation

/// An ActionReport action (P1): what a request did on the way, e.g. `["kind": "woke", "detail": …]`.
public typealias SandboxAction = [String: String]

/// Makes the per-sandbox pieces a backend needs: the directory's contents at create, and a backend for each boot.
public protocol SandboxBackendFactory: Sendable {
    /// Lays down a new sandbox's directory (a disk clone, a guest root) and the runtime identity it boots with.
    /// Returns facts for the create report, e.g. `disk: cloned`.
    func provision(_ record: inout SandboxRecord, in directory: SandboxDirectory) throws -> [String: String]
    /// A fresh backend for one boot, configured from the record as it is now.
    func backend(for record: SandboxRecord, in directory: SandboxDirectory) throws -> any VMBackend
}

/// One sandbox's runtime: its backend, guest channel, channel epoch and lifecycle, and the record that brings it back
/// after a daemon restart. `SandboxHost` routes every sandbox-scoped request to it by id.
public actor SandboxRuntime {
    public let directory: SandboxDirectory
    public private(set) var record: SandboxRecord
    private let factory: any SandboxBackendFactory
    private var backend: (any VMBackend)?
    private var channel: (any GuestChannel)?
    private var statusValue = RuntimeStatus(lifecycle: .stopped)
    /// What the last bring-up did (woke or cold_booted, and why), for status and logs.
    private var lastBoot: SandboxAction?
    /// Agent requests the guest is serving now; a sandbox in the middle of one is never slept to make room.
    private var inFlight = 0
    private let onChange: @Sendable () -> Void
    private let now: @Sendable () -> Date

    init(record: SandboxRecord, directory: SandboxDirectory, factory: any SandboxBackendFactory, now: @escaping @Sendable () -> Date, onChange: @escaping @Sendable () -> Void) {
        self.record = record; self.directory = directory; self.factory = factory; self.now = now; self.onChange = onChange
    }

    public func status() -> RuntimeStatus { statusValue }
    func snapshot() -> RuntimeSnapshot { RuntimeSnapshot(record: record, status: statusValue, lastBoot: lastBoot) }

    /// Runs the sandbox and says what that took: nothing, a wake, a restore from saved state, or a cold boot.
    public func bringUp() async throws -> SandboxAction? {
        switch statusValue.lifecycle {
        case .ready: return nil
        case .paused: try await resume(); return ["kind": "woke", "detail": "woke \(record.name) from sleep"]
        default: break
        }
        if record.lifecycle == .hibernated, FileManager.default.fileExists(atPath: directory.savedState.path) {
            do { try await restore(); return remember(["kind": "woke", "detail": "restored \(record.name) from its saved state"]) }
            catch { record.coldBootPending = "could not restore its saved state: \(explain(error))" }
        }
        let reason = record.coldBootPending
        try await coldBoot()
        return remember(["kind": "cold_booted", "detail": reason.map { "cold-booted \(record.name): \($0)" } ?? "cold-booted \(record.name)"])
    }

    /// Whether the daemon's start brings this sandbox back: it was running, hibernated or is owed a cold boot.
    var owesRecovery: Bool { record.lifecycle != .stopped || record.coldBootPending != nil }

    /// At daemon start: bring back what was running, hibernated or owed a cold boot; a sandbox stopped on purpose stays down.
    func recover() async throws -> SandboxAction? {
        if (record.lifecycle == .running || record.lifecycle == .sleeping) && record.coldBootPending == nil { record.coldBootPending = "the daemon exited without saving it" }
        guard owesRecovery else { return nil }
        return try await bringUp()
    }

    private func remember(_ action: SandboxAction) -> SandboxAction { lastBoot = action; return action }

    private func coldBoot() async throws {
        guard [.stopped, .error].contains(statusValue.lifecycle) else { throw HostDaemonError.invalidState("\(record.name) cannot start from \(statusValue.lifecycle.rawValue)") }
        // A cold boot changes the disk under any saved state, so that state could never be restored safely again.
        try? FileManager.default.removeItem(at: directory.savedState)
        try await boot { try await $0.start() }
    }

    private func restore() async throws {
        try await boot { backend in
            guard let hibernate = backend as? any HibernateBackend else { throw HostDaemonError.unsupported("this backend cannot restore saved state") }
            try await hibernate.restore(from: self.directory.savedState)
        }
        try? FileManager.default.removeItem(at: directory.savedState)
    }

    private func boot(_ run: (any VMBackend) async throws -> Void) async throws {
        setStatus(.starting)
        let next: any VMBackend
        do { next = try factory.backend(for: record, in: directory) } catch { setStatus(.error, detail: explain(error)); throw error }
        do {
            try await run(next)
            backend = next
            if let provider = next as? any GuestChannelProvider {
                let guestChannel = try await provider.makeGuestChannel()
                if let readiness = guestChannel as? any GuestReadinessProvider { try await readiness.waitUntilReady() }
                channel = guestChannel
            }
            // A boot counts as activity, so a sandbox that was just started is not the first slept to make room.
            record.coldBootPending = nil; record.lifecycle = .running; record.lastActivityAt = now(); persist()
            setStatus(.ready, epoch: statusValue.channelEpoch + 1)
        } catch {
            await channel?.close(); channel = nil; backend = nil; try? await next.stop()
            setStatus(.error, detail: explain(error)); throw error
        }
    }

    public func pause() async throws {
        guard statusValue.lifecycle == .ready, let backend else { throw HostDaemonError.invalidState("\(record.name) is not running") }
        try await backend.pause(); setStatus(.paused)
    }

    public func resume() async throws {
        guard statusValue.lifecycle == .paused, let backend else { throw HostDaemonError.invalidState("\(record.name) is not asleep") }
        try await backend.resume(); record.lastActivityAt = now(); setStatus(.ready, epoch: statusValue.channelEpoch + 1)
    }

    public func stop() async throws {
        guard statusValue.lifecycle != .stopped else { return }
        setStatus(.stopping)
        await channel?.close(); channel = nil
        try await backend?.stop(); backend = nil
        try? FileManager.default.removeItem(at: directory.savedState)
        setStatus(.stopped, epoch: statusValue.channelEpoch + 1)
    }

    /// SIGTERM (D11) and admission: save a running or sleeping sandbox so the next start restores it; where saving
    /// fails or the backend cannot save, stop it and owe it a cold boot that reports why. Returns why it was not
    /// saved, or nil when it was.
    @discardableResult func hibernate() async -> String? {
        guard statusValue.lifecycle == .ready || statusValue.lifecycle == .paused, let backend else { return nil }
        let failure: String, reason: String
        if let saver = backend as? any HibernateBackend {
            do {
                if statusValue.lifecycle == .paused { try await resume() }
                try await saver.save(to: directory.savedState)
                await channel?.close(); channel = nil; self.backend = nil
                setStatus(.stopped)
                record.lifecycle = .hibernated; persist()
                return nil
            } catch { failure = explain(error); reason = "could not save its state: \(failure)" }
        } else {
            failure = "the process fixture cannot save its state"; reason = "fixture: \(failure)"
        }
        try? await stop()
        record.coldBootPending = reason; persist()
        return failure
    }

    /// Frees this sandbox's memory for another start (admission, L9) and says how. A VM sleeps by hibernating, the
    /// same path as SIGTERM, so a failed save (a locked screen) stops it and owes it a cold boot. The process
    /// fixture cannot save, so it sleeps with SIGSTOP, which admission counts as freed.
    func sleepForRoom() async throws -> String {
        guard statusValue.lifecycle == .ready, let backend else { throw HostDaemonError.invalidState("\(record.name) is not running") }
        let size = "\(record.name) (\(gibibytes(record.memoryBytes)))"
        guard backend is any HibernateBackend else { try await pause(); return "slept \(size) to make room" }
        if let failure = await hibernate() { return "stopped \(size) to make room: \(failure)" }
        return "slept \(size) to make room"
    }

    /// The guest's running Localbox jobs (`guest.activity`), or nil when it is serving a request or does not say.
    /// Asking is not activity, so it leaves `lastActivityAt` alone.
    func runningJobs() async -> Int? {
        guard statusValue.lifecycle == .ready, inFlight == 0, let channel else { return nil }
        let id = "admission-\(UUID().uuidString)"
        guard let request = try? JSONSerialization.data(withJSONObject: ["protocol_version": "v1", "request_id": id, "operation": "guest.activity", "sandbox_id": record.sandboxID, "deadline_ms": 5_000, "mutation_id": NSNull(), "input": [String: Any]()]),
              let response = try? await channel.send(request),
              let object = try? JSONSerialization.jsonObject(with: response) as? [String: Any],
              let jobs = (object["result"] as? [String: Any])?["running_jobs"] as? NSNumber else { return nil }
        return jobs.intValue
    }

    public func forward(_ envelope: Data) async throws -> Data {
        guard statusValue.lifecycle == .ready, let channel else { throw HostDaemonError.guestUnavailable }
        record.lastActivityAt = now()
        inFlight += 1; defer { inFlight -= 1 }
        return try await channel.send(envelope)
    }

    /// A running guest takes the new name as its hostname at once, through a new hello.
    func rename(_ name: String) async throws {
        guard name != record.name else { return }
        record.name = name; persist()
        if statusValue.lifecycle == .ready { try await channel?.rename(to: name) }
    }

    func setInCatalog(_ listed: Bool) {
        guard record.inCatalog != listed else { return }
        record.inCatalog = listed; persist(); onChange()
    }

    /// A size takes effect at boot, so a running sandbox restarts; the action names the processes that ended.
    func resize(cpus: Int?, memoryBytes: UInt64?) async throws -> SandboxAction? {
        let cpus = cpus ?? record.cpus, memory = memoryBytes ?? record.memoryBytes
        guard cpus != record.cpus || memory != record.memoryBytes else { return nil }
        guard statusValue.lifecycle == .ready || statusValue.lifecycle == .paused else {
            record.cpus = cpus; record.memoryBytes = memory; persist(); onChange(); return nil
        }
        if statusValue.lifecycle == .paused { try await resume() }
        let ended = (try? await guestProcesses()) ?? []
        try await stop()
        record.cpus = cpus; record.memoryBytes = memory; persist()
        try await coldBoot()
        let commands = Array(Set(ended)).sorted()
        let listed = commands.isEmpty ? "" : ": \(commands.prefix(20).joined(separator: ", "))\(commands.count > 20 ? ", …" : "")"
        return ["kind": "restarted", "detail": "restarted \(record.name) at \(cpus) CPUs and \(gibibytes(memory)); \(ended.count) process\(ended.count == 1 ? "" : "es") ended\(listed)"]
    }

    /// The guest's user processes, by command, leaving out kernel threads and the guest agent serving this request.
    private func guestProcesses() async throws -> [String] {
        // `ps` where the image has it, else /proc (kernel threads have an empty cmdline there). Both print "pid ppid args".
        let script = #"echo $$; if command -v ps >/dev/null 2>&1; then ps -eo pid=,ppid=,args=; else for d in /proc/[0-9]*; do c=$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null); [ -n "$c" ] && echo "${d#/proc/} $(awk '/^PPid/{print $2}' "$d/status") $c"; done; fi"#
        let id = "resize-\(UUID().uuidString)"
        let request = try JSONSerialization.data(withJSONObject: ["protocol_version": "v1", "request_id": id, "operation": "shell.exec", "sandbox_id": record.sandboxID, "deadline_ms": 15_000, "mutation_id": id, "input": ["command": script]])
        let response = try JSONSerialization.jsonObject(with: try await forward(request)) as? [String: Any]
        guard let stdout = (response?["result"] as? [String: Any])?["stdout"] as? String else { throw HostDaemonError.unsupported("the guest did not list its processes") }
        var lines = stdout.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let shell = lines.isEmpty ? nil : lines.removeFirst() else { return [] }
        return lines.compactMap { line in
            let fields = line.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true).map(String.init)
            guard fields.count == 3, fields[0] != shell, fields[1] != shell, !fields[2].hasPrefix("[") else { return nil }
            let args = fields[2]
            if args.contains("guest-agent") || args.contains("VSOCK-LISTEN") { return nil }
            return URL(fileURLWithPath: String(args.split(separator: " ").first ?? "")).lastPathComponent
        }
    }

    private func setStatus(_ lifecycle: RuntimeLifecycle, epoch: Int? = nil, detail: String? = nil) {
        let changed = lifecycle != statusValue.lifecycle
        statusValue = RuntimeStatus(lifecycle: lifecycle, channelEpoch: epoch ?? statusValue.channelEpoch, detail: detail)
        if let saved = lifecycle.saved, saved != record.lifecycle { record.lifecycle = saved; persist() }
        if changed { onChange() }
    }

    /// The record is the only state that outlives the daemon; a failed write surfaces in the next status read.
    private func persist() {
        do { try directory.save(record) } catch { statusValue = RuntimeStatus(lifecycle: statusValue.lifecycle, channelEpoch: statusValue.channelEpoch, detail: "could not write \(directory.recordFile.path): \(explain(error))") }
    }
}

/// A runtime as `SandboxHost` reports it, read in one hop.
struct RuntimeSnapshot: Sendable {
    let record: SandboxRecord
    let status: RuntimeStatus
    let lastBoot: SandboxAction?
    /// Admission counts a sandbox's memory while it starts or runs; a sleeping one has given it back (L9).
    var reservesMemory: Bool { [.starting, .ready].contains(status.lifecycle) }
}
