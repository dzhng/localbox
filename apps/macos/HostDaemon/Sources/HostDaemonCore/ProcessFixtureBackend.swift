import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// How to run a fixture sandbox's guest agent.
public struct ProcessFixtureConfiguration: Sendable {
    /// argv for the guest agent; it must speak the guest frame protocol on stdin/stdout.
    public let guestCommand: [String]
    public let workingDirectory: URL?
    public init(guestCommand: [String], workingDirectory: URL? = nil) {
        self.guestCommand = guestCommand; self.workingDirectory = workingDirectory
    }

    /// The fixture is never a silent fallback: it needs `LOCALBOX_SANDBOX_BACKEND=process-fixture`, and release builds refuse it.
    public static func requireOptIn(environment: [String: String]) throws {
        guard environment["LOCALBOX_SANDBOX_BACKEND"] == "process-fixture" else {
            throw HostDaemonError.unsupported("the process fixture backend needs LOCALBOX_SANDBOX_BACKEND=process-fixture")
        }
        #if !DEBUG
        throw HostDaemonError.unsupported("release builds refuse the process fixture backend")
        #endif
    }
}

/// Fixture sandboxes: each gets its own guest process and filesystem root `<sandbox dir>/root`.
public struct ProcessFixtureFactory: SandboxBackendFactory {
    public let configuration: ProcessFixtureConfiguration
    public init(configuration: ProcessFixtureConfiguration, environment: [String: String] = ProcessInfo.processInfo.environment) throws {
        try ProcessFixtureConfiguration.requireOptIn(environment: environment)
        self.configuration = configuration
    }
    public func provision(_ record: inout SandboxRecord, in directory: SandboxDirectory) throws -> [String: String] {
        try FileManager.default.createDirectory(at: directory.guestRoot, withIntermediateDirectories: true)
        record.mac = randomLocalMAC()
        return [:]
    }
    public func backend(for record: SandboxRecord, in directory: SandboxDirectory) throws -> any SandboxBackend {
        ProcessFixtureBackend(configuration: configuration, record: record, directory: directory)
    }
}

/// A sandbox that is a local guest-agent process instead of a VM, so many machines fit on one Mac without
/// booting VMs. stdin/stdout carry exactly the frames the virtio socket carries; sleep is SIGSTOP/SIGCONT.
public actor ProcessFixtureBackend: SandboxBackend, GuestChannelProvider {
    public let configuration: ProcessFixtureConfiguration
    private let record: SandboxRecord
    private let directory: SandboxDirectory
    private var process: Process?
    private var channel: FramedFileHandleGuestChannel?

    init(configuration: ProcessFixtureConfiguration, record: SandboxRecord, directory: SandboxDirectory) {
        self.configuration = configuration; self.record = record; self.directory = directory
    }

    public var pid: Int32? { process?.processIdentifier }

    public func start() async throws {
        guard process == nil else { return }
        guard let executable = configuration.guestCommand.first else { throw HostDaemonError.invalidState("fixture guest command is empty") }
        try FileManager.default.createDirectory(at: directory.guestRoot, withIntermediateDirectories: true)
        let child = Process()
        child.executableURL = URL(fileURLWithPath: executable)
        child.arguments = Array(configuration.guestCommand.dropFirst())
        if let working = configuration.workingDirectory { child.currentDirectoryURL = working }
        var environment = ProcessInfo.processInfo.environment
        environment["LOCALBOX_ROOT"] = directory.guestRoot.path
        environment["LOCALBOX_READINESS_MARKER"] = directory.url.appendingPathComponent("ready").path
        child.environment = environment
        let toGuest = Pipe(); let fromGuest = Pipe()
        child.standardInput = toGuest; child.standardOutput = fromGuest
        child.standardError = try logHandle()
        try child.run()
        process = child
        channel = FramedFileHandleGuestChannel(reader: fromGuest.fileHandleForReading, writer: toGuest.fileHandleForWriting, sandboxID: record.sandboxID, name: record.name)
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

    private func signal(_ value: Int32) throws {
        guard let child = process, child.isRunning else { throw HostDaemonError.invalidState("fixture guest is not running") }
        guard kill(child.processIdentifier, value) == 0 else { throw HostDaemonError.invalidState("could not signal the fixture guest (errno \(errno))") }
    }

    private func logHandle() throws -> FileHandle {
        let log = directory.url.appendingPathComponent("guest.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        let handle = try FileHandle(forWritingTo: log); handle.seekToEndOfFile(); return handle
    }
}
