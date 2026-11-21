#if os(macOS)
import Foundation
import HostDaemonCore
import Virtualization

/// Spikes 18 and 19, on clones of the provisioned cache (slice 17), with tools copied in over SSH.
///   vmlab macos-tcc --evidence <dir> --json     TCC rows grant the desktop role; the grant survives a replaced binary
///   vmlab macos-vsock --json                    the vsock forwarder: framed echo, reconnect, host-only peers
extension MacLab {
    static let agentPath = "/usr/local/localbox/localbox-agent"
    static let vsockPath = "/usr/local/localbox/localbox-vsock"

    /// A booted clone of the provisioned cache and an SSH session into it.
    func bootProvisioned() async throws -> (Guest, MacVM, GuestSSH, Date) {
        guard FileManager.default.fileExists(atPath: provisioned.appendingPathComponent("disk.img").path) else { throw LabError("blocked: no provisioned macOS base; run npm run proof -- 17 --tier m") }
        let guest = try clone(from: provisioned)
        let password = try String(contentsOf: guest.directory.appendingPathComponent("password"), encoding: .utf8)
        let vm = try MacVM(guest: guest)
        let started = Date()
        try await vm.start()
        let ssh = GuestSSH(address: try await waitForAddress(try guest.mac().string), user: Self.guestUser, password: password)
        try await ssh.waitUntilReachable(timeout: 600)
        return (guest, vm, ssh, started)
    }

    func hostTool(_ name: String) -> URL { URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent(name) }

    func install(_ local: URL, at remote: String, over ssh: GuestSSH) throws {
        try ssh.copy(local, to: "/tmp/\(local.lastPathComponent)")
        let moved = try ssh.run("mkdir -p \((remote as NSString).deletingLastPathComponent) && mv /tmp/\(local.lastPathComponent) \(remote) && chown root:wheel \(remote) && chmod 755 \(remote) && echo ok", elevated: true)
        guard moved.stdout.contains("ok") else { throw LabError("installing \(remote) failed: \(moved.stderr)") }
    }

    func launchDaemon(_ label: String, _ arguments: [String], over ssh: GuestSSH) throws {
        let args = arguments.map { "<string>\($0)</string>" }.joined()
        let plist = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Label</key><string>\(label)</string><key>ProgramArguments</key><array>\(args)</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>"
        let path = "/Library/LaunchDaemons/\(label).plist"
        let loaded = try ssh.run("printf '%s' '\(plist)' > \(path) && chown root:wheel \(path) && launchctl bootstrap system \(path) && echo ok", elevated: true)
        guard loaded.stdout.contains("ok") else { throw LabError("loading \(label) failed: \(loaded.stderr)") }
    }

    // MARK: 18

