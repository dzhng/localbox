#if os(macOS)
import Foundation
import HostDaemonCore
import Virtualization

/// Slice 17: provisioning options instead of Setup Assistant, code into the guest over SSH, and `csrutil disable`
/// typed into Recovery's Terminal through the VNC server. The result is cached as `<lab>/macos-provisioned` (with
/// Remote Login left on and its password kept, for the later macOS lab steps; the product build turns both off).
///   vmlab macos-provision --evidence <dir> --json
extension MacLab {
    var provisioned: URL { root.appendingPathComponent("macos-provisioned", isDirectory: true) }
    static let guestUser = "localbox"

    func provision(evidence: URL) async throws -> [String: Any] {
        guard #available(macOS 27, *) else { throw LabError("blocked: guest provisioning needs macOS 27 on this Mac") }
        try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
        let guest = try clone()
        let password = Self.randomPassword()
        try password.write(to: guest.directory.appendingPathComponent("password"), atomically: true, encoding: .utf8)
        var steps: [String: Any] = [:]
        let mac = try guest.mac().string

        // 1. First boot with provisioning options: a user, auto-login and Remote Login, no Setup Assistant.
        var vm = try MacVM(guest: guest)
        let options = VZMacOSVirtualMachineStartOptions()
        let provisioning = VZMacGuestProvisioningOptions()
        provisioning.fullName = "Localbox"; provisioning.username = Self.guestUser; provisioning.password = password
        provisioning.logsInAutomatically = true; provisioning.enablesRemoteLogin = true
        try options.setGuestProvisioning(provisioning)
        var started = Date()
        try await vm.start(options: options)
        let vnc = try RecoveryVNC(virtualMachine: vm.vm, queue: vm.queue)
        let address = try await waitForAddress(mac)
        let ssh = GuestSSH(address: address, user: Self.guestUser, password: password)
        try await ssh.waitUntilReachable(timeout: 900)
        steps["ssh_ready_ms"] = Int(Date().timeIntervalSince(started) * 1000)

        // 2. Code runs in the guest as root: a LaunchDaemon that leaves a mark at every boot.
        let plist = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Label</key><string>sh.localbox.probe</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>mkdir -p /var/localbox; date -u +%s > /var/localbox/probe</string></array><key>RunAtLoad</key><true/></dict></plist>"
        let installed = try ssh.run("printf '%s' '\(plist)' > /Library/LaunchDaemons/sh.localbox.probe.plist && chown root:wheel /Library/LaunchDaemons/sh.localbox.probe.plist && echo '\(Self.guestUser) ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/localbox && chmod 0440 /etc/sudoers.d/localbox && echo installed", elevated: true)
        guard installed.stdout.contains("installed") else { throw LabError("installing the probe LaunchDaemon failed: \(installed.stderr)") }

        // 3. The desktop, logged in automatically.
        let desktop = try await desktopShot(vnc, to: evidence.appendingPathComponent("17-desktop.png"))
        steps["desktop_text"] = desktop
        _ = try? ssh.run("shutdown -h now", elevated: true)
        try await vm.waitUntilStopped(timeout: 300)
        vnc.stop()

        // 4. Recovery: Options, Terminal, csrutil disable, confirm, credentials, halt.
        vm = try MacVM(guest: guest)
        let recovery = VZMacOSVirtualMachineStartOptions(); recovery.startUpFromMacOSRecovery = true
        started = Date()
        try await vm.start(options: recovery)
        let recoveryVNC = try RecoveryVNC(virtualMachine: vm.vm, queue: vm.queue)
        let screen = try await connect(recoveryVNC)
        var transcript: [String] = []
        try await screen.waitForText(timeout: 300, "the startup options") { $0.contains("Options") }
        transcript.append("startup options after \(Int(Date().timeIntervalSince(started))) s")
        try await screen.press(.right); try await screen.press(.right); try await screen.press(.returnKey)
        try await screen.waitForText(timeout: 300, "Recovery") { text in ["Recovery", "Utilities", "Select a user", "Reinstall", "Disk Utility", "Language"].contains { text.contains($0) } }
        try await Task.sleep(nanoseconds: 5_000_000_000)
        transcript.append("recovery after \(Int(Date().timeIntervalSince(started))) s")
        try await screen.chord("t", with: [.command, .shift])
        try await screen.waitForText(timeout: 120, "a Terminal prompt") { $0.contains("bash") || $0.contains("-sh") || $0.contains("#") }
        try await Task.sleep(nanoseconds: 2_000_000_000)
        try await screen.type("csrutil disable\n")
        try await screen.waitForText(timeout: 60, "the y/n confirmation") { $0.contains("y/n") || $0.lowercased().contains("continue") }
        try await screen.type("y\n")
        // macOS 27 asks for the password of its only admin directly; older releases ask for a user name first.
        let asked = try await screen.waitForText(timeout: 60, "a credentials prompt") { text in ["password", "user name", "username"].contains { text.lowercased().contains($0) } }
        if !asked.lowercased().contains("password") {
            try await screen.type("\(Self.guestUser)\n")
            try await screen.waitForText(timeout: 60, "the password prompt") { $0.lowercased().contains("password") }
        }
        try await screen.type("\(password)\n")
        let done = try await screen.waitForText(timeout: 120, "SIP disabled") { $0.contains("disabled") || $0.contains("is off") }
        try screen.savePNG(try await screen.captureLit(), to: evidence.appendingPathComponent("17-csrutil.png"))
        transcript.append(done.split(separator: "\n").suffix(4).joined(separator: " | "))
        // csrutil has already written the policy; Recovery's halt does not always power the VM off, so stop it after a minute.
        try await screen.type("halt\n")
        do { try await vm.waitUntilStopped(timeout: 60) } catch { transcript.append("halt left the VM running; stopped it"); try await vm.stop() }
        screen.close(); recoveryVNC.stop()
        steps["recovery_transcript"] = transcript

        // 5. Normal boot: SIP is off and the LaunchDaemon ran.
        vm = try MacVM(guest: guest)
        try await vm.start()
        try await ssh.waitUntilReachable(timeout: 600)
        let sip = try ssh.run("csrutil status").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let probe = try ssh.run("cat /var/localbox/probe").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        steps["csrutil_status"] = sip; steps["probe_mark"] = probe
        _ = try? ssh.run("shutdown -h now", elevated: true)
        try await vm.waitUntilStopped(timeout: 300)
        let sipOff = sip.contains("disabled")

        // 6. Cache it for 18 and 19, then prove Remote Login can be turned off, on a clone of the cache.
        if FileManager.default.fileExists(atPath: provisioned.path) { try FileManager.default.removeItem(at: provisioned) }
        try FileManager.default.moveItem(at: guest.directory, to: provisioned)
        steps["remote_login_off"] = try await remoteLoginTurnsOff(password: password)
        let ok = sipOff && !probe.isEmpty && (steps["remote_login_off"] as? Bool == true)
        return ["ok": ok, "sip_disabled": sipOff, "steps": steps]
    }

