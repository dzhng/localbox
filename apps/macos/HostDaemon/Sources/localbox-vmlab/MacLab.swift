#if os(macOS)
import Foundation
import HostDaemonCore
import Virtualization

/// macOS-guest experiments (proof tier `m`). The installed base is cached under the lab directory so every later macOS
/// probe starts from it instead of reinstalling:
///   vmlab macos-install --ipsw <path> --json   install the IPSW into `<lab>/macos-base`
///   vmlab macos-clones --json                  two clones with new identifiers run at once; a third is refused
///   vmlab macos-hibernate --json               save a clone in this process, restore it in a new one
struct MacLab {
    let root: URL
    var base: URL { root.appendingPathComponent("macos-base", isDirectory: true) }

    static func fromEnvironment() -> MacLab {
        let path = ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_DIR"] ?? (NSHomeDirectory() as NSString).appendingPathComponent(".cache/localbox-vmlab")
        return MacLab(root: URL(fileURLWithPath: path, isDirectory: true))
    }

    /// One macOS guest's files: a disk, auxiliary storage, the hardware model it was installed for, its identity.
    struct Guest {
        let directory: URL
        var disk: URL { directory.appendingPathComponent("disk.img") }
        var aux: URL { directory.appendingPathComponent("aux.img") }
        var hardwareModelFile: URL { directory.appendingPathComponent("hardware-model") }
        var identifierFile: URL { directory.appendingPathComponent("machine-identifier") }
        var macFile: URL { directory.appendingPathComponent("mac") }
        var savedState: URL { directory.appendingPathComponent("state.vzsave") }

        func hardwareModel() throws -> VZMacHardwareModel {
            guard let model = VZMacHardwareModel(dataRepresentation: try Data(contentsOf: hardwareModelFile)) else { throw LabError("unreadable hardware model in \(directory.path)") }
            return model
        }
        func identifier() throws -> VZMacMachineIdentifier {
            guard let id = VZMacMachineIdentifier(dataRepresentation: try Data(contentsOf: identifierFile)) else { throw LabError("unreadable machine identifier in \(directory.path)") }
            return id
        }
        func mac() throws -> VZMACAddress {
            guard let mac = VZMACAddress(string: try String(contentsOf: macFile, encoding: .utf8)) else { throw LabError("unreadable MAC in \(directory.path)") }
            return mac
        }
    }

    // MARK: install

