import Foundation
import HostDaemonCore
#if os(macOS)
import Virtualization
#endif

/// Real-VM lab for the proof harness; `--image` is one image directory (`images/<id>/`):
///   vmlab boot --image <dir> [--command <sh>] --json   boot a scratch sandbox, report `uname -m` and `uname -r` (and run the command)
///   vmlab hibernate --image <dir> --json   the hibernate scenario (save here, restore in a new process)
///   vmlab restore --image <dir> --scratch <dir> --json   phase 2 of hibernate, run by `hibernate` itself
///   vmlab efi-kernel --image <dir> --json  apt-install another kernel in the guest, reboot, compare `uname -r`
///   vmlab efi-clones --image <dir> --json  two sandboxes, each with a copy of the image's variable store, booted at once
///   vmlab freeze --image <dir> --json     freezeAndClone under a guest writer, then a freeze whose host never thaws
///   vmlab shot-inspect --file <image> --json   size, luminance spread, colours and OCR text of a screenshot
@main
struct VMLabMain {
    static func main() async {
        #if os(macOS)
        let arguments = Array(CommandLine.arguments.dropFirst())
        do {
            if arguments.first == "shot-inspect", let file = option("--file", in: arguments) {
                emit(try inspectShot(URL(fileURLWithPath: expanded(file)))); return
            }
            if let command = arguments.first, command.hasPrefix("macos-") {
                guard arguments.contains("--json") else { throw LabError("usage: localbox-vmlab macos-install --ipsw <path>|macos-clones|macos-hibernate|macos-provision|macos-tcc|macos-vsock|macos-image|macos-latest --json") }
                let lab = MacLab.fromEnvironment()
                let output: [String: Any]
                switch command {
                case "macos-install":
                    guard let ipsw = option("--ipsw", in: arguments) else { throw LabError("macos-install needs --ipsw <path>") }
                    output = try await lab.install(ipsw: URL(fileURLWithPath: expanded(ipsw)))
                case "macos-clones": output = try await lab.clones()
                case "macos-hibernate": output = try await lab.hibernate()
                case "macos-tcc":
                    guard let evidence = option("--evidence", in: arguments), let agent = option("--guest-agent", in: arguments) else { throw LabError("macos-tcc needs --guest-agent <dist/guest-agent> --evidence <dir>") }
                    output = try await lab.tcc(guestAgent: URL(fileURLWithPath: expanded(agent), isDirectory: true), evidence: URL(fileURLWithPath: expanded(evidence), isDirectory: true))
                case "macos-vsock": output = try await lab.vsock()
                case "macos-image":
                    guard let image = option("--image", in: arguments), let evidence = option("--evidence", in: arguments) else { throw LabError("macos-image needs --image <images>/<id> --evidence <dir>") }
                    output = try await lab.image(URL(fileURLWithPath: expanded(image), isDirectory: true), evidence: URL(fileURLWithPath: expanded(evidence), isDirectory: true))
                case "macos-latest": output = try await lab.latestIPSW()
                case "macos-provision":
                    guard let evidence = option("--evidence", in: arguments) else { throw LabError("macos-provision needs --evidence <dir>") }
                    output = try await lab.provision(evidence: URL(fileURLWithPath: expanded(evidence), isDirectory: true))
                case "macos-restore":
                    guard let scratch = option("--scratch", in: arguments) else { throw LabError("macos-restore needs --scratch") }
                    output = try await lab.restorePhase(scratch: URL(fileURLWithPath: scratch, isDirectory: true))
                default: throw LabError("unknown vmlab command")
                }
                emit(output)
                if output["ok"] as? Bool == false { exit(1) }
                return
            }
            guard let image = option("--image", in: arguments), arguments.contains("--json") else { throw LabError("usage: localbox-vmlab boot|hibernate|restore|efi-kernel|efi-clones|freeze --image <dir> [--scratch <dir>] --json") }
            let lab = try Lab(image: URL(fileURLWithPath: expanded(image), isDirectory: true))
            let output: [String: Any]
            switch arguments.first {
            case "boot": output = try await lab.boot(command: option("--command", in: arguments))
            case "hibernate": output = try await lab.hibernate()
            case "restore":
                guard let scratch = option("--scratch", in: arguments) else { throw LabError("restore needs --scratch") }
                output = try await lab.restorePhase(scratch: URL(fileURLWithPath: scratch, isDirectory: true))
            case "efi-kernel": output = try await lab.efiKernel()
            case "efi-clones": output = try await lab.efiClones()
            case "freeze": output = try await lab.freeze()
            default: throw LabError("unknown vmlab command")
            }
            emit(output)
            if output["ok"] as? Bool == false { exit(1) }
        } catch {
            emit(["ok": false, "ready": false, "error": String(describing: error)])
            exit(1)
        }
        #else
        FileHandle.standardError.write(Data("localbox-vmlab requires macOS Virtualization\n".utf8))
        exit(1)
        #endif
    }
}

