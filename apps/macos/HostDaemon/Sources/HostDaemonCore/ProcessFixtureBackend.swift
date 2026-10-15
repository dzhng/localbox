import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Where a fixture sandbox lives and how to run its guest agent.
public struct ProcessFixtureConfiguration: Sendable {
    /// `<sandbox dir>`; the guest's filesystem root is `<sandbox dir>/root`.
    public let sandboxDirectory: URL
    /// argv for the guest agent; it must speak the guest frame protocol on stdin/stdout.
    public let guestCommand: [String]
    public let workingDirectory: URL?
    public let vmID: String
    /// Host capacity the placement code sees on a fixture machine (`LOCALBOX_DEV_HOST_*`).
    public let hostMemoryBytes: UInt64?
    public let hostCPUs: Int?
    public init(sandboxDirectory: URL, guestCommand: [String], workingDirectory: URL? = nil, vmID: String = "vm_01", hostMemoryBytes: UInt64? = nil, hostCPUs: Int? = nil) {
        self.sandboxDirectory = sandboxDirectory; self.guestCommand = guestCommand; self.workingDirectory = workingDirectory; self.vmID = vmID; self.hostMemoryBytes = hostMemoryBytes; self.hostCPUs = hostCPUs
    }
    public var guestRoot: URL { sandboxDirectory.appendingPathComponent("root", isDirectory: true) }

    /// The fixture is never a silent fallback: it needs `LOCALBOX_VM_BACKEND=process-fixture`, and release builds refuse it.
    public static func requireOptIn(environment: [String: String]) throws {
        guard environment["LOCALBOX_VM_BACKEND"] == "process-fixture" else {
            throw HostDaemonError.unsupported("the process fixture backend needs LOCALBOX_VM_BACKEND=process-fixture")
        }
        #if !DEBUG
        throw HostDaemonError.unsupported("release builds refuse the process fixture backend")
        #endif
    }
}

/// A sandbox that is a local guest-agent process instead of a VM, so two machines fit on one Mac without
/// booting VMs. stdin/stdout carry exactly the frames the virtio socket carries; sleep is SIGSTOP/SIGCONT.
public actor ProcessFixtureBackend: VMBackend, GuestChannelProvider {
    public let configuration: ProcessFixtureConfiguration
    private var process: Process?
    private var channel: FramedFileHandleGuestChannel?

    public init(configuration: ProcessFixtureConfiguration, environment: [String: String] = ProcessInfo.processInfo.environment) throws {
        try ProcessFixtureConfiguration.requireOptIn(environment: environment)
        self.configuration = configuration
    }

    public var pid: Int32? { process?.processIdentifier }

    public func start() async throws {
        guard process == nil else { return }
        guard let executable = configuration.guestCommand.first else { throw HostDaemonError.invalidState("fixture guest command is empty") }
        try FileManager.default.createDirectory(at: configuration.guestRoot, withIntermediateDirectories: true)
        let child = Process()
        child.executableURL = URL(fileURLWithPath: executable)
        child.arguments = Array(configuration.guestCommand.dropFirst())
        if let directory = configuration.workingDirectory { child.currentDirectoryURL = directory }
        var environment = ProcessInfo.processInfo.environment
        environment["LOCALBOX_ROOT"] = configuration.guestRoot.path
        environment["LOCALBOX_VM_ID"] = configuration.vmID
        environment["LOCALBOX_READINESS_MARKER"] = configuration.sandboxDirectory.appendingPathComponent("ready").path
        child.environment = environment
        let toGuest = Pipe(); let fromGuest = Pipe()
        child.standardInput = toGuest; child.standardOutput = fromGuest
        child.standardError = try logHandle()
        try child.run()
        process = child
        channel = FramedFileHandleGuestChannel(reader: fromGuest.fileHandleForReading, writer: toGuest.fileHandleForWriting)
    }

    public func makeGuestChannel() async throws -> any GuestChannel {
        guard let channel else { throw HostDaemonError.guestUnavailable }
        return channel
    }

    public func stop() async throws {
        await channel?.close(); channel = nil
        guard let child = process else { return }
        process = nil
        if child.isRunning {
            kill(child.processIdentifier, SIGCONT)
            child.terminate()
            for _ in 0..<50 where child.isRunning { try await Task.sleep(nanoseconds: 20_000_000) }
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        }
    }

    public func pause() async throws { try signal(SIGSTOP) }
    public func resume() async throws { try signal(SIGCONT) }

    /// Discards the guest root; the next start begins from an empty sandbox.
    public func reset() async throws {
        try await stop()
        try? FileManager.default.removeItem(at: configuration.guestRoot)
    }

    private func signal(_ value: Int32) throws {
        guard let child = process, child.isRunning else { throw HostDaemonError.invalidState("fixture guest is not running") }
        guard kill(child.processIdentifier, value) == 0 else { throw HostDaemonError.invalidState("could not signal the fixture guest (errno \(errno))") }
    }

    private func logHandle() throws -> FileHandle {
        let log = configuration.sandboxDirectory.appendingPathComponent("guest.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        let handle = try FileHandle(forWritingTo: log); handle.seekToEndOfFile(); return handle
    }
}
