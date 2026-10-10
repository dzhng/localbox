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
    public init(kernelURL: URL, initialRamdiskURL: URL, diskURL: URL, templateDiskURL: URL? = nil, cpuCount: Int = 4, memorySize: UInt64 = 4 * 1024 * 1024 * 1024) {
        self.kernelURL = kernelURL; self.initialRamdiskURL = initialRamdiskURL; self.diskURL = diskURL; self.templateDiskURL = templateDiskURL; self.cpuCount = cpuCount; self.memorySize = memorySize
    }
}

/// Native lifecycle owner. A named virtio-console port carries GuestService frames.
public actor AppleVirtualizationBackend: VMBackend, GuestChannelProvider {
    private let image: AppleVMConfiguration
    private var machine: VZVirtualMachine?
    private var guestChannel: FramedFileHandleGuestChannel?
    private var serialAttachment: VZFileHandleSerialPortAttachment?
    public init(image: AppleVMConfiguration) { self.image = image }
    public func start() async throws {
        guard FileManager.default.fileExists(atPath: image.kernelURL.path), FileManager.default.fileExists(atPath: image.initialRamdiskURL.path), FileManager.default.fileExists(atPath: image.diskURL.path) else { throw HostDaemonError.unsupported("pinned ARM64 kernel, initrd, and persistent disk are required") }
        let configuration = VZVirtualMachineConfiguration()
        let boot = VZLinuxBootLoader(kernelURL: image.kernelURL)
        boot.initialRamdiskURL = image.initialRamdiskURL
        boot.commandLine = "console=hvc0 root=/dev/vda rw"
        configuration.bootLoader = boot
        configuration.cpuCount = image.cpuCount
        configuration.memorySize = image.memorySize
        let storage = try VZDiskImageStorageDeviceAttachment(url: image.diskURL, readOnly: false)
        configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: storage)]
        configuration.networkDevices = [VZVirtioNetworkDeviceConfiguration()]
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        // Virtualization writes bytes to the guest through
        // `fileHandleForReading`, and exposes guest bytes on
        // `fileHandleForWriting`. Pass the pipe ends (rather than the read
        // ends) so the guest's stdin/stdout cannot be inverted or deadlocked.
        let toGuest = Pipe(); let fromGuest = Pipe()
        let attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: toGuest.fileHandleForWriting, fileHandleForWriting: fromGuest.fileHandleForReading)
        let port = VZVirtioConsolePortConfiguration(); port.name = "org.agent-computer.guest"; port.isConsole = false; port.attachment = attachment
        let console = VZVirtioConsoleDeviceConfiguration(); console.ports[0] = port
        configuration.consoleDevices = [console]
        try configuration.validate()
        let vm = VZVirtualMachine(configuration: configuration)
        try await startMachine(vm)
        machine = vm; serialAttachment = attachment; guestChannel = FramedFileHandleGuestChannel(reader: fromGuest.fileHandleForReading, writer: toGuest.fileHandleForWriting)
    }
    public func makeGuestChannel() async throws -> any GuestChannel { guard let guestChannel else { throw HostDaemonError.guestUnavailable }; return guestChannel }
    public func stop() async throws { guard let machine else { return }; await guestChannel?.close(); try await stopMachine(machine); self.guestChannel = nil; self.serialAttachment = nil; self.machine = nil }
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

    private func startMachine(_ machine: VZVirtualMachine) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            machine.start { result in continuation.resume(with: result.map { () }) }
        }
    }
    private func stopMachine(_ machine: VZVirtualMachine) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            machine.stop { error in if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: ()) } }
        }
    }
    private func pauseMachine(_ machine: VZVirtualMachine) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            machine.pause { result in continuation.resume(with: result.map { () }) }
        }
    }
    private func resumeMachine(_ machine: VZVirtualMachine) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            machine.resume { result in continuation.resume(with: result.map { () }) }
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
}
#endif
