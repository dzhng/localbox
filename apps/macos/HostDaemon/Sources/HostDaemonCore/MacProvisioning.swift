#if os(macOS)
import Foundation
import Virtualization

/// The steps that take an IPSW to a provisioned, SIP-disabled macOS guest with no human step (slices 16–17), as plain
/// functions over `MacVirtualMachine`. `AppleMacBuildDriver` (the product build) and the macOS lab both call them, so
/// each step has one spelling.
public enum MacProvisioning {
    /// Installs `ipsw` into `guest`: new auxiliary storage for the restore image's hardware model, a new identity, an
    /// empty sparse disk of `diskBytes`, then `VZMacOSInstaller`. Returns the installed version ("27.2.1 (26B131)").
    @discardableResult
    public static func install(ipsw: URL, into guest: MacGuestFiles, diskBytes: UInt64, progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> String {
        let image = try await VZMacOSRestoreImage.load(from: ipsw)
        let os = image.operatingSystemVersion
        guard let requirements = image.mostFeaturefulSupportedConfiguration, requirements.hardwareModel.isSupported else {
            throw HostDaemonError.unsupported("this Mac cannot run macOS \(os.majorVersion).\(os.minorVersion) from \(ipsw.lastPathComponent)")
        }
        try requirements.hardwareModel.dataRepresentation.write(to: guest.hardwareModel, options: .atomic)
        try? FileManager.default.removeItem(at: guest.auxiliaryStorage)
        _ = try VZMacAuxiliaryStorage(creatingStorageAt: guest.auxiliaryStorage, hardwareModel: requirements.hardwareModel, options: [])
        try guest.writeNewIdentity()
        try? FileManager.default.removeItem(at: guest.disk)
        FileManager.default.createFile(atPath: guest.disk.path, contents: nil)
        try FileHandle(forWritingTo: guest.disk).truncate(atOffset: diskBytes)
        let vm = try MacVirtualMachine(spec: try guest.spec(cpus: max(requirements.minimumSupportedCPUCount, MacVirtualMachine.cpus), memoryBytes: max(requirements.minimumSupportedMemorySize, MacVirtualMachine.memoryBytes)))
        try await vm.install(from: ipsw, progress: progress)
        return "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion) (\(image.buildVersion))"
    }

    /// The first boot of a fresh install with `user` provisioned: auto-login, Remote Login on, no Setup Assistant.
    /// Returns once SSH accepts the password.
    public static func firstBoot(_ guest: MacGuestFiles, user: MacProvisioningUser, timeout: TimeInterval = 900) async throws -> (MacVirtualMachine, GuestSSH) {
        let vm = try MacVirtualMachine(spec: try guest.spec())
        try await vm.start(.provisioning(user))
        do {
            let ssh = GuestSSH(address: try await waitForAddress(try guest.macAddress(), timeout: timeout), user: user.name, password: user.password)
            try await ssh.waitUntilReachable(timeout: timeout)
            return (vm, ssh)
        } catch { try? await vm.stop(); throw error }
    }

    /// A normal boot reached over SSH (the lab's provisioned guests keep Remote Login on).
    public static func bootOverSSH(_ guest: MacGuestFiles, user: MacProvisioningUser, timeout: TimeInterval = 600) async throws -> (MacVirtualMachine, GuestSSH) {
        let vm = try MacVirtualMachine(spec: try guest.spec())
        try await vm.start()
        do {
            let ssh = GuestSSH(address: try await waitForAddress(try guest.macAddress(), timeout: timeout), user: user.name, password: user.password)
            try await ssh.waitUntilReachable(timeout: timeout)
            return (vm, ssh)
        } catch { try? await vm.stop(); throw error }
    }

    /// `shutdown -h now` over SSH, then the wait for power-off.
    public static func shutDown(_ vm: MacVirtualMachine, over ssh: GuestSSH) async throws {
        _ = try? ssh.run("shutdown -h now", elevated: true, timeout: 30)
        try await vm.waitUntilStopped(timeout: 300)
    }

    /// Boots `guest` into Recovery and types `csrutil disable` into its Terminal over the VNC screen (slice 17): Right,
    /// Right, Return picks Options; Command-Shift-T opens Terminal; macOS 27 asks y/n, then the only admin's password
    /// (older releases ask a user name first). Recovery's `halt` does not always power off, so the VM is stopped a minute
    /// later (the policy is written by then). Ends powered off. `screenshot`, if given, gets the Terminal's last screen.
    @discardableResult
    public static func disableSIP(_ guest: MacGuestFiles, user: MacProvisioningUser, screenshot: URL? = nil) async throws -> [String] {
        let vm = try MacVirtualMachine(spec: try guest.spec())
        let started = Date()
        try await vm.start(.recovery)
        let server = try vm.attachVNC()
        defer { server.stop() }
        var transcript: [String] = []
        do {
            let screen = try await connect(server)
            defer { screen.close() }
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
            let asked = try await screen.waitForText(timeout: 60, "a credentials prompt") { text in ["password", "user name", "username"].contains { text.lowercased().contains($0) } }
            if !asked.lowercased().contains("password") {
                try await screen.type("\(user.name)\n")
                try await screen.waitForText(timeout: 60, "the password prompt") { $0.lowercased().contains("password") }
            }
            try await screen.type("\(user.password)\n")
            let done = try await screen.waitForText(timeout: 120, "SIP disabled") { $0.contains("disabled") || $0.contains("is off") }
            if let screenshot { try screen.savePNG(try await screen.captureLit(), to: screenshot) }
            transcript.append(done.split(separator: "\n").suffix(4).joined(separator: " | "))
            try await screen.type("halt\n")
        } catch { try? await vm.stop(); throw error }
        do { try await vm.waitUntilStopped(timeout: 60) } catch { transcript.append("halt left the VM running; stopped it"); try await vm.stop() }
        return transcript
    }

    /// The address the Mac's NAT leased to `mac`, once it has.
    public static func waitForAddress(_ mac: String, timeout: TimeInterval = 900) async throws -> String {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if let address = dhcpLeaseAddress(for: mac) { return address }; try await Task.sleep(nanoseconds: 2_000_000_000) }
        throw HostDaemonError.unsupported("the macOS guest (\(mac)) got no DHCP lease within \(spoken(timeout))")
    }

