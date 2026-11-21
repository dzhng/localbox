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

    public func spec(cpus: Int = MacVirtualMachine.cpus, memoryBytes: UInt64 = MacVirtualMachine.memoryBytes) throws -> VMSpec {
        VMSpec(platform: .macos(machineIdentifier: try Data(contentsOf: machineIdentifier), hardwareModel: try Data(contentsOf: hardwareModel)),
               boot: .macos(auxiliaryStorage: auxiliaryStorage), cpus: cpus, memoryBytes: memoryBytes, disk: disk, mac: try macAddress(), consoleLog: nil)
    }
}

/// One macOS VM outside the sandbox runtime: installing an IPSW, booting with provisioning options or into Recovery,
/// stopping, waiting for the guest to power itself off, vsock streams and the Recovery VNC screen. An image build and
/// the macOS lab both drive guests through it; sandboxes use `AppleVirtualizationBackend`. Made from a `VMSpec` through
/// `SandboxConfigurationBuilder`, so every macOS guest has the same suspendable device set.
public final class MacVirtualMachine: NSObject, VZVirtualMachineDelegate, @unchecked Sendable {
    /// What a build and the lab give a macOS guest: 4 CPUs and 8 GiB, the most Apple's install requirements ask for.
    public static let cpus = 4
    public static let memoryBytes: UInt64 = 8 << 30

    /// Virtualization asserts a VM is made and driven on one queue; every call goes through it.
    public let queue: DispatchQueue
    public let machine: VZVirtualMachine
    private let lock = NSLock()
    private var reason: String?
    /// Why the guest stopped, once it has (a shutdown inside it, or an error).
    public var stopReason: String? { lock.withLock { reason } }

    public init(spec: VMSpec) throws {
        nonisolated(unsafe) let configuration = try SandboxConfigurationBuilder.build(spec)
        let queue = DispatchQueue(label: "org.localbox.macos-vm")
        nonisolated(unsafe) var made: VZVirtualMachine?
        queue.sync { made = VZVirtualMachine(configuration: configuration, queue: queue) }
        self.queue = queue
        machine = made!
        super.init()
        queue.sync { machine.delegate = self }
    }

    public var isRunning: Bool { queue.sync { machine.state == .running } }

    /// How a boot starts: a plain boot, the first boot of a fresh install with a user made for it (no Setup Assistant),
    /// or Recovery.
    public enum Start: Sendable {
        case normal
        case provisioning(MacProvisioningUser)
        case recovery
    }

    public func start(_ how: Start = .normal) async throws {
        switch how {
        case .normal:
            try await call { vm, done in vm.start { done($0) } }
        case .provisioning(let user):
            guard #available(macOS 27, *) else { throw HostDaemonError.unsupported("guest provisioning needs macOS 27 on this Mac") }
            let options = VZMacOSVirtualMachineStartOptions()
            let provisioning = VZMacGuestProvisioningOptions()
            provisioning.fullName = user.fullName; provisioning.username = user.name; provisioning.password = user.password
            provisioning.logsInAutomatically = true; provisioning.enablesRemoteLogin = true
            try options.setGuestProvisioning(provisioning)
            try await start(options)
        case .recovery:
            let options = VZMacOSVirtualMachineStartOptions(); options.startUpFromMacOSRecovery = true
            try await start(options)
        }
    }

    private func start(_ options: VZMacOSVirtualMachineStartOptions) async throws {
        nonisolated(unsafe) let options = options
        try await call { vm, done in vm.start(options: options) { done($0.map { .failure($0) } ?? .success(())) } }
    }

    /// Installs `ipsw` onto this VM's disk (made from the restore image's requirements); `progress` gets 0…1.
    public func install(from ipsw: URL, progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws {
        nonisolated(unsafe) let vm = machine
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: ipsw)
                let observation = installer.progress.observe(\.fractionCompleted, options: [.new]) { observed, _ in progress(observed.fractionCompleted) }
                installer.install { result in _ = observation; continuation.resume(with: result) }
            }
        }
    }

    /// Stops the VM at once (a pulled plug); a VM that already stopped is left alone.
    public func stop() async throws {
        guard queue.sync(execute: { machine.canStop }) else { return }
        try await call { vm, done in vm.stop { done($0.map { .failure($0) } ?? .success(())) } }
    }

    /// Waits for the guest to power itself off (a shutdown or halt inside it).
    public func waitUntilStopped(timeout: TimeInterval) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if queue.sync(execute: { machine.state == .stopped || machine.state == .error }) { return }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        throw HostDaemonError.unsupported("the macOS guest did not power off within \(spoken(timeout))")
    }

    /// Pauses, writes the machine state to `url`, then stops.
    public func save(to url: URL) async throws {
        try await call { vm, done in vm.pause { done($0) } }
        try await call { vm, done in vm.saveMachineStateTo(url: url) { done($0.map { .failure($0) } ?? .success(())) } }
        try await stop()
    }

    public func restore(from url: URL) async throws {
        try await call { vm, done in vm.restoreMachineStateFrom(url: url) { done($0.map { .failure($0) } ?? .success(())) } }
        try await call { vm, done in vm.resume { done($0) } }
    }

    /// One host-to-guest vsock stream on `port`, retried while the guest's listener comes up (for up to `within`).
    /// The descriptor is duplicated, so the handle outlives Virtualization's connection object.
    public func connect(port: UInt32, within seconds: TimeInterval = 30) async throws -> FileHandle {
        let deadline = Date().addingTimeInterval(seconds)
        nonisolated(unsafe) let vm = machine
        while true {
            do {
                let connection: VZVirtioSocketConnection = try await withCheckedThrowingContinuation { continuation in
                    queue.async {
                        guard let device = vm.socketDevices.first as? VZVirtioSocketDevice else { return continuation.resume(throwing: HostDaemonError.unsupported("the VM has no vsock device")) }
                        device.connect(toPort: port) { continuation.resume(with: $0.mapError { $0 as Error }) }
                    }
                }
                return FileHandle(fileDescriptor: dup(connection.fileDescriptor), closeOnDealloc: true)
            } catch {
                if let reason = stopReason { throw HostDaemonError.unsupported(reason) }
                if Date() > deadline { throw HostDaemonError.unsupported("nothing in the macOS guest accepted vsock port \(port) within \(spoken(seconds)): \(error.localizedDescription)") }
                try await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    /// The guest's screen over Virtualization's VNC server (the one private API, in `RecoveryVNC`).
    public func attachVNC() throws -> RecoveryVNC { try RecoveryVNC(virtualMachine: machine, queue: queue) }

    private func call(_ body: @escaping @Sendable (VZVirtualMachine, @escaping @Sendable (Result<Void, Error>) -> Void) -> Void) async throws {
        nonisolated(unsafe) let vm = machine
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { body(vm) { continuation.resume(with: $0) } }
        }
    }

    public func guestDidStop(_ virtualMachine: VZVirtualMachine) { lock.withLock { reason = "the guest shut down" } }
    public func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { lock.withLock { reason = "the VM stopped: \(error.localizedDescription)" } }
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
