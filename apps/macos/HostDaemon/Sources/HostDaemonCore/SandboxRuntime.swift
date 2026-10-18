import Foundation

/// An ActionReport action: what a request did on the way, e.g. `["kind": "woke", "detail": …]`.
public typealias SandboxAction = [String: String]

/// Makes the per-sandbox pieces a backend needs: the directory's contents at create, and a backend for each boot.
public protocol SandboxBackendFactory: Sendable {
    /// Lays down a new sandbox's directory (a disk clone, a guest root) and the runtime identity it boots with.
    /// Returns facts for the create report, e.g. `disk: cloned`.
    func provision(_ record: inout SandboxRecord, in directory: SandboxDirectory) throws -> [String: String]
    /// A fresh backend for one boot, configured from the record as it is now.
    func backend(for record: SandboxRecord, in directory: SandboxDirectory) throws -> any SandboxBackend
}

/// One sandbox's runtime: its backend, guest channel, channel epoch and lifecycle, and the record that brings it back
/// after a daemon restart. `SandboxHost` routes every sandbox-scoped request to it by id.
public actor SandboxRuntime {
    public let directory: SandboxDirectory
    public private(set) var record: SandboxRecord
    private let factory: any SandboxBackendFactory
    private var backend: (any SandboxBackend)?
    private var channel: (any GuestChannel)?
    private var statusValue = RuntimeStatus(lifecycle: .stopped)
    /// What the last bring-up did (woke or cold_booted, and why), for status and logs.
    private var lastBoot: SandboxAction?
    /// Agent requests the guest is serving now; a sandbox in the middle of one is never slept.
    private var inFlight = 0
    /// When `guest.activity` last showed a running job; idle time runs from this or the last request, if later.
    private var busyAt: Date?
    /// The last `guest.activity` showed a running job, so the idle policy asks again every second.
    private(set) var watchingJobs = false
    /// Boots and wakes no request asked for (at daemon start, when the Mac wakes), reported with the next result.
    private var unreported: [SandboxAction] = []
    /// The bring-up or restart in flight: later bring-ups wait for it instead of booting the same disk again, and a
    /// stop cancels it.
    private var booting: Task<SandboxAction?, Error>?
    /// Counts boots, so a stop notice from an earlier boot's backend is ignored.
    private var bootCount = 0
    /// Deleted: nothing boots it again and its record is never written, so its directory stays gone.
    private var discarded = false
    private let onChange: @Sendable () -> Void
    private let now: @Sendable () -> Date

    init(record: SandboxRecord, directory: SandboxDirectory, factory: any SandboxBackendFactory, now: @escaping @Sendable () -> Date, onChange: @escaping @Sendable () -> Void) {
        self.record = record; self.directory = directory; self.factory = factory; self.now = now; self.onChange = onChange
        // Asleep in memory when the daemon ended: the processes are gone, so the next use cold-boots it.
        if record.lifecycle == .sleeping { self.record.lifecycle = .asleep; self.record.coldBootPending = "the daemon exited while it slept in memory" }
        if self.record.lifecycle == .asleep { statusValue = RuntimeStatus(lifecycle: .asleep) }
        directory.removeTemporarySaves()
    }

    public func status() -> RuntimeStatus { statusValue }
    func snapshot() -> RuntimeSnapshot {
        RuntimeSnapshot(record: record, status: statusValue, lastBoot: lastBoot, pauseKeepsMemory: backend is any HibernateBackend)
    }

    /// Runs the sandbox and says what that took: nothing, a wake, a restore from saved state, or a cold boot. One
    /// bring-up runs at a time; a caller that finds one in flight (or a sleep or stop settling) waits for it.
    public func bringUp() async throws -> SandboxAction? {
        while true {
            if let booting { _ = try await booting.value; return nil }
            guard statusValue.lifecycle == .stopping else { break }
            guard await settled() != .stopping else { throw HostDaemonError.invalidState("\(record.name) is still stopping") }
        }
        return try await flight { try await $0.wake() }
    }

    /// Runs `body` as the one bring-up in flight.
    private func flight(_ body: @escaping @Sendable (SandboxRuntime) async throws -> SandboxAction?) async throws -> SandboxAction? {
        while let booting { _ = try? await booting.value }
        guard !discarded else { throw HostDaemonError.invalidState("\(record.name) was deleted") }
        let task = Task { try await body(self) }
        booting = task; defer { booting = nil }
        return try await task.value
    }

    private func wake() async throws -> SandboxAction? {
        switch statusValue.lifecycle {
        case .ready: return nil
        case .paused: try await resume(); return ["kind": "woke", "detail": "woke \(record.name) from sleep"]
        default: break
        }
        if [.hibernated, .asleep].contains(record.lifecycle), FileManager.default.fileExists(atPath: directory.savedState.path) {
            do { try await restore(); return remember(["kind": "woke", "detail": "restored \(record.name) from its saved state"]) }
            catch { record.coldBootPending = "could not restore its saved state: \(explain(error))" }
        }
        let reason = record.coldBootPending
        try await coldBoot()
        return remember(["kind": "cold_booted", "detail": reason.map { "cold-booted \(record.name): \($0)" } ?? "cold-booted \(record.name)"])
    }

    /// Whether the daemon's start brings this sandbox back: it was running, hibernated or is owed a cold boot. An
    /// asleep sandbox waits for a request, and one stopped on purpose stays down.
    var owesRecovery: Bool { [.running, .hibernated].contains(record.lifecycle) || (record.lifecycle == .stopped && record.coldBootPending != nil) }

    /// At daemon start: bring back what owes recovery. No request asked for it, so the next result reports it.
    func recover() async throws -> SandboxAction? {
        if record.lifecycle == .running && record.coldBootPending == nil { record.coldBootPending = "the daemon exited without saving it" }
        guard owesRecovery else { return nil }
        let action = try await bringUp()
        if let action { unreported.append(action) }
        return action
    }

    /// A boot or wake no request asked for, reported with the sandbox's next result.
    func report(_ action: SandboxAction) { unreported.append(action) }

    /// Hands over (once) what happened without a request since the last result.
    func takeUnreported() -> [SandboxAction] { defer { unreported = [] }; return unreported }

    private func remember(_ action: SandboxAction) -> SandboxAction { lastBoot = action; return action }

    private func coldBoot() async throws {
        guard [.stopped, .error, .asleep].contains(statusValue.lifecycle) else { throw HostDaemonError.invalidState("\(record.name) cannot start from \(statusValue.lifecycle.rawValue)") }
        // A VM whose stop failed may still run on this disk; it goes first.
        if let stale = backend { try await stale.stop(); backend = nil }
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

    private func boot(_ run: (any SandboxBackend) async throws -> Void) async throws {
        setStatus(.starting)
        let next: any SandboxBackend
        do { next = try factory.backend(for: record, in: directory) } catch { setStatus(.error, detail: explain(error)); throw error }
        bootCount += 1
        if let reporting = next as? any GuestStopReporting {
            let boot = bootCount
            await reporting.onGuestStop { [weak self] reason in Task { await self?.guestLost(reason, boot: boot) } }
        }
        do {
            try await run(next)
            backend = next
            if let provider = next as? any GuestChannelProvider {
                let guestChannel = try await provider.makeGuestChannel()
                if let readiness = guestChannel as? any GuestReadinessProvider { try await readiness.waitUntilReady() }
                channel = guestChannel
            }
            // A stop (a delete) during the boot cancels it; the VM it made goes down with it.
            try Task.checkCancellation()
            // A boot counts as activity, so a sandbox that was just started is not the first slept to make room.
            record.coldBootPending = nil; record.lifecycle = .running; record.lastActivityAt = now(); persist()
            setStatus(.ready, epoch: statusValue.channelEpoch + 1)
        } catch {
            await channel?.close(); channel = nil; backend = nil; try? await next.stop()
            let failure = Task.isCancelled ? HostDaemonError.invalidState("\(record.name) was stopped while it started") : error
            setStatus(.error, detail: explain(failure)); throw failure
        }
    }

    /// The guest went away on its own (powered off, panicked, or its agent closed the channel): the sandbox is down,
    /// not running, until it is started again.
    private func guestLost(_ reason: String, boot: Int) async {
        guard boot == bootCount, let lost = backend, [.ready, .paused].contains(statusValue.lifecycle) else { return }
        backend = nil; setStatus(.stopping)
        await channel?.close(); channel = nil
        try? await lost.stop()
        setStatus(.error, epoch: statusValue.channelEpoch + 1, detail: reason)
    }

    public func pause() async throws {
        guard statusValue.lifecycle == .ready, let backend else { throw HostDaemonError.invalidState("\(record.name) is not running") }
        try await backend.pause(); setStatus(.paused)
    }

    public func resume() async throws {
        guard statusValue.lifecycle == .paused, let backend else { throw HostDaemonError.invalidState("\(record.name) is not asleep") }
        try await backend.resume(); record.lastActivityAt = now(); setStatus(.ready, epoch: statusValue.channelEpoch + 1)
    }

    /// Stops it, cancelling a boot in flight, and ends stopped; where the backend cannot stop it, it ends in error
    /// and keeps the backend, so the next stop or start tries again.
    public func stop() async throws {
        if let booting { booting.cancel(); _ = try? await booting.value }
        if statusValue.lifecycle == .stopping { _ = await settled() }
        guard statusValue.lifecycle != .stopped else { return }
        try await halt()
    }

    /// Deleting: stops it and keeps it down, and its record is never written again.
    func discard() async { discarded = true; try? await stop() }

    private func halt() async throws {
        setStatus(.stopping)
        await channel?.close(); channel = nil
        if let running = backend {
            backend = nil
            do { try await running.stop() } catch {
                backend = running
                setStatus(.error, epoch: statusValue.channelEpoch + 1, detail: "could not stop: \(explain(error))"); throw error
            }
        }
        try? FileManager.default.removeItem(at: directory.savedState)
        // Stopped on purpose: nothing is owed at the next start.
        record.coldBootPending = nil
        setStatus(.stopped, epoch: statusValue.channelEpoch + 1)
        persist()
    }

    /// Saves the VM and lets it go. On failure the VM keeps running (the backend resumes it).
    private func save(_ saver: any HibernateBackend) async throws {
        if statusValue.lifecycle == .paused { try await saver.resume() }
        try await saver.save(to: directory.savedState)
        await channel?.close(); channel = nil; backend = nil
    }

    /// SIGTERM and power-off: save a running or sleeping sandbox so the next start restores it; where saving
    /// fails or the backend cannot save, stop it and owe it a cold boot that reports why. Returns why it was not
    /// saved, or nil when it was.
    @discardableResult func hibernate() async -> String? {
        guard statusValue.lifecycle == .ready || statusValue.lifecycle == .paused, let backend else { return nil }
        let failure: String, reason: String
        if let saver = backend as? any HibernateBackend {
            do {
                if statusValue.lifecycle == .paused { try await saver.resume() }
                // Stopping, as a sleep is, so a request that loses its channel to the save is not taken for the guest dying.
                setStatus(.stopping)
                try await save(saver)
                setStatus(.asleep, epoch: statusValue.channelEpoch + 1)
                record.lifecycle = .hibernated; persist()
                return nil
            } catch { failure = explain(error); reason = "could not save its state: \(failure)" }
        } else {
            failure = "the process fixture cannot save its state"; reason = "fixture: \(failure)"
        }
        // Not stop(): no boot is in flight here, and stop() would wait out this hibernate's own stopping status.
        try? await halt()
        record.coldBootPending = reason; persist()
        return failure
    }

    /// Sleep: hibernate, saving the VM's state and releasing its memory, so the next use restores every process.
    /// The process fixture cannot save and pauses with SIGSTOP, which admission counts as freed. Where saving fails
    /// (the screen is locked on a Mac whose lock asks for a password), the VM pauses in memory and keeps its RAM.
    /// `power`: the Mac is going to sleep, so a sandbox serving a request sleeps too, and a saved one comes back
    /// when the Mac wakes or the daemon starts.
    func sleep(power: Bool = false) async throws -> SandboxAction {
        guard statusValue.lifecycle == .ready, let backend else { throw HostDaemonError.invalidState("\(record.name) is not running") }
        guard power || inFlight == 0 else { throw HostDaemonError.invalidState("\(record.name) is serving a request") }
        let name = record.name
        guard let saver = backend as? any HibernateBackend else {
            try await pause()
            return ["kind": "slept", "detail": "paused \(name) (the process fixture sleeps with SIGSTOP)"]
        }
        // Requests that arrive meanwhile wait for the sleep to settle, then wake the sandbox.
        setStatus(.stopping)
        do {
            try await save(saver)
            setStatus(.asleep, epoch: statusValue.channelEpoch + 1, detail: "hibernated: state saved, memory released")
            record.lifecycle = power ? .hibernated : .asleep; persist()
            return ["kind": "slept", "detail": "hibernated \(name): saved its state and released its \(gibibytes(record.memoryBytes))"]
        } catch {
            let why: String
            if case HostDaemonError.screenLocked? = error as? HostDaemonError { why = "hibernate needs an unlocked screen" } else { why = "could not save its state: \(explain(error))" }
            do { try await backend.pause() } catch { setStatus(.ready, detail: "could not sleep: \(why)"); throw error }
            setStatus(.paused, detail: "paused in memory: \(why)")
            return ["kind": "slept", "detail": "paused \(name) in memory: \(why)"]
        }
    }

    /// Frees this sandbox's memory for another start (admission) and says how. A VM hibernates; where saving fails
    /// (a locked screen) it stops and owes a cold boot at its next use, since pausing would keep its memory. The process
    /// fixture cannot save, so it sleeps with SIGSTOP, which admission counts as freed.
    func sleepForRoom() async throws -> String {
        guard statusValue.lifecycle == .ready || statusValue.lifecycle == .paused, let backend else { throw HostDaemonError.invalidState("\(record.name) is not running") }
        let size = "\(record.name) (\(gibibytes(record.memoryBytes)))"
        guard let saver = backend as? any HibernateBackend else { try await pause(); return "slept \(size) to make room" }
        setStatus(.stopping)
        do {
            try await save(saver)
            setStatus(.asleep, epoch: statusValue.channelEpoch + 1)
            record.lifecycle = .asleep; persist()
            return "slept \(size) to make room"
        } catch {
            let failure = explain(error)
            try? await stop()
            record.lifecycle = .asleep; record.coldBootPending = "could not save its state: \(failure)"
            setStatus(.asleep); persist()
            return "stopped \(size) to make room: \(failure)"
        }
    }

    /// When idle time started: the last request, boot, wake or running job; nil while a request is in flight or
    /// before the first boot.
    func idleSince() -> Date? {
        guard inFlight == 0, let last = record.lastActivityAt else { return nil }
        return max(last, busyAt ?? last)
    }

    /// What `guest.activity` said: a running job means the sandbox is not idle, and the idle policy keeps asking every
    /// second until the jobs end, so idle time starts when they did.
    func looked(runningJobs jobs: Int) { if jobs > 0 { busyAt = now() }; watchingJobs = jobs > 0 }

    /// Waits out a start or stop in progress (a wake, a sleep), so a request sees where the sandbox settled.
    func settled() async -> RuntimeLifecycle {
        for _ in 0..<2_400 where [.starting, .stopping].contains(statusValue.lifecycle) { try? await Task.sleep(nanoseconds: 50_000_000) }
        return statusValue.lifecycle
    }

    /// The idle policy the account catalog holds for this sandbox.
    func setPolicy(sleepAfterMs: Int, deleteAfterMs: Int?) {
        guard sleepAfterMs != record.sleepAfterMs || deleteAfterMs != record.deleteAfterMs else { return }
        record.sleepAfterMs = sleepAfterMs; record.deleteAfterMs = deleteAfterMs; persist()
    }

    /// The guest's running Localbox jobs (`guest.activity`), or nil when it is serving a request or does not say.
    /// Asking is not activity, so it leaves `lastActivityAt` alone.
    func runningJobs() async -> Int? {
        guard statusValue.lifecycle == .ready, inFlight == 0, let channel else { return nil }
        let id = "admission-\(UUID().uuidString)"
        guard let request = try? JSONSerialization.data(withJSONObject: ["protocol_version": protocolVersion, "request_id": id, "operation": "guest.activity", "sandbox_id": record.sandboxID, "deadline_ms": 5_000, "mutation_id": NSNull(), "input": [String: Any]()]),
              let response = try? await send(request, on: channel),
              let object = try? JSONSerialization.jsonObject(with: response) as? [String: Any],
              let jobs = (object["result"] as? [String: Any])?["running_jobs"] as? NSNumber else { return nil }
        return jobs.intValue
    }

    public func forward(_ envelope: Data) async throws -> Data {
        guard statusValue.lifecycle == .ready, let channel else { throw HostDaemonError.guestUnavailable }
        record.lastActivityAt = now()
        inFlight += 1; defer { inFlight -= 1 }
        return try await send(envelope, on: channel)
    }

    /// A channel that closes under a ready sandbox (not one this runtime closed) means the guest agent is gone.
    private func send(_ envelope: Data, on channel: any GuestChannel) async throws -> Data {
        let boot = bootCount, epoch = statusValue.channelEpoch
        do { return try await channel.send(envelope) } catch HostDaemonError.guestUnavailable {
            if statusValue.lifecycle == .ready, statusValue.channelEpoch == epoch { await guestLost("the guest agent closed its channel", boot: boot) }
            throw HostDaemonError.guestUnavailable
        }
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

    /// Records the machine whose catalog listed this sandbox (see `SandboxRecord.listedBy`).
    func setListedBy(_ machineID: String) {
        guard record.listedBy != machineID else { return }
        record.listedBy = machineID; persist()
    }

    /// A size takes effect at boot, so a running sandbox restarts; the action names the processes that ended.
    func resize(cpus: Int?, memoryBytes: UInt64?) async throws -> SandboxAction? {
        let cpus = cpus ?? record.cpus, memory = memoryBytes ?? record.memoryBytes
        guard cpus != record.cpus || memory != record.memoryBytes else { return nil }
        guard cpus > 0, memory > 0 else { throw HostDaemonError.invalidState("a sandbox needs at least one CPU and some memory") }
        guard statusValue.lifecycle == .ready || statusValue.lifecycle == .paused else {
            record.cpus = cpus; record.memoryBytes = memory
            // A saved state only restores at the size it was saved with, so an asleep sandbox wakes with a cold boot.
            if statusValue.lifecycle == .asleep, FileManager.default.fileExists(atPath: directory.savedState.path) {
                try? FileManager.default.removeItem(at: directory.savedState)
                record.coldBootPending = "resized while asleep, so its saved state could not be restored"
                persist(); onChange()
                return ["kind": "restarted", "detail": "resized \(record.name) to \(cpus) CPUs and \(gibibytes(memory)) while asleep; its processes ended, and it cold-boots at its next use"]
            }
            persist(); onChange(); return nil
        }
        return try await flight { try await $0.restart(cpus: cpus, memoryBytes: memory) }
    }

    /// Resize's restart, as the bring-up in flight. A size the backend cannot boot rolls back, and the sandbox comes
    /// back at the size it had.
    private func restart(cpus: Int, memoryBytes memory: UInt64) async throws -> SandboxAction? {
        if statusValue.lifecycle == .paused { try await resume() }
        let ended = (try? await guestProcesses()) ?? []
        try await halt()
        let previous = (cpus: record.cpus, memory: record.memoryBytes)
        record.cpus = cpus; record.memoryBytes = memory; persist()
        do { try await coldBoot() } catch {
            record.cpus = previous.cpus; record.memoryBytes = previous.memory; persist()
            // A stop that cancelled the resize wants the sandbox down, not booted again at its old size.
            if !Task.isCancelled { try? await coldBoot() }
            throw error
        }
        let commands = Array(Set(ended)).sorted()
        let listed = commands.isEmpty ? "" : ": \(commands.prefix(20).joined(separator: ", "))\(commands.count > 20 ? ", …" : "")"
        return ["kind": "restarted", "detail": "restarted \(record.name) at \(cpus) CPUs and \(gibibytes(memory)); \(ended.count) process\(ended.count == 1 ? "" : "es") ended\(listed)"]
    }

    /// The guest's user processes, by command, leaving out kernel threads and the guest agent serving this request.
    private func guestProcesses() async throws -> [String] {
        // `ps` where the image has it, else /proc (kernel threads have an empty cmdline there). Both print "pid ppid args".
        let script = #"echo $$; if command -v ps >/dev/null 2>&1; then ps -eo pid=,ppid=,args=; else for d in /proc/[0-9]*; do c=$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null); [ -n "$c" ] && echo "${d#/proc/} $(awk '/^PPid/{print $2}' "$d/status") $c"; done; fi"#
        let id = "resize-\(UUID().uuidString)"
        let request = try JSONSerialization.data(withJSONObject: ["protocol_version": protocolVersion, "request_id": id, "operation": "shell.exec", "sandbox_id": record.sandboxID, "deadline_ms": 15_000, "mutation_id": id, "input": ["command": script]])
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
        guard !discarded else { return }
        do { try directory.save(record) } catch { statusValue = RuntimeStatus(lifecycle: statusValue.lifecycle, channelEpoch: statusValue.channelEpoch, detail: "could not write \(directory.recordFile.path): \(explain(error))") }
    }
}

/// A runtime as `SandboxHost` reports it, read in one hop.
struct RuntimeSnapshot: Sendable {
    let record: SandboxRecord
    let status: RuntimeStatus
    let lastBoot: SandboxAction?
    /// A paused VM keeps its RAM; a paused process fixture (SIGSTOP) counts as freed.
    let pauseKeepsMemory: Bool
    /// Admission counts a sandbox's memory while it starts or runs, and while a VM sleeps paused in memory.
    var reservesMemory: Bool { [.starting, .ready].contains(status.lifecycle) || (status.lifecycle == .paused && pauseKeepsMemory) }
}
