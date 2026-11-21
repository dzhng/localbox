import Foundation
import HostDaemonCore
#if os(macOS)
import Virtualization
#endif

/// Real-VM lab for the proof harness:
///   vmlab boot --artifacts <dir> --json        boot a scratch clone and run `uname -m` in the guest
///   vmlab hibernate --artifacts <dir> --json   the hibernate scenario (save here, restore in a new process)
///   vmlab restore --artifacts <dir> --scratch <dir> --json   phase 2 of hibernate, run by `hibernate` itself
///   --efi                                     boot the artifacts' template.img as a GPT disk through EFI firmware
///   vmlab efi-kernel --artifacts <dir> --efi --json   apt-install another kernel in the guest, reboot, compare `uname -r`
///   vmlab efi-clones --artifacts <dir> --efi --json   two clones, each with a copy of one variable store, booted at once
@main
struct VMLabMain {
    static func main() async {
        #if os(macOS)
        let arguments = Array(CommandLine.arguments.dropFirst())
        do {
            if arguments.first == "vnc-shot", let port = option("--port", in: arguments).flatMap(UInt16.init), let out = option("--out", in: arguments) {
                let screen = VNCClient(port: port, password: option("--password", in: arguments)); try await screen.connect()
                try screen.savePNG(try await screen.capture(), to: URL(fileURLWithPath: out))
                emit(["ok": true, "text": try await screen.screenText()]); screen.close(); return
            }
            if let command = arguments.first, command.hasPrefix("macos-") {
                guard arguments.contains("--json") else { throw LabError("usage: localbox-vmlab macos-install --ipsw <path>|macos-clones|macos-hibernate --json") }
                let lab = MacLab.fromEnvironment()
                let output: [String: Any]
                switch command {
                case "macos-install":
                    guard let ipsw = option("--ipsw", in: arguments) else { throw LabError("macos-install needs --ipsw <path>") }
                    output = try await lab.install(ipsw: URL(fileURLWithPath: expanded(ipsw)))
                case "macos-clones": output = try await lab.clones()
                case "macos-hibernate": output = try await lab.hibernate()
                case "macos-tcc":
                    guard let evidence = option("--evidence", in: arguments) else { throw LabError("macos-tcc needs --evidence <dir>") }
                    output = try await lab.tcc(evidence: URL(fileURLWithPath: expanded(evidence), isDirectory: true))
                case "macos-vsock": output = try await lab.vsock()
                case "macos-check":
                    guard let guest = option("--guest", in: arguments) else { throw LabError("macos-check needs --guest <dir>") }
                    output = try await lab.check(guestDirectory: URL(fileURLWithPath: expanded(guest), isDirectory: true))
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
            guard let artifacts = option("--artifacts", in: arguments), arguments.contains("--json") else { throw LabError("usage: localbox-vmlab boot|hibernate|restore|efi-kernel|efi-clones --artifacts <dir> [--scratch <dir>] [--efi] --json") }
            let lab = Lab(artifacts: SandboxArtifacts(directory: URL(fileURLWithPath: expanded(artifacts), isDirectory: true), extraKernelArguments: option("--kernel-args", in: arguments) ?? ""), efi: arguments.contains("--efi"))
            let output: [String: Any]
            switch arguments.first {
            case "boot": output = try await lab.boot()
            case "hibernate": output = try await lab.hibernate()
            case "restore":
                guard let scratch = option("--scratch", in: arguments) else { throw LabError("restore needs --scratch") }
                output = try await lab.restorePhase(scratch: URL(fileURLWithPath: scratch, isDirectory: true))
            case "efi-kernel": output = try await lab.efiKernel()
            case "efi-clones": output = try await lab.efiClones()
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

/// One scratch sandbox made the way `SandboxHost` makes one: an APFS clone of the template plus a record holding its
/// MAC and machine identifier, booted through `SandboxConfigurationBuilder`.
struct Lab {
    let artifacts: SandboxArtifacts
    /// Boot through EFI firmware from the disk (GRUB, kernel on the disk) instead of the host's kernel and initrd.
    var efi = false

    func backend(_ scratch: URL, record: SandboxRecord? = nil, artifacts: SandboxArtifacts? = nil) throws -> AppleVirtualizationBackend {
        let directory = SandboxDirectory(scratch)
        var configure: AppleVirtualizationBackend.ConfigurationMaker?
        if efi { configure = { record, directory in try efiConfiguration(record, in: directory) } }
        return AppleVirtualizationBackend(record: try record ?? directory.load(), directory: directory, artifacts: artifacts ?? self.artifacts, configure: configure)
    }

    func newScratch() throws -> URL {
        let base = ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.temporaryDirectory
        let scratch = base.appendingPathComponent("localbox-vmlab-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        let directory = SandboxDirectory(scratch)
        var record = SandboxRecord(sandboxID: "sandbox_vmlab", name: "vmlab", cpus: 2, memoryBytes: 2 * 1024 * 1024 * 1024, sleepAfterMs: .max) // vmlab runs no idle policy
        _ = try AppleSandboxFactory(artifacts: artifacts).provision(&record, in: directory)
        try directory.save(record)
        return scratch
    }

    func boot() async throws -> [String: Any] {
        let scratch = try newScratch()
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: scratch) } }
        let backend = try backend(scratch)
        do {
            let started = Date()
            try await backend.start()
            let bootMs = Int(Date().timeIntervalSince(started) * 1000)
            let uname = try await shell(backend, "uname -m").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            try await backend.stop()
            return ["ok": true, "ready": true, "uname": uname, "boot_ms": bootMs]
        } catch {
            let reason = await backend.stopReason()
            if let log = try? String(contentsOf: scratch.appendingPathComponent("console.log"), encoding: .utf8) { FileHandle.standardError.write(Data(String(log.suffix(6000)).utf8)) }
            throw LabError("\(error) (stop reason: \(reason ?? "running"))")
        }
    }

    /// Phase 1: boot, start a long-lived server, measure, save. Phase 2 runs in a new vmlab process.
    func hibernate() async throws -> [String: Any] {
        let scratch = try newScratch()
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
        let phase2 = try runSelf(["restore", "--artifacts", artifacts.kernelURL.deletingLastPathComponent().path, "--scratch", scratch.path, "--json"] + (artifacts.extraKernelArguments.isEmpty ? [] : ["--kernel-args", artifacts.extraKernelArguments]) + (efi ? ["--efi"] : []))
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
        let swept = SandboxArtifacts(kernelURL: artifacts.kernelURL, initialRamdiskURL: artifacts.initialRamdiskURL, templateDiskURL: artifacts.templateDiskURL, extraKernelArguments: artifacts.extraKernelArguments + " localbox.sweep=1")
        sweep["kernel_command_line"] = await attemptRestore(try backend(scratch, artifacts: swept), state: state)
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
        let scratch = try newScratch()
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

    /// One variable store, copied into two clones of the disk, both booted at once.
    func efiClones() async throws -> [String: Any] {
        let first = try newScratch(), second = try newScratch()
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { for scratch in [first, second] { try? FileManager.default.removeItem(at: scratch) } } }
        let store = first.appendingPathComponent("efi-vars")
        _ = try VZEFIVariableStore(creatingVariableStoreAt: store)
        try FileManager.default.copyItem(at: store, to: second.appendingPathComponent("efi-vars"))
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

/// The EFI variant of `SandboxConfigurationBuilder`: the same devices and identity, firmware instead of a kernel, and a
/// variable store in the sandbox directory (created empty on first boot, so firmware takes the removable boot path).
func efiConfiguration(_ record: SandboxRecord, in directory: SandboxDirectory) throws -> VZVirtualMachineConfiguration {
    guard let mac = record.mac.flatMap(VZMACAddress.init(string:)), let identifier = record.machineIdentifier.flatMap({ Data(base64Encoded: $0) }).flatMap(VZGenericMachineIdentifier.init(dataRepresentation:)) else { throw LabError("record has no MAC or machine identifier") }
    let store = directory.url.appendingPathComponent("efi-vars")
    let boot = VZEFIBootLoader()
    boot.variableStore = FileManager.default.fileExists(atPath: store.path) ? VZEFIVariableStore(url: store) : try VZEFIVariableStore(creatingVariableStoreAt: store)
    let configuration = VZVirtualMachineConfiguration()
    configuration.bootLoader = boot
    configuration.cpuCount = record.cpus
    configuration.memorySize = record.memoryBytes
    configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: directory.disk, readOnly: false))]
    let network = VZVirtioNetworkDeviceConfiguration(); network.attachment = VZNATNetworkDeviceAttachment(); network.macAddress = mac
    configuration.networkDevices = [network]
    configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]
    if !FileManager.default.fileExists(atPath: directory.consoleLog.path) { FileManager.default.createFile(atPath: directory.consoleLog.path, contents: nil) }
    let log = try FileHandle(forWritingTo: directory.consoleLog); log.seekToEndOfFile()
    let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
    serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: log)
    configuration.serialPorts = [serial]
    let platform = VZGenericPlatformConfiguration(); platform.machineIdentifier = identifier
    configuration.platform = platform
    try configuration.validate()
    try configuration.validateSaveRestoreSupport()
    return configuration
}

/// Run one shell command in the guest through the framed vsock channel.
func shell(_ backend: AppleVirtualizationBackend, _ command: String, timeoutMs: Int = 60_000) async throws -> (stdout: String, exitCode: Int) {
    let channel = try await backend.makeGuestChannel()
    let id = UUID().uuidString
    let envelope = try JSONSerialization.data(withJSONObject: ["protocol_version": protocolVersion, "request_id": id, "operation": "shell.exec", "sandbox_id": "sandbox_vmlab", "deadline_ms": timeoutMs, "mutation_id": id, "input": ["command": command]])
    let response = try JSONSerialization.jsonObject(with: try await channel.send(envelope)) as? [String: Any]
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
