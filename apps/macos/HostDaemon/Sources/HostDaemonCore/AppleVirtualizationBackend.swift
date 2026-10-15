import Foundation

/// The boot artifacts every sandbox on this Mac shares: kernel, initrd and the ext4 template its disk is cloned from.
public struct SandboxArtifacts: Sendable {
    public let kernelURL: URL
    public let initialRamdiskURL: URL
    public let templateDiskURL: URL
    /// Extra kernel arguments for lab diagnostics (vmlab `--kernel-args`); never identity, which the guest takes from the host's hello.
    public let extraKernelArguments: String
    public init(kernelURL: URL, initialRamdiskURL: URL, templateDiskURL: URL, extraKernelArguments: String = "") {
        self.kernelURL = kernelURL; self.initialRamdiskURL = initialRamdiskURL; self.templateDiskURL = templateDiskURL; self.extraKernelArguments = extraKernelArguments
    }
    /// The layout `npm run image:boot` writes: `kernel`, `initrd`, `template.img`.
    public init(directory: URL, extraKernelArguments: String = "") {
        self.init(kernelURL: directory.appendingPathComponent("kernel"), initialRamdiskURL: directory.appendingPathComponent("initrd"), templateDiskURL: directory.appendingPathComponent("template.img"), extraKernelArguments: extraKernelArguments)
    }
}

#if os(macOS)
import IOKit
import Virtualization

/// Real sandboxes: each disk is an APFS clone of the template, each has its own MAC and machine identifier.
public struct AppleSandboxFactory: SandboxBackendFactory {
    public let artifacts: SandboxArtifacts
    public init(artifacts: SandboxArtifacts) { self.artifacts = artifacts }
    public func provision(_ record: inout SandboxRecord, in directory: SandboxDirectory) throws -> [String: String] {
        guard FileManager.default.fileExists(atPath: artifacts.templateDiskURL.path) else { throw HostDaemonError.unsupported("template disk \(artifacts.templateDiskURL.path) is missing") }
        let disk = try cloneDisk(artifacts.templateDiskURL, to: directory.disk)
        record.mac = VZMACAddress.randomLocallyAdministered().string
        record.machineIdentifier = VZGenericMachineIdentifier().dataRepresentation.base64EncodedString()
        return ["disk": disk, "disk_allocated_bytes": String(privateBytes(directory.disk) ?? -1)]
    }
    public func backend(for record: SandboxRecord, in directory: SandboxDirectory) throws -> any SandboxBackend {
        AppleVirtualizationBackend(record: record, directory: directory, artifacts: artifacts)
    }
}

/// The only place a VM configuration is made, so a saved state always restores into the configuration it was saved
/// under: everything comes from the record and the shared artifacts, and nothing names the sandbox: its identity reaches the guest only in the host's hello.
public enum SandboxConfigurationBuilder {
    public static func build(_ record: SandboxRecord, in directory: SandboxDirectory, artifacts: SandboxArtifacts) throws -> VZVirtualMachineConfiguration {
        for url in [artifacts.kernelURL, artifacts.initialRamdiskURL, directory.disk] where !FileManager.default.fileExists(atPath: url.path) {
            throw HostDaemonError.unsupported("\(url.path) is missing; a sandbox needs the ARM64 kernel, initrd and its disk clone")
        }
        guard let mac = record.mac.flatMap(VZMACAddress.init(string:)) else { throw HostDaemonError.invalidState("\(record.name) has no MAC address in its record") }
        guard let identifier = record.machineIdentifier.flatMap({ Data(base64Encoded: $0) }).flatMap(VZGenericMachineIdentifier.init(dataRepresentation:)) else { throw HostDaemonError.invalidState("\(record.name) has no machine identifier in its record") }
        let configuration = VZVirtualMachineConfiguration()
        let boot = VZLinuxBootLoader(kernelURL: artifacts.kernelURL)
        boot.initialRamdiskURL = artifacts.initialRamdiskURL
        boot.commandLine = (["console=hvc0 root=/dev/vda rw"] + (artifacts.extraKernelArguments.isEmpty ? [] : [artifacts.extraKernelArguments])).joined(separator: " ")
        configuration.bootLoader = boot
        configuration.cpuCount = record.cpus
        configuration.memorySize = record.memoryBytes
        configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: directory.disk, readOnly: false))]
        let network = VZVirtioNetworkDeviceConfiguration()
        network.attachment = VZNATNetworkDeviceAttachment()
        network.macAddress = mac
        configuration.networkDevices = [network]
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        // Kernel and boot output (hvc0); the guest channel is vsock. Appended, so earlier boots stay readable.
        if !FileManager.default.fileExists(atPath: directory.consoleLog.path) { FileManager.default.createFile(atPath: directory.consoleLog.path, contents: nil) }
        let log = try FileHandle(forWritingTo: directory.consoleLog); log.seekToEndOfFile()
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: log)
        configuration.serialPorts = [serial]
        let platform = VZGenericPlatformConfiguration()
        platform.machineIdentifier = identifier
        configuration.platform = platform
        try configuration.validate()
        try configuration.validateSaveRestoreSupport()
        return configuration
    }
}

