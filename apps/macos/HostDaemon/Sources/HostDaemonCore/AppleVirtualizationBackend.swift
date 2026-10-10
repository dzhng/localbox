import Foundation

#if os(macOS)
import Virtualization

public struct AppleVMConfiguration: Sendable {
    public let kernelURL: URL
    public let initialRamdiskURL: URL
    public let diskURL: URL
    public let cpuCount: Int
    public let memorySize: UInt64
    public init(kernelURL: URL, initialRamdiskURL: URL, diskURL: URL, cpuCount: Int = 4, memorySize: UInt64 = 4 * 1024 * 1024 * 1024) {
        self.kernelURL = kernelURL; self.initialRamdiskURL = initialRamdiskURL; self.diskURL = diskURL; self.cpuCount = cpuCount; self.memorySize = memorySize
    }
}

/// Native lifecycle owner. Guest readiness is established by the future serial/vsock bridge before attach().
public actor AppleVirtualizationBackend: VMBackend {
    private let image: AppleVMConfiguration
    private var machine: VZVirtualMachine?
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
        try configuration.validate()
        let vm = VZVirtualMachine(configuration: configuration)
        try await startMachine(vm)
        machine = vm
    }
    public func stop() async throws { guard let machine else { return }; try await stopMachine(machine); self.machine = nil }
    public func pause() async throws { guard let machine else { throw HostDaemonError.invalidState("VM is not running") }; try await pauseMachine(machine) }
    public func resume() async throws { guard let machine else { throw HostDaemonError.invalidState("VM is not running") }; try await resumeMachine(machine) }
    public func reset() async throws { try await stop(); try Data().write(to: image.diskURL, options: .atomic) }

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
