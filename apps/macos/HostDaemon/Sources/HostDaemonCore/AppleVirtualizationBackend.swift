import Foundation

#if os(macOS)
import Virtualization

public struct AppleVMConfiguration: Sendable {
    public let kernelURL: URL
    public let initialRamdiskURL: URL
    public let diskURL: URL
    public let templateDiskURL: URL?
    public let cpuCount: Int
    public let memorySize: UInt64
    /// Kernel and boot output (hvc0) is appended here; the guest channel is a separate port.
    public let consoleLogURL: URL?
    /// Extra kernel arguments for lab diagnostics (vmlab `--kernel-args`).
    public let extraKernelArguments: String
    public let identityDirectoryURL: URL?
    public init(kernelURL: URL, initialRamdiskURL: URL, diskURL: URL, templateDiskURL: URL? = nil, cpuCount: Int = 4, memorySize: UInt64 = 4 * 1024 * 1024 * 1024, consoleLogURL: URL? = nil, extraKernelArguments: String = "", identityDirectoryURL: URL? = nil) {
        self.kernelURL = kernelURL; self.initialRamdiskURL = initialRamdiskURL; self.diskURL = diskURL; self.templateDiskURL = templateDiskURL; self.cpuCount = cpuCount; self.memorySize = memorySize; self.consoleLogURL = consoleLogURL; self.extraKernelArguments = extraKernelArguments; self.identityDirectoryURL = identityDirectoryURL
    }
}

/// Records why the guest stopped, so a dead guest is reported instead of surfacing as a closed channel.
final class GuestStopObserver: NSObject, VZVirtualMachineDelegate, @unchecked Sendable {
    private let lock = NSLock(); private var reason: String?
    var stopReason: String? { lock.lock(); defer { lock.unlock() }; return reason }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) { lock.lock(); reason = "guest shut down"; lock.unlock() }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { lock.lock(); reason = "VM stopped: \(error.localizedDescription)"; lock.unlock() }
}