    func install(ipsw: URL) async throws -> [String: Any] {
        let image = try await VZMacOSRestoreImage.image(from: ipsw)
        guard let requirements = image.mostFeaturefulSupportedConfiguration, requirements.hardwareModel.isSupported else { throw LabError("this Mac cannot run macOS \(image.operatingSystemVersion.majorVersion).\(image.operatingSystemVersion.minorVersion) from \(ipsw.lastPathComponent)") }
        let staging = root.appendingPathComponent(".macos-base-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let guest = Guest(directory: staging)
        try requirements.hardwareModel.dataRepresentation.write(to: guest.hardwareModelFile)
        _ = try VZMacAuxiliaryStorage(creatingStorageAt: guest.aux, hardwareModel: requirements.hardwareModel, options: [])
        try VZMacMachineIdentifier().dataRepresentation.write(to: guest.identifierFile)
        try VZMACAddress.randomLocallyAdministered().string.write(to: guest.macFile, atomically: true, encoding: .utf8)
        FileManager.default.createFile(atPath: guest.disk.path, contents: nil)
        try FileHandle(forWritingTo: guest.disk).truncate(atOffset: Self.diskBytes)
        let cpus = max(requirements.minimumSupportedCPUCount, 4), memory = max(requirements.minimumSupportedMemorySize, 8 << 30)
        let vm = try MacVM(guest: guest, cpus: cpus, memory: memory)
        let started = Date()
        try await vm.install(from: ipsw)
        let installMs = Int(Date().timeIntervalSince(started) * 1000)
        let version = "\(image.operatingSystemVersion.majorVersion).\(image.operatingSystemVersion.minorVersion).\(image.operatingSystemVersion.patchVersion) (\(image.buildVersion))"
        try version.write(to: staging.appendingPathComponent("macos-version"), atomically: true, encoding: .utf8)
        if FileManager.default.fileExists(atPath: base.path) { try FileManager.default.removeItem(at: base) }
        try FileManager.default.moveItem(at: staging, to: base)
        return ["ok": true, "macos_version": version, "install_ms": installMs, "cpus": cpus, "memory_bytes": memory, "disk_allocated_bytes": privateBytes(Guest(directory: base).disk) ?? -1, "ipsw_bytes": (try? FileManager.default.attributesOfItem(atPath: ipsw.path)[.size] as? Int) ?? -1]
    }

    static let diskBytes: UInt64 = 64 << 30

    // MARK: clones

    /// A new clone of the base: APFS clone of the disk, copied auxiliary storage, a new identifier and MAC.
    func clone(from source: URL? = nil) throws -> Guest {
        let from = Guest(directory: source ?? base)
        guard FileManager.default.fileExists(atPath: from.disk.path) else { throw LabError("blocked: no cached macOS base; run npm run proof -- 16 --tier m") }
        let directory = root.appendingPathComponent("macos-clone-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let guest = Guest(directory: directory)
        _ = try cloneDisk(from.disk, to: guest.disk)
        try FileManager.default.copyItem(at: from.aux, to: guest.aux)
        try FileManager.default.copyItem(at: from.hardwareModelFile, to: guest.hardwareModelFile)
        let password = from.directory.appendingPathComponent("password")
        if FileManager.default.fileExists(atPath: password.path) { try FileManager.default.copyItem(at: password, to: guest.directory.appendingPathComponent("password")) }
        try VZMacMachineIdentifier().dataRepresentation.write(to: guest.identifierFile)
        try VZMACAddress.randomLocallyAdministered().string.write(to: guest.macFile, atomically: true, encoding: .utf8)
        return guest
    }

    func clones() async throws -> [String: Any] {
        let guests = try (0..<3).map { _ in try clone() }
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { for guest in guests { try? FileManager.default.removeItem(at: guest.directory) } } }
        let vms = try guests.map { try MacVM(guest: $0) }
        let started = Date()
        try await vms[0].start(); try await vms[1].start()
        var leases: [String: Int] = [:]
        for (index, guest) in guests.prefix(2).enumerated() { leases["clone_\(index)"] = try await waitForLease(try guest.mac(), since: started) }
        var third = "started"
        do { try await vms[2].start(); try await vms[2].stop() } catch { third = describe(error) }
        let identifiers = try guests.prefix(2).map { try $0.identifier().dataRepresentation.base64EncodedString() }
        let running = vms.prefix(2).map { $0.isRunning }
        for vm in vms.prefix(2) { try await vm.stop() }
        let limited = third.contains("VZErrorDomain") && third.contains("code \(VZError.Code.virtualMachineLimitExceeded.rawValue)")
        return ["ok": running.allSatisfy { $0 } && identifiers[0] != identifiers[1] && limited, "lease_ms": leases, "both_running": running, "distinct_identifiers": identifiers[0] != identifiers[1], "third_vm": third, "third_refused_by_limit": limited, "clone_private_bytes": privateBytes(guests[0].disk) ?? -1]
    }

    // MARK: hibernate

    func hibernate() async throws -> [String: Any] {
        let guest = try clone()
        let vm = try MacVM(guest: guest)
        let started = Date()
        try await vm.start()
        let leaseMs = try await waitForLease(try guest.mac(), since: started)
        try await Task.sleep(nanoseconds: 15_000_000_000)
        let saveStarted = Date()
        try await vm.save(to: guest.savedState)
        let saveMs = Int(Date().timeIntervalSince(saveStarted) * 1000)
        let stateBytes = (try? FileManager.default.attributesOfItem(atPath: guest.savedState.path)[.size] as? Int) ?? -1
        let phase2 = try runSelfJSON(["macos-restore", "--scratch", guest.directory.path, "--json"])
        if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: guest.directory) }
        return ["ok": phase2["running_after"] as? Bool == true, "lease_ms": leaseMs, "save_ms": saveMs, "state_file_bytes": stateBytes, "phase2": phase2]
    }

    func restorePhase(scratch: URL) async throws -> [String: Any] {
        let guest = Guest(directory: scratch)
        let vm = try MacVM(guest: guest)
        let started = Date()
        try await vm.restore(from: guest.savedState)
        let restoreMs = Int(Date().timeIntervalSince(started) * 1000)
        try await Task.sleep(nanoseconds: 15_000_000_000)
        let running = vm.isRunning
        try await vm.stop()
        return ["restore_ms": restoreMs, "running_after": running]
    }

    // MARK: helpers

    /// The guest is up far enough to run its network stack once the NAT's DHCP server leased its MAC an address.
    func waitForLease(_ mac: VZMACAddress, since: Date, timeout: TimeInterval = 600) async throws -> Int {
        let wanted = mac.string.split(separator: ":").map { String(Int($0, radix: 16) ?? -1, radix: 16) }.joined(separator: ":")
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let leases = try? String(contentsOfFile: "/var/db/dhcpd_leases", encoding: .utf8), leases.contains("hw_address=1,\(wanted)\n") {
                return Int(Date().timeIntervalSince(since) * 1000)
            }
            try await Task.sleep(nanoseconds: 2_000_000_000)
        }
        throw LabError("no DHCP lease for \(mac.string) within \(Int(timeout)) s")
    }

    func runSelfJSON(_ arguments: [String]) throws -> [String: Any] {
        let process = Process(); process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); process.arguments = arguments
        let stdout = Pipe(); process.standardOutput = stdout
        try process.run(); let data = stdout.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        let line = String(decoding: data, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? "{}"
        return (try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]) ?? ["error": line]
    }
}

