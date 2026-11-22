import Foundation
import XCTest
@testable import HostDaemonCore

/// One daemon per machine root, and the one way down a supervised daemon shares with SIGTERM.
final class DaemonLifetimeTests: XCTestCase {
    private static let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../..").standardizedFileURL

    // MARK: - MachineLock

    func testTheLockRefusesASecondHolderAndNamesTheFirst() throws {
        let path = try scratch().appendingPathComponent("hostd.lock").path
        let held = try MachineLock(path: path)
        XCTAssertThrowsError(try MachineLock(path: path)) { error in
            guard case MachineLockError.held(let refused, let pid) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(refused, path); XCTAssertEqual(pid, getpid(), "the holder recorded its pid")
            XCTAssertTrue("\(error)".contains(path), "the refusal names the lock")
        }
        _ = held
    }

    func testTheLockIsFreeOnceItsHolderGoes() throws {
        let path = try scratch().appendingPathComponent("hostd.lock").path
        var held: MachineLock? = try MachineLock(path: path)
        XCTAssertNotNil(held); held = nil
        XCTAssertNoThrow(try MachineLock(path: path))
    }

    /// The kernel drops a `flock` when its process exits, however it exits: a killed daemon leaves no stale lock.
    func testTheLockIsFreeOnceItsProcessIsKilled() throws {
        let path = try scratch().appendingPathComponent("hostd.lock").path
        let holder = Process(); holder.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
        holder.arguments = ["-e", #"use Fcntl ":flock"; open(F, ">>", $ARGV[0]) or die; flock(F, LOCK_EX) or die; $| = 1; print "held\n"; sleep 60"#, path]
        let output = Pipe(); holder.standardOutput = output
        try holder.run()
        addTeardownBlock { if holder.isRunning { holder.terminate() } }
        XCTAssertEqual(String(decoding: output.fileHandleForReading.readData(ofLength: 5), as: UTF8.self), "held\n")
        XCTAssertThrowsError(try MachineLock(path: path))
        kill(holder.processIdentifier, SIGKILL); holder.waitUntilExit()
        XCTAssertNoThrow(try MachineLock(path: path))
    }

    // MARK: - DaemonShutdown

    /// The end of a supervised daemon's stdin runs the SIGTERM path: the socket closes, every running sandbox is
    /// hibernated or stopped with one line each, and the process exits 0.
    func testEndOfInputRunsTheShutdown() async throws {
        let root = try machineRoot()
        let factory = try ProcessFixtureFactory(configuration: ProcessFixtureConfiguration(guestCommand: ["/usr/bin/env", "node", "--import", "tsx", Self.repoRoot.appendingPathComponent("apps/guest-agent/src/index.ts").path], workingDirectory: Self.repoRoot),
                                                environment: ["LOCALBOX_SANDBOX_BACKEND": "process-fixture"])
        let daemon = try await TestDaemon(root: root, factory: factory), host = daemon.host
        for (id, name) in [("sandbox_1", "one"), ("sandbox_2", "two")] {
            _ = try await result(host, "sandbox.create", #"{"name":"\#(name)","image":"linux","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: id)
        }
        let endpoint = LocalIPCEndpoint(socketPath: root.appendingPathComponent("agent.sock").path)
        let server = UnixDomainSocketServer(ipc: AuthenticatedLocalIPC(daemon: daemon.daemon, token: "t", endpoint: endpoint), endpoint: endpoint)
        try await server.start()
        let lines = Locked<[String]>([]), exited = Locked<Int32?>(nil)
        let shutdown = DaemonShutdown(server: server, host: host, log: { line in lines.withLock { $0.append(line) } }, exit: { status in exited.value = status })
        let stdin = Pipe()
        shutdown.onEndOfInput(stdin.fileHandleForReading.fileDescriptor)
        stdin.fileHandleForWriting.write(Data("ignored\n".utf8))
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertNil(exited.value, "bytes on stdin are not a stop")

        try stdin.fileHandleForWriting.close()
        for _ in 0..<1000 where exited.value == nil { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(exited.value, 0)
        let isRunning = await server.isRunning()
        XCTAssertFalse(isRunning, "the socket stopped before the saves")
        XCTAssertEqual(lines.value.first, "stopping (stdin closed): hibernating running sandboxes")
        XCTAssertEqual(Set(lines.value.dropFirst()), ["stopped one: the process fixture cannot save its state", "stopped two: the process fixture cannot save its state"], "one line per sandbox")
        for id in ["sandbox_1", "sandbox_2"] {
            XCTAssertEqual(try SandboxDirectory(root.appendingPathComponent("sandboxes/\(id)")).load().coldBootPending, "fixture: the process fixture cannot save its state")
        }

        shutdown.run(because: "SIGTERM")
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(lines.value.count, 3, "a second request does not shut down again")
    }

    // MARK: - The localbox-hostd process

    /// A twin on the same root exits 75 naming the lock, and leaves the first daemon's socket alone.
    func testASecondDaemonOnTheRootIsRefused() async throws {
        let machine = try machineRoot()
        let first = try startDaemon(machine)
        try await untilSocket(machine)
        let twin = try startDaemon(machine)
        try await exited(twin.process)
        XCTAssertEqual(twin.process.terminationStatus, 75)
        XCTAssertTrue(twin.stderr().contains("holds \(machine.appendingPathComponent("hostd.lock").path)"), twin.stderr())
        XCTAssertTrue(FileManager.default.fileExists(atPath: machine.appendingPathComponent("agent.sock").path), "the twin did not unlink the socket")
        XCTAssertTrue(first.process.isRunning)
        first.process.terminate(); try await exited(first.process)
        XCTAssertEqual(first.process.terminationStatus, 0)
    }

    func testLocalboxHostdLockOverridesTheSocketsDirectory() async throws {
        let machine = try machineRoot(), lock = try scratch().appendingPathComponent("elsewhere.lock").path
        let daemon = try startDaemon(machine, environment: ["LOCALBOX_HOSTD_LOCK": lock])
        try await untilSocket(machine)
        XCTAssertThrowsError(try MachineLock(path: lock))
        XCTAssertFalse(FileManager.default.fileExists(atPath: machine.appendingPathComponent("hostd.lock").path))
        daemon.process.terminate(); try await exited(daemon.process)
    }

    func testASupervisedDaemonStopsWhenItsStdinCloses() async throws {
        let machine = try machineRoot(), stdin = Pipe()
        let daemon = try startDaemon(machine, arguments: ["--supervised"], stdin: stdin)
        try await untilSocket(machine)
        try stdin.fileHandleForWriting.close()
        try await exited(daemon.process)
        XCTAssertEqual(daemon.process.terminationStatus, 0)
        XCTAssertTrue(daemon.stderr().contains("stopping (stdin closed)"), daemon.stderr())
        XCTAssertFalse(FileManager.default.fileExists(atPath: machine.appendingPathComponent("agent.sock").path), "the socket is removed")
    }

    /// Without `--supervised` stdin means nothing (launchd and the probes give it /dev/null).
    func testAnUnsupervisedDaemonIgnoresItsStdin() async throws {
        let machine = try machineRoot(), stdin = Pipe()
        let daemon = try startDaemon(machine, stdin: stdin)
        try await untilSocket(machine)
        try stdin.fileHandleForWriting.close()
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertTrue(daemon.process.isRunning, daemon.stderr())
        daemon.process.terminate(); try await exited(daemon.process)
        XCTAssertEqual(daemon.process.terminationStatus, 0)
    }

    func testAnUnknownArgumentIsRefused() throws {
        let daemon = try startDaemon(try machineRoot(), arguments: ["--supervise"])
        daemon.process.waitUntilExit()
        XCTAssertEqual(daemon.process.terminationStatus, 64)
    }

    private struct Daemon {
        let process: Process
        let errors: Pipe
        let log: Locked<Data>
        func stderr() -> String { String(decoding: log.value, as: UTF8.self) }
    }

    /// `localbox-hostd` from this build, on a scratch machine root with the process fixture, so no VM is involved.
    private func startDaemon(_ machine: URL, arguments: [String] = [], stdin: Pipe? = nil, environment: [String: String] = [:]) throws -> Daemon {
        let executable = Bundle(for: Self.self).bundleURL.deletingLastPathComponent().appendingPathComponent("localbox-hostd")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { throw HostDaemonError.unsupported("no localbox-hostd beside the test bundle at \(executable.path)") }
        let token = machine.appendingPathComponent("ipc-token")
        if !FileManager.default.fileExists(atPath: token.path) { try Data("token".utf8).write(to: token) }
        let process = Process(); process.executableURL = executable; process.arguments = arguments
        process.environment = ["HOME": machine.path, "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin", "LOCALBOX_DEV": "1", "LOCALBOX_SANDBOX_BACKEND": "process-fixture", "LOCALBOX_REPO_ROOT": Self.repoRoot.path,
                               "LOCALBOX_SANDBOXES": machine.appendingPathComponent("sandboxes").path, "LOCALBOX_OPERATIONS": machine.appendingPathComponent("operations").path, "LOCALBOX_IMAGES": machine.appendingPathComponent("images").path,
                               "LOCALBOX_SOCKET": machine.appendingPathComponent("agent.sock").path, "LOCALBOX_IPC_TOKEN_PATH": token.path].merging(environment) { $1 }
        process.standardInput = stdin ?? FileHandle.nullDevice
        let errors = Pipe(), log = Locked(Data())
        process.standardError = errors
        // At EOF the handler would be called again and again with no data: it stops itself there.
        errors.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil } else { log.withLock { $0.append(chunk) } }
        }
        try process.run()
        addTeardownBlock { if process.isRunning { kill(process.processIdentifier, SIGKILL); process.waitUntilExit() } }
        return Daemon(process: process, errors: errors, log: log)
    }

    /// Waits for `process` to end by polling, not `waitUntilExit()`, which can miss the exit when called on a
    /// concurrency thread and then never returns.
    private func exited(_ process: Process) async throws {
        try await until { !process.isRunning }
    }

    private func untilSocket(_ machine: URL) async throws {
        try await until { FileManager.default.fileExists(atPath: machine.appendingPathComponent("agent.sock").path) }
    }

    /// A scratch machine root under /tmp: the test runner's temporary directory is too deep for a Unix socket path.
    private func machineRoot() throws -> URL {
        let directory = URL(fileURLWithPath: "/tmp/lb-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }
}