    /// A VNC client on `server`, retried while it comes up.
    public static func connect(_ server: RecoveryVNC) async throws -> VNCClient {
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
}

/// Apple's newest restore image this Mac supports (`VZMacOSRestoreImage.fetchLatestSupported`), sized by a `HEAD`.
public struct AppleIPSWCatalog: IPSWCatalog {
    private let http: any RangedHTTP
    public init(http: any RangedHTTP = URLSessionRangedHTTP()) { self.http = http }
    public func latest() async throws -> IPSWRelease {
        let image = try await VZMacOSRestoreImage.latestSupported()
        let os = image.operatingSystemVersion
        return IPSWRelease(url: image.url, version: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)", build: image.buildVersion, sizeBytes: try await http.length(of: image.url))
    }
}

/// The product build's guests: real VMs from the build directory's files.
public struct AppleMacBuildDriver: MacBuildDriver {
    public init() {}

    private func files(_ build: MacBuildDirectory, installed: Bool = false) -> MacGuestFiles {
        MacGuestFiles(disk: installed ? build.installedDisk : build.disk, auxiliaryStorage: installed ? build.installedAux : build.aux, hardwareModel: build.hardwareModel, machineIdentifier: build.machineIdentifier, mac: build.mac)
    }

    public func install(ipsw: URL, into build: MacBuildDirectory, diskBytes: UInt64, progress: @escaping @Sendable (Double) -> Void) async throws {
        try await MacProvisioning.install(ipsw: ipsw, into: files(build, installed: true), diskBytes: diskBytes, progress: progress)
    }

    public func provision(_ build: MacBuildDirectory, user: MacProvisioningUser) async throws -> any MacBuildGuest {
        let guest = files(build)
        let (vm, ssh) = try await MacProvisioning.firstBoot(guest, user: user)
        return SSHBuildGuest(vm: vm, ssh: ssh, files: guest)
    }