func describe(_ error: Error) -> String { let ns = error as NSError; return "\(ns.domain) code \(ns.code): \(ns.localizedDescription)" }

extension VZMacOSRestoreImage {
    static func image(from url: URL) async throws -> VZMacOSRestoreImage {
        try await withCheckedThrowingContinuation { continuation in load(from: url) { continuation.resume(with: $0) } }
    }
}

/// One macOS guest VM on its own queue: the device set Tart's `--suspendable` mode uses (Mac graphics with no window,
/// Mac keyboard and trackpad, no entropy or audio device), so save/restore validates.
final class MacVM: NSObject, VZVirtualMachineDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "org.localbox.vmlab.macos")
    let vm: VZVirtualMachine
    private(set) var stopReason: String?

    init(guest: MacLab.Guest, cpus: Int = 4, memory: UInt64 = 8 << 30) throws {
        let configuration = VZVirtualMachineConfiguration()
        configuration.bootLoader = VZMacOSBootLoader()
        let platform = VZMacPlatformConfiguration()
        platform.hardwareModel = try guest.hardwareModel()
        platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: guest.aux)
        platform.machineIdentifier = (try? guest.identifier()) ?? VZMacMachineIdentifier()
        configuration.platform = platform
        configuration.cpuCount = cpus
        configuration.memorySize = memory
        let graphics = VZMacGraphicsDeviceConfiguration()
        graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1440, heightInPixels: 900, pixelsPerInch: 80)]
        configuration.graphicsDevices = [graphics]
        configuration.keyboards = [VZMacKeyboardConfiguration()]
        configuration.pointingDevices = [VZMacTrackpadConfiguration()]
        configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: guest.disk, readOnly: false))]
        let network = VZVirtioNetworkDeviceConfiguration(); network.attachment = VZNATNetworkDeviceAttachment(); network.macAddress = try guest.mac()
        configuration.networkDevices = [network]
        configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        try configuration.validate()
        try configuration.validateSaveRestoreSupport()
        let queue = queue
        var made: VZVirtualMachine!
        queue.sync { made = VZVirtualMachine(configuration: configuration, queue: queue) }
        vm = made
        super.init()
        queue.sync { vm.delegate = self }
    }

    var isRunning: Bool { queue.sync { vm.state == .running } }

    func install(from ipsw: URL) async throws {
        let vm = vm
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: ipsw)
                let observation = installer.progress.observe(\.fractionCompleted, options: [.new]) { progress, _ in
                    FileHandle.standardError.write(Data("install \(Int(progress.fractionCompleted * 100))%\n".utf8))
                }
                installer.install { result in _ = observation; continuation.resume(with: result) }
            }
        }
    }
    func start() async throws { try await call { vm, done in vm.start { done($0) } } }
    func start(options: VZMacOSVirtualMachineStartOptions) async throws { try await call { vm, done in vm.start(options: options) { done($0.map { .failure($0) } ?? .success(())) } } }
    /// One host-to-guest vsock connection (the guest's listener may not be up yet; the caller retries).
    func connect(port: UInt32) async throws -> VZVirtioSocketConnection {
        let vm = vm
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                guard let device = vm.socketDevices.first as? VZVirtioSocketDevice else { return continuation.resume(throwing: LabError("no vsock device")) }
                device.connect(toPort: port) { continuation.resume(with: $0.mapError { $0 as Error }) }
            }
        }
    }
    /// Waits for the guest to power itself off (shutdown or halt inside it).
    func waitUntilStopped(timeout: TimeInterval) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if queue.sync(execute: { vm.state == .stopped || vm.state == .error }) { return }; try await Task.sleep(nanoseconds: 2_000_000_000) }
        throw LabError("the guest did not power off within \(Int(timeout)) s")
    }
    func stop() async throws { guard queue.sync(execute: { vm.canStop }) else { return }; try await call { vm, done in vm.stop { done($0.map { .failure($0) } ?? .success(())) } } }
    func save(to url: URL) async throws {
        try await call { vm, done in vm.pause { done($0) } }
        try await call { vm, done in vm.saveMachineStateTo(url: url) { done($0.map { .failure($0) } ?? .success(())) } }
        try await stop()
    }
    func restore(from url: URL) async throws {
        try await call { vm, done in vm.restoreMachineStateFrom(url: url) { done($0.map { .failure($0) } ?? .success(())) } }
        try await call { vm, done in vm.resume { done($0) } }
    }
    private func call(_ body: @escaping (VZVirtualMachine, @escaping (Result<Void, Error>) -> Void) -> Void) async throws {
        let vm = vm
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { body(vm) { continuation.resume(with: $0) } }
        }
    }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) { stopReason = "guest shut down" }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { stopReason = describe(error) }
}
#endif