    /// Boots an existing guest directory normally and reports SIP and the probe mark over SSH (lab diagnosis).
    func check(guestDirectory: URL) async throws -> [String: Any] {
        let guest = Guest(directory: guestDirectory)
        let password = try String(contentsOf: guest.directory.appendingPathComponent("password"), encoding: .utf8)
        let vm = try MacVM(guest: guest)
        try await vm.start()
        let ssh = GuestSSH(address: try await waitForAddress(try guest.mac().string), user: Self.guestUser, password: password)
        try await ssh.waitUntilReachable(timeout: 600)
        let sip = try ssh.run("csrutil status").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let probe = try ssh.run("cat /var/localbox/probe").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try? ssh.run("shutdown -h now", elevated: true)
        try await vm.waitUntilStopped(timeout: 300)
        return ["ok": sip.contains("disabled"), "csrutil_status": sip, "probe_mark": probe]
    }

    /// A clone of the provisioned cache, booted, Remote Login turned off; SSH must then refuse.
    func remoteLoginTurnsOff(password: String) async throws -> Bool {
        let guest = try clone(from: provisioned)
        defer { try? FileManager.default.removeItem(at: guest.directory) }
        let vm = try MacVM(guest: guest)
        try await vm.start()
        let ssh = GuestSSH(address: try await waitForAddress(try guest.mac().string), user: Self.guestUser, password: password)
        try await ssh.waitUntilReachable(timeout: 600)
        _ = try ssh.run("systemsetup -f -setremotelogin off", elevated: true)
        try await Task.sleep(nanoseconds: 3_000_000_000)
        let refused = (try? ssh.run("true", timeout: 15))?.status != 0
        try await vm.stop()
        return refused
    }

    func waitForAddress(_ mac: String, timeout: TimeInterval = 900) async throws -> String {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if let address = dhcpLeaseAddress(for: mac) { return address }; try await Task.sleep(nanoseconds: 2_000_000_000) }
        throw LabError("no DHCP lease for \(mac) within \(Int(timeout)) s")
    }

    func connect(_ server: RecoveryVNC) async throws -> VNCClient {
        let deadline = Date().addingTimeInterval(60)
        while true {
            let client = VNCClient(port: server.port, password: server.password)
            do { try await client.connect(); return client } catch {
                client.close()
                if Date() > deadline { throw error }
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    func desktopShot(_ server: RecoveryVNC, to url: URL) async throws -> String {
        let screen = try await connect(server)
        defer { screen.close() }
        let text = try await screen.waitForText(timeout: 300, "the logged-in desktop") { text in ["Finder", "File", "Edit", "View", "Go", "Window", "Help"].filter { text.contains($0) }.count >= 4 }
        try screen.savePNG(try await screen.capture(), to: url)
        return text.replacingOccurrences(of: "\n", with: " | ")
    }

    static func randomPassword() -> String {
        let alphabet = Array("abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        return String((0..<20).map { _ in alphabet.randomElement()! })
    }
}
#endif