    public func boot(_ build: MacBuildDirectory) async throws -> any MacBuildGuest {
        let vm = try MacVirtualMachine(spec: try files(build).spec())
        try await vm.start()
        do { return try await AgentBuildGuest(vm: vm) } catch { try? await vm.stop(); throw error }
    }
}

/// A provisioned build guest over SSH, as the provisioned user with `sudo`.
private struct SSHBuildGuest: MacBuildGuest {
    let vm: MacVirtualMachine, ssh: GuestSSH, files: MacGuestFiles
    func root(_ script: String, timeout: TimeInterval) async throws -> String {
        let ssh = ssh
        let result = try await Task.detached { try ssh.run(script, elevated: true, timeout: timeout) }.value
        guard result.status == 0 else { throw HostDaemonError.unsupported("a build step in the guest exited \(result.status): \(String((result.stderr + result.stdout).suffix(1500)))") }
        return result.stdout
    }
    func upload(_ local: URL, to remote: String) async throws { let ssh = ssh; try await Task.detached { try ssh.copy(local, to: remote) }.value }
    func shutDown() async throws { try await MacProvisioning.shutDown(vm, over: ssh) }
    func disableSIP(as user: MacProvisioningUser) async throws {
        try await shutDown()
        try await MacProvisioning.disableSIP(files, user: user)
    }
    func abandon() async { try? await vm.stop() }
}

/// A build guest through the Localbox agent: its request lane on vsock 1024, `shell.exec` as root.
private final class AgentBuildGuest: MacBuildGuest, @unchecked Sendable {
    let vm: MacVirtualMachine
    private let channel: FramedFileHandleGuestChannel
    /// The longest deadline the agent accepts on a request (it refuses more than 120 s).
    static let maxDeadlineMs = 120_000

    init(vm: MacVirtualMachine) async throws {
        self.vm = vm
        var last: Error = HostDaemonError.guestUnavailable
        // The forwarder accepts before the agent listens; dial until an agent sends its ready frame.
        let deadline = Date().addingTimeInterval(300)
        while Date() < deadline {
            let stream = try await vm.connect(port: 1024, within: 300)
            let channel = FramedFileHandleGuestChannel(reader: stream, writer: stream, sandboxID: "build_\(UUID().uuidString.prefix(8).lowercased())", name: MacBaseBuilder.guestName)
            do { try await channel.waitUntilReady(); self.channel = channel; return } catch { last = error; await channel.close() }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        throw HostDaemonError.unsupported("the Localbox agent in the macOS guest never answered: \(explain(last))")
    }

    func root(_ script: String, timeout: TimeInterval) async throws -> String {
        let envelope: [String: Any] = ["protocol_version": protocolVersion, "request_id": UUID().uuidString, "operation": "shell.exec", "sandbox_id": NSNull(),
                                       "deadline_ms": min(Int(timeout * 1000), AgentBuildGuest.maxDeadlineMs), "mutation_id": UUID().uuidString, "input": ["command": script]]
        let answer = try JSONSerialization.jsonObject(with: try await channel.send(JSONSerialization.data(withJSONObject: envelope))) as? [String: Any] ?? [:]
        guard answer["ok"] as? Bool == true, let result = answer["result"] as? [String: Any] else {
            throw HostDaemonError.unsupported("the guest agent refused a build step: \(((answer["error"] as? [String: Any])?["message"] as? String) ?? "no answer")")
        }
        let status = (result["exit_code"] as? NSNumber)?.intValue ?? -1
        let stdout = result["stdout"] as? String ?? "", stderr = result["stderr"] as? String ?? ""
        guard status == 0 else { throw HostDaemonError.unsupported("a build step in the guest exited \(status): \(String((stderr + stdout).suffix(1500)))") }
        return stdout
    }

    func upload(_ local: URL, to remote: String) async throws { throw HostDaemonError.unsupported("the agent guest takes no uploads") }

    /// The agent never answers a shutdown it is part of, so the shutdown is detached and the host waits for power-off.
    func shutDown() async throws {
        _ = try await root("(sleep 1; shutdown -h now) >/dev/null 2>&1 &", timeout: 30)
        await channel.close()
        try await vm.waitUntilStopped(timeout: 300)
    }

    func disableSIP(as user: MacProvisioningUser) async throws { throw HostDaemonError.unsupported("SIP is disabled while the guest is provisioned") }
    func abandon() async { await channel.close(); try? await vm.stop() }
}
#endif