    func tcc(evidence: URL) async throws -> [String: Any] {
        try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
        let (guest, vm, ssh, _) = try await bootProvisioned()
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: guest.directory) } }
        try install(hostTool("localbox-tccprobe"), at: Self.agentPath, over: ssh)
        let uid = try ssh.run("id -u").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let agentPlist = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Label</key><string>sh.localbox.desktop</string><key>ProgramArguments</key><array><string>\(Self.agentPath)</string><string>/tmp/tccprobe.json</string></array></dict></plist>"
        _ = try ssh.run("printf '%s' '\(agentPlist)' > /Library/LaunchAgents/sh.localbox.desktop.plist && chown root:wheel /Library/LaunchAgents/sh.localbox.desktop.plist", elevated: true)
        // Run the desktop role once in the user's GUI session, as launchd would, and read what it found.
        func runDesktopRole() async throws -> [String: Any] {
            _ = try ssh.run("rm -f /tmp/tccprobe.json; launchctl bootout gui/\(uid)/sh.localbox.desktop 2>/dev/null; launchctl bootstrap gui/\(uid) /Library/LaunchAgents/sh.localbox.desktop.plist; launchctl kickstart -k gui/\(uid)/sh.localbox.desktop", elevated: true)
            for _ in 0..<30 {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let read = try ssh.run("cat /tmp/tccprobe.json 2>/dev/null")
                if let data = read.stdout.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { return object }
            }
            throw LabError("the desktop role never wrote its result")
        }
        let before = try await runDesktopRole()
        let rows = ["kTCCServiceScreenCapture", "kTCCServiceAccessibility", "kTCCServicePostEvent"].map { "('\($0)', 1, '\(Self.agentPath)', 2, 0, 1, NULL, 'UNUSED')" }.joined(separator: ",")
        let insert = "INSERT OR REPLACE INTO access (service, client_type, client, auth_value, auth_reason, auth_version, indirect_object_identifier_type, indirect_object_identifier) VALUES \(rows);"
        // macOS 27 keeps the user database in a per-user container; tccd's open files name the live one.
        let userDatabase = try ssh.run("lsof -a -u \(uid) -c tccd -Fn | sed -n 's|^n\\(/private/var/containers/Data/ProtectedSystem/.*/com.apple.TCC/TCC.db\\)$|\\1|p' | head -1", elevated: true).stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !userDatabase.isEmpty else { throw LabError("could not find the user TCC database") }
        for database in ["/Library/Application Support/com.apple.TCC/TCC.db", userDatabase] {
            let written = try ssh.run("sqlite3 '\(database)' \"\(insert)\" && echo ok", elevated: true)
            guard written.stdout.contains("ok") else { throw LabError("writing \(database) failed: \(written.stderr)") }
        }
        let granted = try await runDesktopRole()
        try? ssh.copyBack("/tmp/tccprobe-after.png", to: evidence.appendingPathComponent("18-menu-opened.png"))
        // Replace the binary with different bytes (a new ad-hoc signature) at the same path.
        let replacement = FileManager.default.temporaryDirectory.appendingPathComponent("localbox-tccprobe")
        try? FileManager.default.removeItem(at: replacement)
        try FileManager.default.copyItem(at: hostTool("localbox-tccprobe"), to: replacement)
        let resign = Process(); resign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign"); resign.arguments = ["--force", "--sign", "-", "--identifier", "sh.localbox.agent.\(UUID().uuidString.prefix(8))", replacement.path]
        try resign.run(); resign.waitUntilExit()
        try install(replacement, at: Self.agentPath, over: ssh)
        let replaced = try await runDesktopRole()
        try await vm.stop()
        func allGranted(_ result: [String: Any]) -> Bool { ["screen_capture", "accessibility", "post_event", "menu_opened"].allSatisfy { result[$0] as? Bool == true } }
        return ["ok": allGranted(granted), "survives_replace": allGranted(replaced), "user_database": userDatabase, "before_grant": before, "after_grant": granted, "after_replace": replaced]
    }

    // MARK: 19

    func vsock() async throws -> [String: Any] {
        let (guest, vm, ssh, booted) = try await bootProvisioned()
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: guest.directory) } }
        let sshMs = Int(Date().timeIntervalSince(booted) * 1000)
        try install(hostTool("localbox-vsock"), at: Self.vsockPath, over: ssh)
        try launchDaemon("sh.localbox.echo.agent", [Self.vsockPath, "echo", "/var/run/localbox/agent.sock"], over: ssh)
        try launchDaemon("sh.localbox.echo.control", [Self.vsockPath, "echo", "/var/run/localbox/control.sock"], over: ssh)
        try launchDaemon("sh.localbox.vsock", [Self.vsockPath, "1024=/var/run/localbox/agent.sock", "1025=/var/run/localbox/control.sock"], over: ssh)
        func dial(_ port: UInt32) async throws -> FileHandle {
            for _ in 0..<60 { if let connection = try? await vm.connect(port: port) { return FileHandle(fileDescriptor: dup(connection.fileDescriptor), closeOnDealloc: true) }; try await Task.sleep(nanoseconds: 500_000_000) }
            throw LabError("vsock port \(port) never accepted")
        }
        let forwarderPID = { try ssh.run("pgrep -f 'localbox-vsock 1024'").stdout.trimmingCharacters(in: .whitespacesAndNewlines) }
        let pidBefore = try forwarderPID()
        var request = try await dial(1024), control = try await dial(1025)
        // 10,000 frames up to 64 KiB plus sixteen of 8 MiB, each echoed byte for byte; a stream on 1025 meanwhile.
        let started = Date()
        var mismatches = 0, frames = 0, bytes = 0
        let controlTask = Task { () -> Bool in
            for index in 0..<500 { let frame = Data((0..<1024).map { UInt8(truncatingIfNeeded: $0 &+ index) }); if try roundTrip(control, frame) != frame { return false } }
            return true
        }
        for index in 0..<10_016 {
            let size = index < 10_000 ? Int.random(in: 1...65_536) : 8 << 20
            let frame = Data((0..<size).map { _ in UInt8.random(in: 0...255) })
            if try roundTrip(request, frame) != frame { mismatches += 1 }
            frames += 1; bytes += size
        }
        let controlOK = try await controlTask.value
        let throughputMBs = Double(bytes * 2) / Date().timeIntervalSince(started) / 1_048_576
        // The host drops both connections and dials again: the forwarder keeps running.
        try request.close(); try control.close()
        try await Task.sleep(nanoseconds: 1_000_000_000)
        request = try await dial(1024); control = try await dial(1025)
        let probe = Data("after reconnect".utf8)
        let reconnected = try roundTrip(request, probe) == probe && roundTrip(control, probe) == probe
        let pidAfter = try forwarderPID()
        let fromGuest = try ssh.run("\(Self.vsockPath) dial 1024", elevated: true).stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        try await vm.stop()
        let ok = mismatches == 0 && controlOK && reconnected && pidBefore == pidAfter && !pidBefore.isEmpty && fromGuest.hasPrefix("refused")
        return ["ok": ok, "frames": frames, "bytes": bytes, "mismatches": mismatches, "control_stream_ok": controlOK, "echo_mb_per_s": Int(throughputMBs), "reconnected": reconnected, "forwarder_pid_unchanged": pidBefore == pidAfter, "guest_local_dial": fromGuest, "first_boot_to_ssh_ms": sshMs]
    }
}

/// Writes one length-prefixed frame and reads the echoed frame back.
func roundTrip(_ handle: FileHandle, _ frame: Data) throws -> Data {
    var length = UInt32(frame.count).bigEndian
    try handle.write(contentsOf: Data(bytes: &length, count: 4) + frame)
    var received = Data()
    while received.count < frame.count + 4 {
        guard let chunk = try handle.read(upToCount: frame.count + 4 - received.count), !chunk.isEmpty else { throw LabError("the echo closed after \(received.count) bytes") }
        received.append(chunk)
    }
    return received.dropFirst(4)
}

extension GuestSSH {
    func copyBack(_ remote: String, to local: URL) throws {
        let result = try run("base64 -i \(remote)", timeout: 120)
        guard result.status == 0, let data = Data(base64Encoded: result.stdout.replacingOccurrences(of: "\n", with: "")) else { throw LabError("could not read \(remote)") }
        try data.write(to: local)
    }
}
#endif