/// Native lifecycle owner. A named virtio-console port carries GuestService frames.
public actor AppleVirtualizationBackend: HibernateBackend, GuestChannelProvider {
    private let image: AppleVMConfiguration
    private var machine: VZVirtualMachine?
    private var guestChannel: FramedFileHandleGuestChannel?
    private var guestConnection: VZVirtioSocketConnection?
    /// vsock port the guest agent listens on (socat in the image's localbox-guest unit).
    static let guestPort: UInt32 = 1024
    /// Virtualization asserts that a VM is created and driven on one dispatch queue; every call goes through it.
    private let queue = DispatchQueue(label: "org.localbox.vm")
    private let stopObserver = GuestStopObserver()
    /// Why the guest stopped, if it has.
    public func stopReason() -> String? { stopObserver.stopReason }
    public init(image: AppleVMConfiguration) { self.image = image }
    public func start() async throws {
        guard FileManager.default.fileExists(atPath: image.kernelURL.path), FileManager.default.fileExists(atPath: image.initialRamdiskURL.path), FileManager.default.fileExists(atPath: image.diskURL.path) else { throw HostDaemonError.unsupported("pinned ARM64 kernel, initrd, and persistent disk are required") }
        let configuration = try makeConfiguration()
        try configuration.validate()
        let vm = VZVirtualMachine(configuration: configuration, queue: queue)
        nonisolated(unsafe) let unsafeVM = vm
        queue.sync { unsafeVM.delegate = stopObserver }
        try await startMachine(vm)
        machine = vm
        try await attachGuest(vm)
    }

    private func makeConfiguration() throws -> VZVirtualMachineConfiguration {
        let configuration = VZVirtualMachineConfiguration()
        let boot = VZLinuxBootLoader(kernelURL: image.kernelURL)
        boot.initialRamdiskURL = image.initialRamdiskURL
        boot.commandLine = ([image.consoleLogURL == nil ? "root=/dev/vda rw" : "console=hvc0 root=/dev/vda rw"] + (image.extraKernelArguments.isEmpty ? [] : [image.extraKernelArguments])).joined(separator: " ")
        configuration.bootLoader = boot
        configuration.cpuCount = image.cpuCount
        configuration.memorySize = image.memorySize
        let storage = try VZDiskImageStorageDeviceAttachment(url: image.diskURL, readOnly: false)
        configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: storage)]
        let network = VZVirtioNetworkDeviceConfiguration()
        network.attachment = VZNATNetworkDeviceAttachment()
        network.macAddress = try loadOrCreateMAC()
        configuration.networkDevices = [network]
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        if let log = image.consoleLogURL {
            FileManager.default.createFile(atPath: log.path, contents: nil)
            let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
            serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: try FileHandle(forWritingTo: log))
            configuration.serialPorts = [serial]
        }
        let platform = VZGenericPlatformConfiguration()
        platform.machineIdentifier = try loadOrCreateMachineIdentifier()
        configuration.platform = platform
        return configuration
    }

    private func attachGuest(_ vm: VZVirtualMachine) async throws {
        let connection = try await connectGuest(vm)
        guestConnection = connection
        let channel = FramedFileHandleGuestChannel(reader: FileHandle(fileDescriptor: dup(connection.fileDescriptor), closeOnDealloc: true), writer: FileHandle(fileDescriptor: dup(connection.fileDescriptor), closeOnDealloc: true))
        // A channel is handed out only once the guest announced readiness and received its hello.
        try await channel.waitUntilReady()
        guestChannel = channel
    }
    public func makeGuestChannel() async throws -> any GuestChannel { guard let guestChannel else { throw HostDaemonError.guestUnavailable }; return guestChannel }
    public func stop() async throws { guard let machine else { return }; await guestChannel?.close(); try await stopMachine(machine); guestConnection?.close(); self.guestConnection = nil; self.guestChannel = nil; self.machine = nil }
    public func pause() async throws { guard let machine else { throw HostDaemonError.invalidState("VM is not running") }; try await pauseMachine(machine) }
    public func resume() async throws { guard let machine else { throw HostDaemonError.invalidState("VM is not running") }; try await resumeMachine(machine) }
    public func reset() async throws {
        guard let template = image.templateDiskURL else { throw HostDaemonError.unsupported("reset requires an immutable template disk") }
        guard FileManager.default.fileExists(atPath: template.path) else { throw HostDaemonError.unsupported("reset template disk is missing") }
        try await stop()
        let temporary = image.diskURL.deletingLastPathComponent().appendingPathComponent(".\(image.diskURL.lastPathComponent).reset-\(UUID().uuidString)")
        do {
            try FileManager.default.copyItem(at: template, to: temporary)
            if FileManager.default.fileExists(atPath: image.diskURL.path) {
                _ = try FileManager.default.replaceItemAt(image.diskURL, withItemAt: temporary)
            } else {
                try FileManager.default.moveItem(at: temporary, to: image.diskURL)
            }
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }

    public func validateSaveRestoreSupport() async throws {
        let configuration = try makeConfiguration()
        try configuration.validate()
        try configuration.validateSaveRestoreSupport()
    }

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
            throw error
        }
    }

    public func restore(from url: URL) async throws {
        guard FileManager.default.fileExists(atPath: url.path) else { throw HostDaemonError.invalidState("saved machine state is missing") }
        let configuration = try makeConfiguration(); try configuration.validate(); try configuration.validateSaveRestoreSupport()
        let vm = VZVirtualMachine(configuration: configuration, queue: queue)
        nonisolated(unsafe) let unsafeVM = vm; queue.sync { unsafeVM.delegate = stopObserver }
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

    private func identityURL(_ name: String) -> URL {
        (image.identityDirectoryURL ?? image.diskURL.deletingLastPathComponent()).appendingPathComponent(name)
    }
    private func loadOrCreateMAC() throws -> VZMACAddress {
        let url = identityURL("mac-address")
        if let value = try? String(contentsOf: url, encoding: .utf8), let mac = VZMACAddress(string: value.trimmingCharacters(in: .whitespacesAndNewlines)) { return mac }
        let mac = VZMACAddress.randomLocallyAdministered(); try atomicWrite(Data(mac.string.utf8), to: url); return mac
    }
    private func loadOrCreateMachineIdentifier() throws -> VZGenericMachineIdentifier {
        let url = identityURL("machine-identifier")
        if let data = try? Data(contentsOf: url), let identifier = try? VZGenericMachineIdentifier(dataRepresentation: data) { return identifier }
        let identifier = VZGenericMachineIdentifier(); try atomicWrite(identifier.dataRepresentation, to: url); return identifier
    }
    private func atomicWrite(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let temporary = url.appendingPathExtension("tmp-\(UUID().uuidString)")
        try data.write(to: temporary, options: .atomic); try atomicReplace(temporary, at: url)
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
#else
public struct AppleVMConfiguration: Sendable { public init() {} }
public actor AppleVirtualizationBackend: VMBackend {
    public init(image: AppleVMConfiguration = AppleVMConfiguration()) {}
    public func start() async throws { throw HostDaemonError.unsupported("Apple Virtualization is available only on macOS") }
    public func stop() async throws {}
    public func pause() async throws {}
    public func resume() async throws {}
    public func reset() async throws {}
    public func validateSaveRestoreSupport() async throws { throw HostDaemonError.unsupported("Apple Virtualization is available only on macOS") }
    public func save(to: URL) async throws { throw HostDaemonError.unsupported("Apple Virtualization is available only on macOS") }
    public func restore(from: URL) async throws { throw HostDaemonError.unsupported("Apple Virtualization is available only on macOS") }
}
#endif