#if os(macOS)
struct LabError: Error, CustomStringConvertible { let description: String; init(_ text: String) { description = text } }

/// One scratch sandbox made the way `SandboxHost` makes one: provisioned from the image by `AppleSandboxFactory` and
/// booted from its `VMSpec` through `SandboxConfigurationBuilder`.
struct Lab {
    let image: URL
    let factory: AppleSandboxFactory
    init(image: URL) throws {
        self.image = image
        factory = AppleSandboxFactory(images: try ImageStore(imagesDirectory: image.deletingLastPathComponent()))
    }

    func backend(_ scratch: URL, record: SandboxRecord? = nil) throws -> AppleVirtualizationBackend {
        let directory = SandboxDirectory(scratch)
        let record = try record ?? directory.load()
        return AppleVirtualizationBackend(spec: try VMSpec(record: record, in: directory), sandboxID: record.sandboxID, name: record.name)
    }

    func newScratch() async throws -> URL {
        let base = ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.temporaryDirectory
        let scratch = base.appendingPathComponent("localbox-vmlab-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        let directory = SandboxDirectory(scratch)
        var record = SandboxRecord(sandboxID: "sandbox_vmlab", name: "vmlab", imageID: image.lastPathComponent, cpus: 2, memoryBytes: 2 * 1024 * 1024 * 1024, sleepAfterMs: .max) // vmlab runs no idle policy
        _ = try await factory.provision(&record, in: directory)
        try directory.save(record)
        return scratch
    }

    /// `command`, when given, runs in the guest after `uname -m` and its output is reported as `stdout`.
    func boot(command: String? = nil) async throws -> [String: Any] {
        let scratch = try await newScratch()
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: scratch) } }
        let backend = try backend(scratch)
        do {
            let started = Date()
            try await backend.start()
            let bootMs = Int(Date().timeIntervalSince(started) * 1000)
            let lines = try await shell(backend, "uname -m; uname -r").stdout.split(separator: "\n").map(String.init)
            var output: [String: Any] = ["ok": true, "ready": true, "uname": lines.first ?? "", "kernel": lines.dropFirst().first ?? "", "boot_ms": bootMs]
            if let command { output["stdout"] = try await shell(backend, command).stdout }
            try await backend.stop()
            return output
        } catch {
            let reason = await backend.stopReason()
            if let log = try? String(contentsOf: scratch.appendingPathComponent("console.log"), encoding: .utf8) { FileHandle.standardError.write(Data(String(log.suffix(6000)).utf8)) }
            throw LabError("\(error) (stop reason: \(reason ?? "running"))")
        }
    }

    /// Phase 1: boot, start a long-lived server, measure, save. Phase 2 runs in a new vmlab process.
    func hibernate() async throws -> [String: Any] {
        let scratch = try await newScratch()
        let backend = try backend(scratch)
        try await backend.start()
        let started = try await shell(backend, "nohup node -e \"let n=0; require('http').createServer((q,r)=>r.end(String(n++))).listen(8080)\" >/dev/null 2>&1 & echo $!")
        let pid = started.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let before = try await shell(backend, "curl -s http://127.0.0.1:8080; echo; curl -s http://127.0.0.1:8080").stdout.split(separator: "\n").map(String.init)
        let nat = try await shell(backend, "curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://deb.debian.org/").stdout
        let guestMAC = try await shell(backend, "cat /sys/class/net/e*/address 2>/dev/null | head -1").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let persistedMAC = try SandboxDirectory(scratch).load().mac ?? ""
        let memoryRunning = virtualizationMemoryKB()
        let state = SandboxDirectory(scratch).savedState
        let saveStarted = Date()
        try await backend.save(to: state)
        let saveMs = Int(Date().timeIntervalSince(saveStarted) * 1000)
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let memorySaved = virtualizationMemoryKB()
        let stateBytes = (try FileManager.default.attributesOfItem(atPath: state.path)[.size] as? Int) ?? 0
        let phase1: [String: Any] = ["pid": pid, "counter_before": before, "nat_http_code": nat, "guest_mac": guestMAC, "persisted_mac": persistedMAC, "vm_memory_kb_running": memoryRunning, "vm_memory_kb_after_save": memorySaved, "save_ms": saveMs, "state_file_bytes": stateBytes]
        try JSONSerialization.data(withJSONObject: phase1).write(to: scratch.appendingPathComponent("phase1.json"))
        // A separate process restores, so the save file must not depend on anything held by this one.
        let phase2 = try runSelf(["restore", "--image", image.path, "--scratch", scratch.path, "--json"])
        let survived = (phase2["pid_alive"] as? Bool ?? false) && (phase2["counter_after"] as? Int).map { $0 > (Int(before.last ?? "-1") ?? -1) } == true
        if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: scratch) }
        return ["ok": survived, "phase1": phase1, "phase2": phase2, "process_survived": survived, "mac_matches": !guestMAC.isEmpty && guestMAC == persistedMAC, "nat_ok": nat == "200"]
    }

    func restorePhase(scratch: URL) async throws -> [String: Any] {
        let state = SandboxDirectory(scratch).savedState
        let phase1 = try JSONSerialization.jsonObject(with: Data(contentsOf: scratch.appendingPathComponent("phase1.json"))) as? [String: Any] ?? [:]
        // Configuration-identity sweep: which changes make restore refuse the saved state.
        let record = try SandboxDirectory(scratch).load()
        var sweep: [String: String] = [:]
        var changed = record; changed.cpus = 3
        sweep["cpu_count"] = await attemptRestore(try backend(scratch, record: changed), state: state)
        changed = record; changed.mac = "02:00:00:00:00:01"
        sweep["mac_address"] = await attemptRestore(try backend(scratch, record: changed), state: state)
        changed = record; changed.machineIdentifier = VZGenericMachineIdentifier().dataRepresentation.base64EncodedString()
        sweep["machine_identifier"] = await attemptRestore(try backend(scratch, record: changed), state: state)
        // The real restore, with the configuration it was saved under.
        let backend = try backend(scratch)
        let restoreStarted = Date()
        try await backend.restore(from: state)
        let restoreMs = Int(Date().timeIntervalSince(restoreStarted) * 1000)
        let pid = phase1["pid"] as? String ?? "0"
        let alive = try await shell(backend, "kill -0 \(pid) && echo alive || echo gone").stdout.contains("alive")
        let counter = Int(try await shell(backend, "curl -s --max-time 5 http://127.0.0.1:8080").stdout.trimmingCharacters(in: .whitespacesAndNewlines)) ?? -1
        // How long until the restored guest reaches the internet by name; the guest agent holds requests until its
        // DNS server answers, so this should be immediate.
        let natStarted = Date()
        let nat = try await shell(backend, "for i in 1 2 3 4 5 6 7 8 9 10; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://deb.debian.org/); [ \"$c\" = 200 ] && break; sleep 1; done; printf %s \"$c\"").stdout
        let natMs = Int(Date().timeIntervalSince(natStarted) * 1000)
        let guestMs = Int64(try await shell(backend, "date +%s%3N").stdout.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        let skew = guestMs - Int64(Date().timeIntervalSince1970 * 1000)
        try await backend.stop()
        return ["restore_ms": restoreMs, "nat_ready_ms": natMs, "pid_alive": alive, "counter_after": counter, "nat_http_code_after": nat, "clock_skew_ms": skew, "identity_sweep": sweep]
    }

    /// Installs the HWE kernel (a different version from the image's GA kernel) and reboots the same disk: an EFI disk
    /// boots whatever `/boot/vmlinuz` now points at, and the guest agent must still answer over vsock.
    func efiKernel() async throws -> [String: Any] {
        let scratch = try await newScratch()
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: scratch) } }
        var backend = try backend(scratch)
        try await backend.start()
        let before = try await shell(backend, "uname -r").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        // Longer than one request may run, so it runs detached and the lab polls for its exit status.
        _ = try await shell(backend, "nohup sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -q && apt-get install -y -q --no-install-recommends linux-image-generic-hwe-24.04; echo $? > /tmp/kernel.rc' >/tmp/kernel.log 2>&1 &")
        var install = (stdout: "", exitCode: -1)
        for _ in 0..<120 where install.stdout.isEmpty {
            try await Task.sleep(nanoseconds: 5_000_000_000)
            install = try await shell(backend, "cat /tmp/kernel.rc 2>/dev/null && readlink /boot/vmlinuz")
        }
        _ = try await shell(backend, "sync")
        try await backend.stop()
        backend = try self.backend(scratch)
        let started = Date()
        try await backend.start()
        let bootMs = Int(Date().timeIntervalSince(started) * 1000)
        let after = try await shell(backend, "uname -r").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let vsock = try await shell(backend, "lsmod | grep -c vsock").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        try await backend.stop()
        let lines = install.stdout.split(separator: "\n").map(String.init)
        return ["ok": before != after && lines.first == "0", "kernel_before": before, "kernel_after": after, "apt_exit": lines.first ?? "", "vmlinuz_target": lines.dropFirst().first ?? "", "reboot_ms": bootMs, "vsock_modules": vsock]
    }

    /// Two sandboxes from one image (each a clone of its disk with a copy of its variable store), booted at once.
    func efiClones() async throws -> [String: Any] {
        let first = try await newScratch(), second = try await newScratch()
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { for scratch in [first, second] { try? FileManager.default.removeItem(at: scratch) } } }
        let backends = try [first, second].map { try backend($0) }
        let started = Date()
        async let a: Void = backends[0].start()
        async let b: Void = backends[1].start()
        _ = try await (a, b)
        let bootMs = Int(Date().timeIntervalSince(started) * 1000)
        var ids: [String] = []
        for backend in backends { ids.append(try await shell(backend, "cat /etc/machine-id; uname -r").stdout.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)) }
        for backend in backends { try await backend.stop() }
        return ["ok": ids.count == 2 && ids[0] != ids[1], "both_booted_ms": bootMs, "guests": ids]
    }

    /// The control lane on a real guest. Phase 1: a sandbox run by `SandboxHost` writes a tick every 50 ms while
    /// `freezeAndClone` clones its disk with a body that also sleeps 1 s; the writer stalls, then continues. Phase 2: the
    /// same disk booted on a bare backend, frozen with a 3 s timeout over a lane that then drops without a thaw (what the
    /// guest sees when its host dies mid-clone); a write request completes only once the guest thawed itself.
    func freeze() async throws -> [String: Any] {
        let base = try await newScratch()
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: base) } }
        let sandboxes = base.appendingPathComponent("sandboxes", isDirectory: true)
        try FileManager.default.createDirectory(at: sandboxes, withIntermediateDirectories: true)
        let operations = try HostOperationStore(operationsDirectory: base.appendingPathComponent("operations", isDirectory: true))
        let store = try ImageStore(imagesDirectory: image.deletingLastPathComponent())
        let builds = MacBaseBuilder(store: store, operations: operations, driver: AppleMacBuildDriver(), catalog: AppleIPSWCatalog(), guestAgent: nil)
        let host = SandboxHost(sandboxesDirectory: sandboxes, factory: factory, operations: operations, store: store, macBuilds: builds)
        let id = "sandbox_vmlab"
        _ = try await hostResult(host, "sandbox.create", id, ["name": "vmlab", "image": image.lastPathComponent, "cpus": 2, "memory_bytes": 2 * 1024 * 1024 * 1024, "sleep_after_ms": Int(Int32.max)])
        _ = try await hostResult(host, "shell.exec", id, ["command": "while :; do date +%s%3N >> /var/tmp/ticks; sleep 0.05; done", "background": true])
        try await Task.sleep(nanoseconds: 1_500_000_000)
        guard let runtime = await host.runtime(id) else { throw LabError("the sandbox has no runtime") }
        let disk = SandboxDirectory(sandboxes.appendingPathComponent(id)).disk, clone = base.appendingPathComponent("clone.img")
        let ticksBefore = Int(try await hostShell(host, id, "wc -l < /var/tmp/ticks")) ?? 0
        let windowStart = Date(), started = Date()
        let cloned = try await runtime.freezeAndClone {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            return try cloneDisk(disk, to: clone)
        }.value
        let cloneMs = Int(Date().timeIntervalSince(started) * 1000)
        let afterLifecycle = await runtime.status().lifecycle.rawValue
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let windowMs = Int(Date().timeIntervalSince(windowStart) * 1000)
        let ticks = try await hostShell(host, id, "cat /var/tmp/ticks").split(separator: "\n").compactMap { Int64($0) }
        // The guest's clock does not run while the VM is paused, so its own tick times hide most of the stall. Measured on
        // the host's clock instead: the window's length less the time the ticks written in it account for.
        let gaps = zip(ticks.dropFirst(), ticks).map { $0 - $1 }
        let median = gaps.isEmpty ? 0 : Int(gaps.sorted()[gaps.count / 2])
        let ticksInWindow = ticks.count - ticksBefore
        let stallMs = windowMs - ticksInWindow * median
        let phase1: [String: Any] = ["freeze_and_clone_ms": cloneMs, "clone": cloned, "clone_bytes": (try? FileManager.default.attributesOfItem(atPath: clone.path)[.size] as? Int) ?? 0, "lifecycle_after": afterLifecycle, "window_ms": windowMs, "ticks_in_window": ticksInWindow, "median_tick_ms": median, "host_measured_stall_ms": stallMs, "guest_clock_max_gap_ms": Int(gaps.max() ?? 0), "ticks_after_clone_s": ticks.filter { $0 > (ticks.last ?? 0) - 1_000 }.count]
        _ = try await hostResult(host, "sandbox.stop", id, [:])

        let backend = try backend(sandboxes.appendingPathComponent(id))
        try await backend.start()
        let lane = try await backend.dialControl()
        try await lane.freeze(timeoutMs: 3_000)
        let frozenAt = Date()
        await lane.close()
        _ = try await shell(backend, "echo after >> /var/tmp/after")
        let writeBlockedMs = Int(Date().timeIntervalSince(frozenAt) * 1000)
        let thawed = try await shell(backend, "cat /var/tmp/after").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        try await backend.stop()
        let phase2: [String: Any] = ["self_thaw_timeout_ms": 3_000, "write_blocked_ms": writeBlockedMs, "write_landed": thawed == "after"]
        // The body sleeps 1 s; freeze, pause, resume and thaw add to it.
        let stalled = stallMs >= 900
        let continued = (phase1["ticks_after_clone_s"] as? Int ?? 0) >= 10
        let selfThawed = writeBlockedMs >= 2_500 && writeBlockedMs <= 8_000 && thawed == "after"
        return ["ok": stalled && continued && afterLifecycle == "ready" && cloned == "cloned" && selfThawed, "writer_continued": continued, "phase1": phase1, "phase2": phase2, "writer_stalled": stalled, "self_thawed": selfThawed]
    }

    func hostResult(_ host: SandboxHost, _ operation: String, _ sandboxID: String, _ input: [String: Any]) async throws -> [String: Any] {
        let response = try JSONSerialization.jsonObject(with: try await host.request(requestEnvelope(operation, sandboxID: sandboxID, input: input, deadlineMs: 60_000))) as? [String: Any]
        guard response?["ok"] as? Bool == true else { throw LabError("\(operation) failed: \(response ?? [:])") }
        return response?["result"] as? [String: Any] ?? [:]
    }

    func hostShell(_ host: SandboxHost, _ sandboxID: String, _ command: String) async throws -> String {
        (try await hostResult(host, "shell.exec", sandboxID, ["command": command])["stdout"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// "restored" when restore accepted that change (and the VM is stopped again); otherwise the refusal.
    func attemptRestore(_ backend: AppleVirtualizationBackend, state: URL) async -> String {
        do { try await backend.restore(from: state); try? await backend.stop(); return "restored" }
        catch { return "refused: \(error.localizedDescription)" }
    }

    func runSelf(_ arguments: [String]) throws -> [String: Any] {
        let process = Process(); process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); process.arguments = arguments
        let stdout = Pipe(); process.standardOutput = stdout
        try process.run(); let data = stdout.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        let line = String(decoding: data, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? "{}"
        return (try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]) ?? ["error": line]
    }
}

/// Run one shell command in the guest through the framed vsock channel.
func shell(_ backend: AppleVirtualizationBackend, _ command: String, timeoutMs: Int = 60_000) async throws -> (stdout: String, exitCode: Int) {
    let channel = try await backend.makeGuestChannel()
    let response = try JSONSerialization.jsonObject(with: try await channel.send(requestEnvelope("shell.exec", sandboxID: "sandbox_vmlab", input: ["command": command], deadlineMs: timeoutMs))) as? [String: Any]
    guard response?["ok"] as? Bool == true, let result = response?["result"] as? [String: Any] else { throw LabError("guest command failed: \(command): \(response ?? [:])") }
    return (result["stdout"] as? String ?? "", result["exit_code"] as? Int ?? -1)
}

/// Resident memory of the Virtualization XPC service processes, in KiB.
func virtualizationMemoryKB() -> Int {
    let process = Process(); process.executableURL = URL(fileURLWithPath: "/bin/ps"); process.arguments = ["-axo", "rss=,comm="]
    let pipe = Pipe(); process.standardOutput = pipe
    guard (try? process.run()) != nil else { return -1 }
    let text = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self); process.waitUntilExit()
    return text.split(separator: "\n").filter { $0.contains("Virtualization.VirtualMachine") }.compactMap { Int($0.split(separator: " ").first ?? "") }.reduce(0, +)
}

func emit(_ object: [String: Any]) {
    if let encoded = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) { FileHandle.standardOutput.write(encoded); FileHandle.standardOutput.write(Data("\n".utf8)) }
}
#endif

func option(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
    return arguments[index + 1]
}

func expanded(_ path: String) -> String { (path as NSString).expandingTildeInPath }
