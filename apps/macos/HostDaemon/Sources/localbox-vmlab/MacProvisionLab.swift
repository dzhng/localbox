#if os(macOS)
import Foundation
import HostDaemonCore

/// Provisioning options instead of Setup Assistant, code into the guest over SSH, and `csrutil disable` typed into
/// Recovery's Terminal through the VNC server. The result is cached as `<lab>/macos-provisioned` (with Remote Login left
/// on and its password kept, for the later macOS lab steps; the product build turns both off).
///   vmlab macos-provision --evidence <dir> --json
extension MacLab {
    var provisioned: URL { root.appendingPathComponent("macos-provisioned", isDirectory: true) }
    static let guestUser = "localbox"

    func provision(evidence: URL) async throws -> [String: Any] {
        try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
        let guest = try clone()
        let user = MacProvisioningUser(name: Self.guestUser, password: MacProvisioningUser.randomPassword())
        // The lab keeps the password with its cache for the later macOS lab steps; the product build never writes it.
        try user.password.write(to: guest.directory.appendingPathComponent("password"), atomically: true, encoding: .utf8)
        var steps: [String: Any] = [:]

        // 1. First boot with provisioning options: a user, auto-login and Remote Login, no Setup Assistant.
        let started = Date()
        let (vm, ssh) = try await MacProvisioning.firstBoot(guest.files, user: user)
        let vnc = try vm.attachVNC()
        steps["ssh_ready_ms"] = Int(Date().timeIntervalSince(started) * 1000)

        // 2. Code runs in the guest as root: a LaunchDaemon that leaves a mark at every boot, and passwordless sudo
        // for the later labs.
        let plist = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Label</key><string>sh.localbox.probe</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>mkdir -p /var/localbox; date -u +%s > /var/localbox/probe</string></array><key>RunAtLoad</key><true/></dict></plist>"
        let installed = try await ssh.run("printf '%s' '\(plist)' > /Library/LaunchDaemons/sh.localbox.probe.plist && chown root:wheel /Library/LaunchDaemons/sh.localbox.probe.plist && echo '\(Self.guestUser) ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/localbox && chmod 0440 /etc/sudoers.d/localbox && echo installed", elevated: true)
        guard installed.stdout.contains("installed") else { throw LabError("installing the probe LaunchDaemon failed: \(installed.stderr)") }

        // 3. The desktop, logged in automatically.
        steps["desktop_text"] = try await desktopShot(vnc, to: evidence.appendingPathComponent("17-desktop.png"))
        try await MacProvisioning.shutDown(vm, over: ssh)
        vnc.stop()

        // 4. Recovery: Options, Terminal, csrutil disable, confirm, credentials, halt.
        steps["recovery_transcript"] = try await MacProvisioning.disableSIP(guest.files, user: user, screenshot: evidence.appendingPathComponent("17-csrutil.png"))

        // 5. Normal boot: SIP is off and the LaunchDaemon ran.
        let (booted, again) = try await bootOverSSH(guest)
        let sip = try await again.run("csrutil status").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let probe = try await again.run("cat /var/localbox/probe").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        steps["csrutil_status"] = sip; steps["probe_mark"] = probe
        try await MacProvisioning.shutDown(booted, over: again)
        let sipOff = sip.contains("disabled")

        // 6. Cache it for the agent and forwarder labs, then prove Remote Login can be turned off, on a clone of the cache.
        if FileManager.default.fileExists(atPath: provisioned.path) { try FileManager.default.removeItem(at: provisioned) }
        try FileManager.default.moveItem(at: guest.directory, to: provisioned)
        steps["remote_login_off"] = try await remoteLoginTurnsOff()
        let ok = sipOff && !probe.isEmpty && (steps["remote_login_off"] as? Bool == true)
        return ["ok": ok, "sip_disabled": sipOff, "steps": steps]
    }

    /// A clone of the provisioned cache, booted, Remote Login turned off; SSH must then refuse.
    func remoteLoginTurnsOff() async throws -> Bool {
        let guest = try clone(from: provisioned)
        defer { try? FileManager.default.removeItem(at: guest.directory) }
        let (vm, ssh) = try await bootOverSSH(guest)
        _ = try await ssh.run("systemsetup -f -setremotelogin off", elevated: true)
        try await Task.sleep(nanoseconds: 3_000_000_000)
        let refused = (try? await ssh.run("true", timeout: 15))?.status != 0
        try await vm.stop()
        return refused
    }

    func desktopShot(_ server: RecoveryVNC, to url: URL) async throws -> String {
        let screen = try await VNCClient.connect(to: server)
        defer { screen.close() }
        let text = try await screen.waitForText(timeout: 300, "the logged-in desktop") { text in ["Finder", "File", "Edit", "View", "Go", "Window", "Help"].filter { text.contains($0) }.count >= 4 }
        try screen.savePNG(try await screen.capture(), to: url)
        return text.replacingOccurrences(of: "\n", with: " | ")
    }
}
#endif
