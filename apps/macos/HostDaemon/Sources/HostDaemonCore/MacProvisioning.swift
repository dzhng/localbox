#if os(macOS)
import Foundation
import Virtualization

/// A macOS guest's files outside a sandbox (an image build, a lab guest): its disk, its auxiliary storage, the hardware
/// model it was installed for, its machine identifier and NAT MAC. `spec` turns them into the `VMSpec` every macOS VM
/// is made from, so a build boots through the same translator as a sandbox.
public struct MacGuestFiles: Sendable {
    public let disk: URL
    public let auxiliaryStorage: URL
    public let hardwareModel: URL
    public let machineIdentifier: URL
    public let mac: URL
    public init(disk: URL, auxiliaryStorage: URL, hardwareModel: URL, machineIdentifier: URL, mac: URL) {
        self.disk = disk; self.auxiliaryStorage = auxiliaryStorage; self.hardwareModel = hardwareModel; self.machineIdentifier = machineIdentifier; self.mac = mac
    }

    public func macAddress() throws -> String { try String(contentsOf: mac, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Writes a new identity: a machine identifier and a locally administered MAC.
    public func writeNewIdentity() throws {
        try VZMacMachineIdentifier().dataRepresentation.write(to: machineIdentifier, options: .atomic)
        try VZMACAddress.randomLocallyAdministered().string.write(to: mac, atomically: true, encoding: .utf8)
    }

    public func spec(cpus: Int = VirtualMachine.macCPUs, memoryBytes: UInt64 = VirtualMachine.macMemoryBytes) throws -> VMSpec {
        VMSpec(platform: .macos(machineIdentifier: try Data(contentsOf: machineIdentifier), hardwareModel: try Data(contentsOf: hardwareModel)),
               boot: .macos(auxiliaryStorage: auxiliaryStorage), cpus: cpus, memoryBytes: memoryBytes, disk: disk, mac: try macAddress(), consoleLog: nil)
    }

    public func vm() throws -> VirtualMachine { try VirtualMachine(spec: try spec()) }
}

/// The steps that take an IPSW to a provisioned, SIP-disabled macOS guest with no human step, as plain functions over
/// `VirtualMachine`. `AppleMacBuildDriver` (the product build) and the macOS lab both call them, so each step has one
/// spelling.
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
        let vm = try VirtualMachine(spec: try guest.spec(cpus: max(requirements.minimumSupportedCPUCount, VirtualMachine.macCPUs), memoryBytes: max(requirements.minimumSupportedMemorySize, VirtualMachine.macMemoryBytes)))
        try await vm.install(from: ipsw, progress: progress)
        return "\(os.dotted) (\(image.buildVersion))"
    }

    /// The first boot of a fresh install with `user` provisioned: auto-login, Remote Login on, no Setup Assistant.
    /// Returns once SSH accepts the password.
    public static func firstBoot(_ guest: MacGuestFiles, user: MacProvisioningUser, timeout: TimeInterval = 900) async throws -> (VirtualMachine, GuestSSH) {
        try await boot(guest, .provisioning(user), user: user, timeout: timeout)
    }

    /// Starts `guest` (`how`) and waits until SSH accepts `user`'s password.
    public static func boot(_ guest: MacGuestFiles, _ how: VirtualMachine.Start, user: MacProvisioningUser, timeout: TimeInterval) async throws -> (VirtualMachine, GuestSSH) {
        let vm = try guest.vm()
        try await vm.start(how)
        do {
            let ssh = GuestSSH(address: try await waitForAddress(try guest.macAddress(), timeout: timeout), user: user.name, password: user.password)
            try await ssh.waitUntilReachable(timeout: timeout)
            return (vm, ssh)
        } catch { try? await vm.stop(); throw error }
    }

    /// `shutdown -h now` over SSH, then the wait for power-off.
    public static func shutDown(_ vm: VirtualMachine, over ssh: GuestSSH) async throws {
        _ = try? await ssh.run("shutdown -h now", elevated: true, timeout: 30)
        try await vm.waitUntilStopped(timeout: 300)
    }

    /// Boots `guest` into Recovery and types `csrutil disable` into its Terminal over the VNC screen: Right,
    /// Right, Return picks Options; Command-Shift-T opens Terminal; macOS 27 asks y/n, then the only admin's password
    /// (older releases ask a user name first). Recovery's `halt` does not always power off, so the VM is stopped a minute
    /// later (the policy is written by then). Ends powered off. `screenshot`, if given, gets the Terminal's last screen.
    @discardableResult
    public static func disableSIP(_ guest: MacGuestFiles, user: MacProvisioningUser, screenshot: URL? = nil) async throws -> [String] {
        let vm = try guest.vm()
        let started = Date()
        try await vm.start(.recovery)
        let server = try vm.attachVNC()
        defer { server.stop() }
        var transcript: [String] = []
        do {
            let screen = try await VNCClient.connect(to: server)
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
            if let screenshot { try screen.savePNG(try screen.lastFrame(), to: screenshot) }
            transcript.append(done.split(separator: "\n").suffix(4).joined(separator: " | "))
            try await screen.type("halt\n")
        } catch { try? await vm.stop(); throw error }
        do { try await vm.waitUntilStopped(timeout: 60) } catch { transcript.append("halt left the VM running; stopped it"); try await vm.stop() }
        return transcript
    }

