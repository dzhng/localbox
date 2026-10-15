import Foundation
import HostDaemonCore

/// Real-VM lab for the proof harness:
///   vmlab boot --artifacts <dir> --json        boot a scratch clone and run `uname -m` in the guest
///   vmlab hibernate --artifacts <dir> --json   the slice 02 hibernate scenario (save here, restore in a new process)
///   vmlab restore --artifacts <dir> --scratch <dir> --json   phase 2 of hibernate, run by `hibernate` itself
@main
struct VMLabMain {
    static func main() async {
        #if os(macOS)
        let arguments = Array(CommandLine.arguments.dropFirst())
        do {
            guard let artifacts = option("--artifacts", in: arguments), arguments.contains("--json") else { throw LabError("usage: localbox-vmlab boot|hibernate|restore --artifacts <dir> [--scratch <dir>] --json") }
            let lab = Lab(artifacts: URL(fileURLWithPath: expanded(artifacts), isDirectory: true), kernelArguments: option("--kernel-args", in: arguments) ?? "")
            let output: [String: Any]
            switch arguments.first {
            case "boot": output = try await lab.boot()
            case "hibernate": output = try await lab.hibernate()
            case "restore":
                guard let scratch = option("--scratch", in: arguments) else { throw LabError("restore needs --scratch") }
                output = try await lab.restorePhase(scratch: URL(fileURLWithPath: scratch, isDirectory: true))
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

/// One scratch VM: an APFS clone of the template plus its persisted identity (MAC, machine identifier).
struct Lab {
    let artifacts: URL
    let kernelArguments: String

    func configuration(scratch: URL, cpuCount: Int = 2, memory: UInt64 = 2 * 1024 * 1024 * 1024) -> AppleVMConfiguration {
        AppleVMConfiguration(kernelURL: artifacts.appendingPathComponent("kernel"), initialRamdiskURL: artifacts.appendingPathComponent("initrd"), diskURL: scratch.appendingPathComponent("disk.img"), templateDiskURL: artifacts.appendingPathComponent("template.img"), cpuCount: cpuCount, memorySize: memory, consoleLogURL: scratch.appendingPathComponent("console.log"), extraKernelArguments: kernelArguments, identityDirectoryURL: scratch)
    }

    func newScratch() throws -> URL {
        let base = ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.temporaryDirectory
        let scratch = base.appendingPathComponent("localbox-vmlab-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: artifacts.appendingPathComponent("template.img"), to: scratch.appendingPathComponent("disk.img"))
        return scratch
    }

    func boot() async throws -> [String: Any] {
        let scratch = try newScratch()
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: scratch) } }
        let backend = AppleVirtualizationBackend(image: configuration(scratch: scratch))
        do {
            try await backend.start()
            let uname = try await shell(backend, "uname -m").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            try await backend.stop()
            return ["ok": true, "ready": true, "uname": uname]
        } catch {
            let reason = await backend.stopReason()
            if let log = try? String(contentsOf: scratch.appendingPathComponent("console.log"), encoding: .utf8) { FileHandle.standardError.write(Data(String(log.suffix(6000)).utf8)) }
            throw LabError("\(error) (stop reason: \(reason ?? "running"))")
        }
    }

    /// Phase 1: boot, start a long-lived server, measure, save. Phase 2 runs in a new vmlab process.
    func hibernate() async throws -> [String: Any] {
        let scratch = try newScratch()
        let backend = AppleVirtualizationBackend(image: configuration(scratch: scratch))
        try await backend.start()
        try await backend.validateSaveRestoreSupport()
        let started = try await shell(backend, "nohup node -e \"let n=0; require('http').createServer((q,r)=>r.end(String(n++))).listen(8080)\" >/dev/null 2>&1 & echo $!")
        let pid = started.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let before = try await shell(backend, "curl -s http://127.0.0.1:8080; echo; curl -s http://127.0.0.1:8080").stdout.split(separator: "\n").map(String.init)
        let nat = try await shell(backend, "curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://deb.debian.org/").stdout
        let guestMAC = try await shell(backend, "cat /sys/class/net/e*/address 2>/dev/null | head -1").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let persistedMAC = (try? String(contentsOf: scratch.appendingPathComponent("mac-address"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let memoryRunning = virtualizationMemoryKB()
        let state = scratch.appendingPathComponent("state.vzvmsave")
        let saveStarted = Date()
        try await backend.save(to: state)
        let saveMs = Int(Date().timeIntervalSince(saveStarted) * 1000)
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let memorySaved = virtualizationMemoryKB()
        let stateBytes = (try FileManager.default.attributesOfItem(atPath: state.path)[.size] as? Int) ?? 0
        let phase1: [String: Any] = ["pid": pid, "counter_before": before, "nat_http_code": nat, "guest_mac": guestMAC, "persisted_mac": persistedMAC, "vm_memory_kb_running": memoryRunning, "vm_memory_kb_after_save": memorySaved, "save_ms": saveMs, "state_file_bytes": stateBytes]
        try JSONSerialization.data(withJSONObject: phase1).write(to: scratch.appendingPathComponent("phase1.json"))
        // A separate process restores, so the save file must not depend on anything held by this one.
        let phase2 = try runSelf(["restore", "--artifacts", artifacts.path, "--scratch", scratch.path, "--json"] + (kernelArguments.isEmpty ? [] : ["--kernel-args", kernelArguments]))
        let survived = (phase2["pid_alive"] as? Bool ?? false) && (phase2["counter_after"] as? Int).map { $0 > (Int(before.last ?? "-1") ?? -1) } == true
        if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: scratch) }
        return ["ok": survived, "phase1": phase1, "phase2": phase2, "process_survived": survived, "mac_matches": !guestMAC.isEmpty && guestMAC == persistedMAC, "nat_ok": nat == "200"]
    }

    func restorePhase(scratch: URL) async throws -> [String: Any] {
        let state = scratch.appendingPathComponent("state.vzvmsave")
        let phase1 = try JSONSerialization.jsonObject(with: Data(contentsOf: scratch.appendingPathComponent("phase1.json"))) as? [String: Any] ?? [:]
        // Configuration-identity sweep: which changes make restore refuse the saved state.
        var sweep: [String: String] = [:]
        sweep["cpu_count"] = await attemptRestore(configuration(scratch: scratch, cpuCount: 3), state: state)
        sweep["mac_address"] = await withSwappedIdentity(scratch, file: "mac-address", replacement: Data("02:00:00:00:00:01".utf8)) { await attemptRestore(configuration(scratch: scratch), state: state) }
        sweep["machine_identifier"] = await withSwappedIdentity(scratch, file: "machine-identifier", replacement: nil) { await attemptRestore(configuration(scratch: scratch), state: state) }
        sweep["kernel_command_line"] = await attemptRestore(Lab(artifacts: artifacts, kernelArguments: kernelArguments + " localbox.sweep=1").configuration(scratch: scratch), state: state)
        // The real restore, with the configuration it was saved under.
        let backend = AppleVirtualizationBackend(image: configuration(scratch: scratch))
        let restoreStarted = Date()
        try await backend.restore(from: state)
        let restoreMs = Int(Date().timeIntervalSince(restoreStarted) * 1000)
        let pid = phase1["pid"] as? String ?? "0"
        let alive = try await shell(backend, "kill -0 \(pid) && echo alive || echo gone").stdout.contains("alive")
        let counter = Int(try await shell(backend, "curl -s --max-time 5 http://127.0.0.1:8080").stdout.trimmingCharacters(in: .whitespacesAndNewlines)) ?? -1
        let nat = try await shell(backend, "curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://deb.debian.org/").stdout
        let guestMs = Int64(try await shell(backend, "date +%s%3N").stdout.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        let skew = guestMs - Int64(Date().timeIntervalSince1970 * 1000)
        try await backend.stop()
        return ["restore_ms": restoreMs, "pid_alive": alive, "counter_after": counter, "nat_http_code_after": nat, "clock_skew_ms": skew, "identity_sweep": sweep]
    }

    /// nil means restore succeeded with that change (and the VM is stopped again); otherwise the refusal.
    func attemptRestore(_ configuration: AppleVMConfiguration, state: URL) async -> String {
        let backend = AppleVirtualizationBackend(image: configuration)
        do { try await backend.restore(from: state); try? await backend.stop(); return "restored" }
        catch { return "refused: \(error.localizedDescription)" }
    }

    func withSwappedIdentity(_ scratch: URL, file: String, replacement: Data?, _ body: () async -> String) async -> String {
        let url = scratch.appendingPathComponent(file); let original = try? Data(contentsOf: url)
        if let replacement { try? replacement.write(to: url) } else { try? FileManager.default.removeItem(at: url) }
        let result = await body()
        if let original { try? original.write(to: url) }
        return result
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
func shell(_ backend: AppleVirtualizationBackend, _ command: String) async throws -> (stdout: String, exitCode: Int) {
    let channel = try await backend.makeGuestChannel()
    let id = UUID().uuidString
    let envelope = try JSONSerialization.data(withJSONObject: ["protocol_version": "v1", "request_id": id, "operation": "shell.exec", "sandbox_id": "sandbox_vmlab", "deadline_ms": 60_000, "mutation_id": id, "input": ["command": command]])
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
