import Foundation

#if os(macOS)
import IOKit
import Virtualization

/// Real sandboxes, each provisioned from an image: an APFS clone of its disk, a copy of its boot store, and a new MAC
/// and machine identifier, so two sandboxes from one image never share an identity.
public struct AppleSandboxFactory: SandboxBackendFactory {
    public let images: ImageStore
    public init(images: ImageStore) { self.images = images }
    public func provision(_ record: inout SandboxRecord, in directory: SandboxDirectory) async throws -> [String: String] {
        let clone = try images.cloneForSandbox(record.imageID, into: directory)
        record.os = clone.manifest.os
        record.hardwareModel = clone.manifest.hardwareModel
        record.mac = VZMACAddress.randomLocallyAdministered().string
        record.machineIdentifier = (clone.manifest.os == .linux ? VZGenericMachineIdentifier().dataRepresentation : VZMacMachineIdentifier().dataRepresentation).base64EncodedString()
        return ["disk": clone.disk, "disk_allocated_bytes": String(privateBytes(directory.disk) ?? -1)]
    }
    public func backend(for record: SandboxRecord, in directory: SandboxDirectory) throws -> any SandboxBackend {
        AppleVirtualizationBackend(spec: try VMSpec(record: record, in: directory), sandboxID: record.sandboxID, name: record.name)
    }
}

/// The one translator from `VMSpec` to a Virtualization configuration, so a saved state always restores into the
/// configuration it was saved under: everything comes from the spec, and nothing names the sandbox (its identity
/// reaches the guest only in the host's hello).
public enum SandboxConfigurationBuilder {
    /// The macOS guest's display: the Linux image's desktop size (1440x900), with no window on the host.
    static let macDisplay = (width: 1440, height: 900, pixelsPerInch: 80)

    /// The validated configuration a VM is made from.
    public static func build(_ spec: VMSpec) throws -> VZVirtualMachineConfiguration {
        let configuration = try configuration(for: spec)
        try configuration.validate()
        try configuration.validateSaveRestoreSupport()
        return configuration
    }

    /// The translation alone. Validation needs the virtualization entitlement, which only the signed executables have,
    /// so tests inspect this and the real-VM probes prove `build`.
    static func configuration(for spec: VMSpec) throws -> VZVirtualMachineConfiguration {
        for url in spec.requiredFiles where !FileManager.default.fileExists(atPath: url.path) {
            throw HostDaemonError.unsupported("\(url.path) is missing; a sandbox boots from its own disk and boot store")
        }
        guard let mac = VZMACAddress(string: spec.mac) else { throw HostDaemonError.invalidState("\(spec.mac) is not a MAC address") }
        let configuration = VZVirtualMachineConfiguration()
        configuration.cpuCount = spec.cpus
        configuration.memorySize = spec.memoryBytes
        switch (spec.platform, spec.boot) {
        case (.linux(let identifier), .linuxEFI(let store)):
            let boot = VZEFIBootLoader()
            boot.variableStore = VZEFIVariableStore(url: store)
            configuration.bootLoader = boot
            configuration.platform = try genericPlatform(identifier)
        case (.macos(let identifier, let model), .macos(let storage)):
            guard let hardwareModel = VZMacHardwareModel(dataRepresentation: model), hardwareModel.isSupported else { throw HostDaemonError.unsupported("this Mac cannot run the image's macOS hardware model") }
            guard let machineIdentifier = VZMacMachineIdentifier(dataRepresentation: identifier) else { throw HostDaemonError.invalidState("the record's machine identifier is not a macOS one") }
            let platform = VZMacPlatformConfiguration()
            platform.hardwareModel = hardwareModel
            platform.machineIdentifier = machineIdentifier
            platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: storage)
            configuration.platform = platform
            configuration.bootLoader = VZMacOSBootLoader()
        default:
            throw HostDaemonError.invalidState("a \(spec.platform.os.rawValue) platform cannot boot from \(spec.boot)")
        }
        for device in spec.devices {
            switch device {
            case .virtioBlock:
                configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: spec.disk, readOnly: false))]
            case .natNetwork:
                let network = VZVirtioNetworkDeviceConfiguration()
                network.attachment = VZNATNetworkDeviceAttachment()
                network.macAddress = mac
                configuration.networkDevices = [network]
            case .entropy: configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
            case .vsock: configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]
            case .virtioConsole:
                // Kernel and boot output (hvc0); the guest channel is vsock. Appended, so earlier boots stay readable.
                guard let consoleLog = spec.consoleLog else { continue }
                if !FileManager.default.fileExists(atPath: consoleLog.path) { FileManager.default.createFile(atPath: consoleLog.path, contents: nil) }
                let log = try FileHandle(forWritingTo: consoleLog); log.seekToEndOfFile()
                let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
                serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: log)
                configuration.serialPorts = [serial]
            case .macGraphics:
                let graphics = VZMacGraphicsDeviceConfiguration()
                graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: macDisplay.width, heightInPixels: macDisplay.height, pixelsPerInch: macDisplay.pixelsPerInch)]
                configuration.graphicsDevices = [graphics]
            case .macKeyboard: configuration.keyboards = [VZMacKeyboardConfiguration()]
            case .macTrackpad: configuration.pointingDevices = [VZMacTrackpadConfiguration()]
            }
        }
        return configuration
    }

    private static func genericPlatform(_ identifier: Data) throws -> VZGenericPlatformConfiguration {
        guard let machineIdentifier = VZGenericMachineIdentifier(dataRepresentation: identifier) else { throw HostDaemonError.invalidState("the record's machine identifier is not a Linux one") }
        let platform = VZGenericPlatformConfiguration()
        platform.machineIdentifier = machineIdentifier
        return platform
    }
}

