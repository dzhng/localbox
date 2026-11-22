#if os(macOS)
import Foundation
import Virtualization

/// One Virtualization VM for one boot: every VM the package runs (a sandbox's, a macOS image build's, a lab's) is one.
/// It is made from a `VMSpec` through `SandboxConfigurationBuilder`, driven on its own queue (Virtualization asserts a VM
/// is made and driven on one), notices the guest stopping on its own, and is reached over vsock.
public final class VirtualMachine: NSObject, VZVirtualMachineDelegate, @unchecked Sendable {
    /// What a macOS build and the lab give a macOS guest: 4 CPUs and 8 GiB, the most Apple's install requirements ask for.
    public static let macCPUs = 4
    public static let macMemoryBytes: UInt64 = 8 << 30

    private let queue: DispatchQueue
    private let machine: VZVirtualMachine
    private let stopped = Locked<(reason: String?, handler: (@Sendable (String) -> Void)?)>((nil, nil))

    public init(spec: VMSpec) throws {
        nonisolated(unsafe) let configuration = try SandboxConfigurationBuilder.build(spec)
        let queue = DispatchQueue(label: "sh.localbox.vm")
        self.queue = queue
        machine = queue.sync { VZVirtualMachine(configuration: configuration, queue: queue) }
        super.init()
        queue.sync { machine.delegate = self }
    }

    /// Why the guest stopped on its own (a shutdown inside it, an error), once it has.
    public var stopReason: String? { stopped.value.reason }

    /// `handler` hears why, once the guest stops on its own.
    public func onStop(_ handler: @escaping @Sendable (String) -> Void) { stopped.withLock { $0.handler = handler } }

    public var isRunning: Bool { queue.sync { machine.state == .running } }

    /// How a boot starts: a plain boot, the first boot of a fresh macOS install with a user made for it (no Setup
    /// Assistant), or macOS Recovery.
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

    /// Stops the VM at once (a pulled plug); one already stopped is left alone.
    public func stop() async throws {
        guard queue.sync(execute: { machine.canStop }) else { return }
        try await call { vm, done in vm.stop { done($0.map { .failure($0) } ?? .success(())) } }
    }

    public func pause() async throws { try await call { vm, done in vm.pause { done($0) } } }
    public func resume() async throws { try await call { vm, done in vm.resume { done($0) } } }

    /// Writes the paused VM's state to `url`.
    public func saveState(to url: URL) async throws {
        try await call { vm, done in vm.saveMachineStateTo(url: url) { done($0.map { .failure($0) } ?? .success(())) } }
    }

    /// Loads a saved state into this new VM, which is left paused.
    public func restoreState(from url: URL) async throws {
        try await call { vm, done in vm.restoreMachineStateFrom(url: url) { done($0.map { .failure($0) } ?? .success(())) } }
    }

    /// Installs `ipsw` onto this macOS VM's disk (made from the restore image's requirements); `progress` gets 0…1.
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

    /// Waits for the guest to power itself off (a shutdown or halt inside it).
    public func waitUntilStopped(timeout: TimeInterval) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if queue.sync(execute: { machine.state == .stopped || machine.state == .error }) { return }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        throw HostDaemonError.unsupported("the guest did not power off within \(spoken(timeout))")
    }

    /// One host-to-guest vsock stream on `port`, retried while the guest's forwarder comes up, until the VM stops or
    /// `seconds` pass. Reader and writer are separate duplicates of the descriptor, so a lane can close its writer while
    /// a read is blocked on the reader, and both outlive Virtualization's connection object.
    public func connect(port: UInt32, within seconds: TimeInterval) async throws -> (reader: FileHandle, writer: FileHandle) {
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
                return (FileHandle(fileDescriptor: dup(connection.fileDescriptor), closeOnDealloc: true), FileHandle(fileDescriptor: dup(connection.fileDescriptor), closeOnDealloc: true))
            } catch {
                if let reason = stopReason { throw HostDaemonError.unsupported(reason) }
                if Date() > deadline { throw HostDaemonError.unsupported("nothing in the guest accepted vsock port \(port) within \(spoken(seconds)): \(error.localizedDescription)") }
                try await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    /// The request lane, handed out once the agent announced readiness and took its hello (as sandbox `sandboxID`,
    /// named `name`). The forwarder accepts before the agent listens, and a restored guest closes its first connection,
    /// so a lane that closes before ready is dialled again until `deadline`.
    public func openRequestLane(sandboxID: String, name: String, until deadline: Date) async throws -> FramedFileHandleGuestChannel {
        try await GuestLane.open(until: deadline) {
            let stream = try await self.connect(port: GuestPort.request, within: max(deadline.timeIntervalSinceNow, 1))
            let channel = FramedFileHandleGuestChannel(reader: stream.reader, writer: stream.writer, sandboxID: sandboxID, name: name)
            do { try await channel.waitUntilReady() } catch { await channel.close(); throw error }
            return channel
        }
    }

    /// A new connection to the control lane; its forwarder listens once the guest is up, so a ready guest answers at once.
    public func dialControl() async throws -> FramedControlChannel {
        let stream = try await connect(port: GuestPort.control, within: 10)
        return FramedControlChannel(reader: stream.reader, writer: stream.writer)
    }

    /// The guest's screen over Virtualization's VNC server (the one private API, in `RecoveryVNC`).
    public func attachVNC() throws -> RecoveryVNC { try RecoveryVNC(virtualMachine: machine, queue: queue) }

    private func call(_ body: @escaping @Sendable (VZVirtualMachine, @escaping @Sendable (Result<Void, Error>) -> Void) -> Void) async throws {
        nonisolated(unsafe) let vm = machine
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { body(vm) { continuation.resume(with: $0) } }
        }
    }

    public func guestDidStop(_ virtualMachine: VZVirtualMachine) { stoppedOnItsOwn("the guest shut down") }
    public func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { stoppedOnItsOwn("the VM stopped: \(error.localizedDescription)") }
    private func stoppedOnItsOwn(_ why: String) {
        let handler = stopped.withLock { state -> (@Sendable (String) -> Void)? in state.reason = why; return state.handler }
        handler?(why)
    }
}
#endif