/// Whether a console user's screen is locked (`CGSSessionScreenIsLocked` in the registry's `IOConsoleUsers`).
func consoleScreenIsLocked() -> Bool {
    let root = IORegistryGetRootEntry(kIOMainPortDefault)
    defer { IOObjectRelease(root) }
    let users = IORegistryEntryCreateCFProperty(root, "IOConsoleUsers" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? [[String: Any]]
    return users?.contains { $0["CGSSessionScreenIsLocked"] as? Bool == true } ?? false
}

/// Records why the guest stopped, so a dead guest is reported instead of surfacing as a closed channel.
final class GuestStopObserver: NSObject, VZVirtualMachineDelegate, @unchecked Sendable {
    private let lock = NSLock(); private var reason: String?
    var stopReason: String? { lock.lock(); defer { lock.unlock() }; return reason }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) { lock.lock(); reason = "guest shut down"; lock.unlock() }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { lock.lock(); reason = "VM stopped: \(error.localizedDescription)"; lock.unlock() }
}

/// One sandbox's VM for one boot. A vsock connection carries GuestService frames.
public actor AppleVirtualizationBackend: HibernateBackend, GuestChannelProvider {
    private let record: SandboxRecord
    private let directory: SandboxDirectory
    private let artifacts: SandboxArtifacts
    private var machine: VZVirtualMachine?
    private var guestChannel: FramedFileHandleGuestChannel?
    private var guestConnection: VZVirtioSocketConnection?
    /// vsock port the guest agent listens on (socat in the image's localbox-vsock unit).
    static let guestPort: UInt32 = 1024
    /// Virtualization asserts that a VM is created and driven on one dispatch queue; every call goes through it.
    private let queue: DispatchQueue
    private let stopObserver = GuestStopObserver()
    /// Why the guest stopped, if it has.
    public func stopReason() -> String? { stopObserver.stopReason }
    public init(record: SandboxRecord, directory: SandboxDirectory, artifacts: SandboxArtifacts) {
        self.record = record; self.directory = directory; self.artifacts = artifacts
        queue = DispatchQueue(label: "org.localbox.vm.\(record.sandboxID)")
    }

    public func start() async throws {
        let vm = try makeMachine()
        try await startMachine(vm)
        machine = vm
        try await attachGuest(vm)
    }

    private func makeMachine() throws -> VZVirtualMachine {
        nonisolated(unsafe) let configuration = try SandboxConfigurationBuilder.build(record, in: directory, artifacts: artifacts)
        let observer = stopObserver, queue = queue
        nonisolated(unsafe) var made: VZVirtualMachine?
        queue.sync { made = VZVirtualMachine(configuration: configuration, queue: queue); made?.delegate = observer }
        return made!
    }

    private func attachGuest(_ vm: VZVirtualMachine) async throws {
        let connection = try await connectGuest(vm)
        guestConnection = connection
        let channel = FramedFileHandleGuestChannel(reader: FileHandle(fileDescriptor: dup(connection.fileDescriptor), closeOnDealloc: true), writer: FileHandle(fileDescriptor: dup(connection.fileDescriptor), closeOnDealloc: true), sandboxID: record.sandboxID, name: record.name)
        // A channel is handed out only once the guest announced readiness and received its hello.
        try await channel.waitUntilReady()
        guestChannel = channel
    }
    public func makeGuestChannel() async throws -> any GuestChannel { guard let guestChannel else { throw HostDaemonError.guestUnavailable }; return guestChannel }
    public func stop() async throws { guard let machine else { return }; await guestChannel?.close(); try await stopMachine(machine); guestConnection?.close(); self.guestConnection = nil; self.guestChannel = nil; self.machine = nil }
    public func pause() async throws { guard let machine else { throw HostDaemonError.invalidState("VM is not running") }; try await pauseMachine(machine) }
    public func resume() async throws { guard let machine else { throw HostDaemonError.invalidState("VM is not running") }; try await resumeMachine(machine) }

    public func save(to url: URL) async throws {
        guard let machine else { throw HostDaemonError.invalidState("VM is not running") }
        try await pauseMachine(machine)
        do {
            let temporary = url.deletingLastPathComponent().appendingPathComponent(".save-\(UUID().uuidString).vzvmsave")
            try await saveMachineState(machine, to: temporary)
            try atomicReplace(temporary, at: url)
            try await stopMachine(machine)
            await guestChannel?.close(); guestChannel = nil; guestConnection?.close(); guestConnection = nil; self.machine = nil
        } catch {
            try? await resumeMachine(machine)
            throw consoleScreenIsLocked() ? HostDaemonError.screenLocked : error
        }
    }

    public func restore(from url: URL) async throws {
        guard FileManager.default.fileExists(atPath: url.path) else { throw HostDaemonError.invalidState("saved machine state is missing") }
        let vm = try makeMachine()
        try await restoreMachineState(vm, from: url)
        machine = vm
        try await resumeMachine(vm)
        try await attachGuest(vm)
    }

    private func startMachine(_ machine: VZVirtualMachine) async throws {
        try await onQueue(machine) { vm, done in vm.start { done($0.map { () }) } }
    }
    private func stopMachine(_ machine: VZVirtualMachine) async throws {
        try await onQueue(machine) { vm, done in vm.stop { error in done(error.map { .failure($0) } ?? .success(())) } }
    }
    private func pauseMachine(_ machine: VZVirtualMachine) async throws {
        try await onQueue(machine) { vm, done in vm.pause { done($0.map { () }) } }
    }
    private func resumeMachine(_ machine: VZVirtualMachine) async throws {
        try await onQueue(machine) { vm, done in vm.resume { done($0.map { () }) } }
    }
    private func saveMachineState(_ machine: VZVirtualMachine, to url: URL) async throws {
        try await onQueue(machine) { vm, done in vm.saveMachineStateTo(url: url) { error in done(error.map { .failure($0) } ?? .success(())) } }
    }
    private func restoreMachineState(_ machine: VZVirtualMachine, from url: URL) async throws {
        try await onQueue(machine) { vm, done in vm.restoreMachineStateFrom(url: url) { error in done(error.map { .failure($0) } ?? .success(())) } }
    }

    private func atomicReplace(_ temporary: URL, at url: URL) throws {
        if FileManager.default.fileExists(atPath: url.path) { _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary) } else { try FileManager.default.moveItem(at: temporary, to: url) }
    }
    /// The guest agent listens once userspace is up, so retry until it accepts or the VM stops.
    private func connectGuest(_ machine: VZVirtualMachine) async throws -> VZVirtioSocketConnection {
        let deadline = Date().addingTimeInterval(120)
        while true {
            do {
                return try await onQueueValue(machine) { vm, done in
                    guard let device = vm.socketDevices.first as? VZVirtioSocketDevice else { return done(.failure(HostDaemonError.unsupported("VM has no virtio socket device"))) }
                    device.connect(toPort: Self.guestPort) { done($0.mapError { $0 as Error }) }
                }
            } catch {
                if let reason = stopObserver.stopReason { throw HostDaemonError.unsupported(reason) }
                if Date() > deadline { throw HostDaemonError.unsupported("guest agent did not accept a vsock connection on port \(Self.guestPort) within 120 s: \(error.localizedDescription)") }
                try await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }
    /// Runs one lifecycle call on the VM's queue and awaits its completion handler.
    private func onQueue(_ machine: VZVirtualMachine, _ body: @escaping @Sendable (VZVirtualMachine, @escaping @Sendable (Result<Void, Error>) -> Void) -> Void) async throws {
        try await onQueueValue(machine, body)
    }
    private func onQueueValue<T>(_ machine: VZVirtualMachine, _ body: @escaping @Sendable (VZVirtualMachine, @escaping @Sendable (Result<T, Error>) -> Void) -> Void) async throws -> T {
        nonisolated(unsafe) let vm = machine
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
            queue.async { body(vm) { continuation.resume(with: $0) } }
        }
    }
}
#endif
