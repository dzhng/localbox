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

/// One sandbox's VM for one boot, and its request lane once the guest agent is ready.
public actor AppleVirtualizationBackend: HibernateBackend, GuestChannelProvider, GuestControlDialer, GuestReconnecting, GuestStopReporting {
    private let spec: VMSpec
    private let sandboxID: String
    private let name: String
    private var machine: VirtualMachine?
    private var guestChannel: FramedFileHandleGuestChannel?
    private var stopHandler: (@Sendable (String) -> Void)?

    /// `sandboxID` and `name` reach the guest in the hello, never the configuration.
    public init(spec: VMSpec, sandboxID: String, name: String) {
        self.spec = spec; self.sandboxID = sandboxID; self.name = name
    }

    /// Why the guest stopped, if it has.
    public func stopReason() -> String? { machine?.stopReason }
    public func onGuestStop(_ handler: @escaping @Sendable (String) -> Void) { stopHandler = handler; machine?.onStop(handler) }

    /// How long a boot or restore waits for the guest agent's request lane: a macOS first boot answers in 10–30 s.
    static let guestWait: TimeInterval = 120

    public func start() async throws {
        let vm = try makeMachine()
        try await vm.start()
        try await attachGuest(vm)
    }

    private func makeMachine() throws -> VirtualMachine {
        let vm = try VirtualMachine(spec: spec)
        if let stopHandler { vm.onStop(stopHandler) }
        machine = vm
        return vm
    }

    private func attachGuest(_ vm: VirtualMachine, name: String? = nil) async throws {
        guestChannel = try await vm.openRequestLane(sandboxID: sandboxID, name: name ?? self.name, until: Date().addingTimeInterval(Self.guestWait))
    }

    public func makeGuestChannel() async throws -> any GuestChannel { guard let guestChannel else { throw HostDaemonError.guestUnavailable }; return guestChannel }

    /// The request lane again, on the same running VM, after its agent restarted (an update): the old lane goes, and the
    /// new one is handed out once the restarted agent announced readiness.
    public func reconnectGuest(name: String) async throws -> any GuestChannel {
        guard let machine else { throw HostDaemonError.guestUnavailable }
        await guestChannel?.close(); guestChannel = nil
        try await attachGuest(machine, name: name)
        return try await makeGuestChannel()
    }

    public func dialControl() async throws -> any GuestControlChannel {
        guard let machine else { throw HostDaemonError.guestUnavailable }
        return try await machine.dialControl()
    }

    /// A guest that already stopped itself is stopped: that is success, not an error.
    public func stop() async throws {
        guard let machine else { return }
        await guestChannel?.close(); guestChannel = nil
        try await machine.stop()
        self.machine = nil
    }

    public func pause() async throws { guard let machine else { throw HostDaemonError.invalidState("VM is not running") }; try await machine.pause() }
    public func resume() async throws { guard let machine else { throw HostDaemonError.invalidState("VM is not running") }; try await machine.resume() }

    public func save(to url: URL) async throws {
        guard let machine else { throw HostDaemonError.invalidState("VM is not running") }
        try await machine.pause()
        let temporary = SandboxDirectory(url.deletingLastPathComponent()).temporarySave()
        do {
            try await machine.saveState(to: temporary)
            if FileManager.default.fileExists(atPath: url.path) { _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary) } else { try FileManager.default.moveItem(at: temporary, to: url) }
            try await machine.stop()
            await guestChannel?.close(); guestChannel = nil; self.machine = nil
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            try? await machine.resume()
            throw consoleScreenIsLocked() ? HostDaemonError.screenLocked : error
        }
    }

    public func restore(from url: URL) async throws {
        guard FileManager.default.fileExists(atPath: url.path) else { throw HostDaemonError.invalidState("saved machine state is missing") }
        let vm = try makeMachine()
        try await vm.restoreState(from: url)
        try await vm.resume()
        try await attachGuest(vm)
    }
}
#endif
