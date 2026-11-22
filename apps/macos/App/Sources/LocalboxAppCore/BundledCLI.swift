import Darwin
import Foundation

/// A refusal from the bundled CLI: the `code` and `message` of its failure envelope, or of its stderr when it
/// printed none.
public struct CLIFailure: Error, Equatable, CustomStringConvertible, Sendable {
    public let code: String
    public let message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
    public var description: String { "\(code): \(message)" }
}

/// Runs the CLI inside this bundle, `Contents/Resources/cli/localbox`, the app's only way to read or change Localbox
/// state (specs/menu-bar-app, invariant 5).
public final class BundledCLI: Sendable {
    public let executable: URL
    private let environment: [String: String]
    private let deadline: TimeInterval

    public init(bundle: URL, environment: [String: String] = ProcessInfo.processInfo.environment, deadline: TimeInterval = 120) {
        self.executable = bundle.appendingPathComponent("Contents/Resources/cli/localbox")
        self.environment = environment; self.deadline = deadline
    }

    /// `localbox <arguments> --json`: its stdout when it exits 0, else the failure it reports. Cancelling the task
    /// sends the command SIGTERM and throws `CancellationError`, so a long poll nobody waits for ends at once.
    public func run(_ arguments: [String]) async throws -> Data {
        let running = RunningCommand()
        return try await withTaskCancellationHandler {
            try await Task.detached { [self] in try execute(arguments, running) }.value
        } onCancel: { running.cancel() }
    }

    /// The connector as the app's child: `localbox connector run`, with the app's environment; it stops when its stdin closes.
    public func connector(log: URL) -> ChildLaunch {
        ChildLaunch(executable: executable, arguments: ["connector", "run"], environment: environment, log: log)
    }

    /// The built-in image's one-shot: `localbox app image ensure --json`, whose progress lines go to `log`.
    public func imageEnsure(log: URL) -> ChildLaunch {
        ChildLaunch(executable: executable, arguments: ["app", "image", "ensure", "--json"], environment: environment, log: log)
    }

    private func execute(_ arguments: [String], _ running: RunningCommand) throws -> Data {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments + ["--json"]
        process.environment = environment
        process.currentDirectoryURL = URL(fileURLWithPath: "/")
        process.standardInput = FileHandle.nullDevice
        // A file drains stderr on its own, so a long error never stalls the stdout read below.
        let errorURL = FileManager.default.temporaryDirectory.appendingPathComponent("localbox-cli-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: errorURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CLIFailure(code: "internal", message: "cannot create \(errorURL.path)")
        }
        defer { try? FileManager.default.removeItem(at: errorURL) }
        let errors = try FileHandle(forWritingTo: errorURL)
        defer { try? errors.close() }
        process.standardError = errors
        let output = Pipe()
        process.standardOutput = output
        if running.isCancelled { throw CancellationError() }
        do { try process.run() } catch { throw CLIFailure(code: "cli_unavailable", message: "cannot run \(executable.path): \(error.localizedDescription)") }
        running.started(process.processIdentifier)
        let expiry = DispatchWorkItem { if process.isRunning { kill(process.processIdentifier, SIGTERM) } }
        DispatchQueue.global().asyncAfter(deadline: .now() + deadline, execute: expiry)
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        running.finished()
        expiry.cancel()
        if running.isCancelled { throw CancellationError() }
        if process.terminationReason == .exit && process.terminationStatus == 0 { return data }
        throw Self.failure(stdout: data, stderr: (try? Data(contentsOf: errorURL)) ?? Data(), status: process.terminationStatus, signalled: process.terminationReason == .uncaughtSignal)
    }

    /// The CLI's failure envelope (`{"ok":false,"error":{code,message}}`) on stdout, else the last JSON error line on
    /// stderr, else stderr as text.
    static func failure(stdout: Data, stderr: Data, status: Int32, signalled: Bool) -> CLIFailure {
        for bytes in [stdout, stderr] {
            if let failure = envelope(bytes) { return failure }
            for line in bytes.split(separator: 10).reversed() { if let failure = envelope(Data(line)) { return failure } }
        }
        let text = String(decoding: stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return CLIFailure(code: "cli_failed", message: text.isEmpty ? "the localbox command \(signalled ? "was killed by signal" : "exited") \(status)" : text)
    }

    private static func envelope(_ bytes: Data) -> CLIFailure? {
        guard let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let error = object["error"] as? [String: Any], let message = error["message"] as? String else { return nil }
        return CLIFailure(code: error["code"] as? String ?? "cli_failed", message: message)
    }
}

/// The pid of a command `BundledCLI.run` started, so cancelling its task can stop it from another thread.
private final class RunningCommand: @unchecked Sendable {
    private let lock = NSLock()
    private var pid: pid_t = 0
    private var cancelled = false

    var isCancelled: Bool { lock.withLock { cancelled } }

    /// A cancel that came before the start stops the command as soon as it exists.
    func started(_ pid: pid_t) {
        let stop: Bool = lock.withLock { self.pid = pid; return cancelled }
        if stop { kill(pid, SIGTERM) }
    }

    /// Once it has exited its pid may be reused, so a late cancel signals nothing.
    func finished() { lock.withLock { pid = -1 } }

    func cancel() {
        let pid: pid_t = lock.withLock { cancelled = true; return self.pid }
        if pid > 0 { kill(pid, SIGTERM) }
    }
}