    /// The address the Mac's NAT leased to `mac`, once it has (a guest is far enough up to run its network stack).
    public static func waitForAddress(_ mac: String, timeout: TimeInterval = 900) async throws -> String {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if let address = dhcpLeaseAddress(for: mac) { return address }; try await Task.sleep(nanoseconds: 2_000_000_000) }
        throw HostDaemonError.unsupported("the macOS guest (\(mac)) got no DHCP lease within \(spoken(timeout))")
    }
}

extension VNCClient {
    /// A client on `server`, retried while the server comes up.
    public static func connect(to server: RecoveryVNC) async throws -> VNCClient {
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
        // Apple's catalog service fails now and then ("the restore image catalog failed to load"); a retry answers.
        var attempt = 0
        var image: VZMacOSRestoreImage
        while true {
            do { image = try await VZMacOSRestoreImage.latestSupported(); break }
            catch { attempt += 1; if attempt >= 4 { throw error }; try await Task.sleep(nanoseconds: 5_000_000_000) }
        }
        let os = image.operatingSystemVersion
        return IPSWRelease(url: image.url, version: os.dotted, build: image.buildVersion, sizeBytes: try await http.length(of: image.url))
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

    public func provision(_ build: MacBuildDirectory, user: MacProvisioningUser) async throws -> any MacProvisionedGuest {
        let guest = files(build)
        let (vm, ssh) = try await MacProvisioning.firstBoot(guest, user: user)
        return SSHBuildGuest(vm: vm, ssh: ssh, files: guest)
    }

    public func freeRecoverySpace(_ build: MacBuildDirectory) throws -> Bool {
        try RecoveryPartition.delete(build.disk)
        return try DiskGrowth.hasUnclaimedSpace(build.disk)
    }

    public func boot(_ build: MacBuildDirectory) async throws -> any MacAgentGuest {
        let vm = try files(build).vm()
        try await vm.start()
        do { return AgentBuildGuest(vm: vm, channel: try await vm.openRequestLane(sandboxID: AgentBuildGuest.guestID, name: MacBaseBuilder.guestName, until: Date().addingTimeInterval(300))) }
        catch { try? await vm.stop(); throw HostDaemonError.unsupported("the Localbox agent in the macOS guest never answered: \(explain(error))") }
    }
}

/// A provisioned build guest over SSH, as the provisioned user with `sudo`.
private struct SSHBuildGuest: MacProvisionedGuest {
    let vm: VirtualMachine, ssh: GuestSSH, files: MacGuestFiles
    func root(_ script: String, timeout: TimeInterval) async throws -> String {
        let result = try await ssh.run(script, elevated: true, timeout: timeout)
        guard result.status == 0 else { throw HostDaemonError.unsupported("a build step in the guest exited \(result.status): \(String((result.stderr + result.stdout).suffix(1500)))") }
        return result.stdout
    }
    func upload(_ local: URL, to remote: String) async throws { try await ssh.copy(local, to: remote) }
    func disableSIP(as user: MacProvisioningUser) async throws {
        try await MacProvisioning.shutDown(vm, over: ssh)
        try await MacProvisioning.disableSIP(files, user: user)
    }
    func abandon() async { try? await vm.stop() }
}

/// A build guest through the Localbox agent's request lane, `shell.exec` as root.
private struct AgentBuildGuest: MacAgentGuest {
    /// The id the hello gives every build guest, as a sandbox's id names a sandbox.
    static let guestID = "build_macos"
    let vm: VirtualMachine, channel: FramedFileHandleGuestChannel

    func root(_ script: String, timeout: TimeInterval) async throws -> String {
        try await rootShell(on: channel, sandboxID: Self.guestID, step: "a build step")(script, timeout)
    }

    func claimDisk() async throws { try await GuestDiskClaim.claim(.macos, rootShell(on: channel, sandboxID: Self.guestID, step: "growing the disk's container")) }

    /// The agent never answers a shutdown it is part of, so the shutdown is detached and the host waits for power-off.
    func shutDown() async throws {
        _ = try await root("(sleep 1; shutdown -h now) >/dev/null 2>&1 &", timeout: 30)
        await channel.close()
        try await vm.waitUntilStopped(timeout: 300)
    }

    func abandon() async { await channel.close(); try? await vm.stop() }
}

extension VZMacOSRestoreImage {
    static func load(from url: URL) async throws -> VZMacOSRestoreImage {
        try await withCheckedThrowingContinuation { continuation in load(from: url) { continuation.resume(with: $0) } }
    }
    static func latestSupported() async throws -> VZMacOSRestoreImage {
        try await withCheckedThrowingContinuation { continuation in fetchLatestSupported { continuation.resume(with: $0) } }
    }
}
#endif