/// Whether a console user's screen is locked (`CGSSessionScreenIsLocked` in the registry's `IOConsoleUsers`).
func consoleScreenIsLocked() -> Bool {
    let root = IORegistryGetRootEntry(kIOMainPortDefault)
    defer { IOObjectRelease(root) }
    let users = IORegistryEntryCreateCFProperty(root, "IOConsoleUsers" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? [[String: Any]]
    return users?.contains { $0["CGSSessionScreenIsLocked"] as? Bool == true } ?? false
}

/// Records why the guest stopped and tells the runtime, so a dead guest is reported instead of surfacing as a closed channel.
final class GuestStopObserver: NSObject, VZVirtualMachineDelegate, @unchecked Sendable {
    private let lock = NSLock(); private var reason: String?; private var handler: (@Sendable (String) -> Void)?
    var stopReason: String? { lock.lock(); defer { lock.unlock() }; return reason }
    func onStop(_ handler: @escaping @Sendable (String) -> Void) { lock.lock(); self.handler = handler; lock.unlock() }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) { stopped("guest shut down") }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { stopped("VM stopped: \(error.localizedDescription)") }
    private func stopped(_ why: String) { lock.lock(); reason = why; let handler = handler; lock.unlock(); handler?(why) }
}

/// One sandbox's VM for one boot. A vsock connection carries GuestService frames.
public actor AppleVirtualizationBackend: HibernateBackend, GuestChannelProvider, GuestControlDialer, GuestReconnecting, GuestStopReporting {
    private let spec: VMSpec
    private let sandboxID: String
    private let name: String
    private var machine: VZVirtualMachine?
    private var guestChannel: FramedFileHandleGuestChannel?
    private var guestConnection: VZVirtioSocketConnection?
    /// vsock port the guest agent listens on (socat in the image's localbox-vsock unit).
    static let guestPort: UInt32 = 1024
    /// vsock port of the guest's control lane (freeze, thaw; the image's localbox-control-vsock unit).
    static let controlPort: UInt32 = 1025
    /// Virtualization asserts that a VM is created and driven on one dispatch queue; every call goes through it.
    private let queue: DispatchQueue
    private let stopObserver = GuestStopObserver()
    /// Why the guest stopped, if it has.
    public func stopReason() -> String? { stopObserver.stopReason }
    public func onGuestStop(_ handler: @escaping @Sendable (String) -> Void) { stopObserver.onStop(handler) }
    /// `sandboxID` and `name` reach the guest in the hello, never the configuration.
    public init(spec: VMSpec, sandboxID: String, name: String) {
        self.spec = spec; self.sandboxID = sandboxID; self.name = name
        queue = DispatchQueue(label: "org.localbox.vm.\(sandboxID)")
    }

    public func start() async throws {
        let vm = try makeMachine()
        try await startMachine(vm)
        machine = vm
        try await attachGuest(vm)
    }

    private func makeMachine() throws -> VZVirtualMachine {
        nonisolated(unsafe) let configuration = try SandboxConfigurationBuilder.build(spec)
        let observer = stopObserver, queue = queue
        nonisolated(unsafe) var made: VZVirtualMachine?
        queue.sync { made = VZVirtualMachine(configuration: configuration, queue: queue); made?.delegate = observer }
        return made!
    }

    private func attachGuest(_ vm: VZVirtualMachine, name: String? = nil) async throws {
        let connection = try await connect(vm, port: Self.guestPort, within: 120)
        guestConnection = connection
        let channel = FramedFileHandleGuestChannel(reader: FileHandle(fileDescriptor: dup(connection.fileDescriptor), closeOnDealloc: true), writer: FileHandle(fileDescriptor: dup(connection.fileDescriptor), closeOnDealloc: true), sandboxID: sandboxID, name: name ?? self.name)
        // A channel is handed out only once the guest announced readiness and received its hello.
        try await channel.waitUntilReady()
        guestChannel = channel
    }
    public func makeGuestChannel() async throws -> any GuestChannel { guard let guestChannel else { throw HostDaemonError.guestUnavailable }; return guestChannel }
    /// The request lane again, on the same running VM, after its agent restarted (an update): the old connection
    /// goes, and the new channel is handed out once the restarted agent announced readiness.
    public func reconnectGuest(name: String) async throws -> any GuestChannel {
        guard let machine else { throw HostDaemonError.guestUnavailable }
        await guestChannel?.close(); guestChannel = nil; guestConnection?.close(); guestConnection = nil
        try await attachGuest(machine, name: name)
        return try await makeGuestChannel()
    }
    /// A new connection to the control lane; its forwarder listens once the guest is up, so a ready guest answers at once.
    public func dialControl() async throws -> any GuestControlChannel {
        guard let machine else { throw HostDaemonError.guestUnavailable }
        nonisolated(unsafe) let connection = try await connect(machine, port: Self.controlPort, within: 10)
        return FramedControlChannel(reader: FileHandle(fileDescriptor: dup(connection.fileDescriptor), closeOnDealloc: true), writer: FileHandle(fileDescriptor: dup(connection.fileDescriptor), closeOnDealloc: true), onClose: { connection.close() })
    }
    /// A guest that already stopped itself is stopped: that is success, not an error.
    public func stop() async throws { guard let machine else { return }; await guestChannel?.close(); if stopObserver.stopReason == nil { try await stopMachine(machine) }; guestConnection?.close(); self.guestConnection = nil; self.guestChannel = nil; self.machine = nil }
    public func pause() async throws { guard let machine else { throw HostDaemonError.invalidState("VM is not running") }; try await pauseMachine(machine) }
    public func resume() async throws { guard let machine else { throw HostDaemonError.invalidState("VM is not running") }; try await resumeMachine(machine) }

    public func save(to url: URL) async throws {
        guard let machine else { throw HostDaemonError.invalidState("VM is not running") }
        try await pauseMachine(machine)
        let temporary = SandboxDirectory(url.deletingLastPathComponent()).temporarySave()
        do {
            try await saveMachineState(machine, to: temporary)
            try atomicReplace(temporary, at: url)
            try await stopMachine(machine)
            await guestChannel?.close(); guestChannel = nil; guestConnection?.close(); guestConnection = nil; self.machine = nil
        } catch {
            try? FileManager.default.removeItem(at: temporary)
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
    /// The guest's forwarders listen once userspace is up, so retry until one accepts, the VM stops or `within` passes.
    private func connect(_ machine: VZVirtualMachine, port: UInt32, within seconds: TimeInterval) async throws -> VZVirtioSocketConnection {
        let deadline = Date().addingTimeInterval(seconds)
        while true {
            do {
                return try await onQueueValue(machine) { vm, done in
                    guard let device = vm.socketDevices.first as? VZVirtioSocketDevice else { return done(.failure(HostDaemonError.unsupported("VM has no virtio socket device"))) }
                    device.connect(toPort: port) { done($0.mapError { $0 as Error }) }
                }
            } catch {
                if let reason = stopObserver.stopReason { throw HostDaemonError.unsupported(reason) }
                if Date() > deadline { throw HostDaemonError.unsupported("guest agent did not accept a vsock connection on port \(port) within \(spoken(seconds)): \(error.localizedDescription)") }
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
