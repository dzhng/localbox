import Foundation

/// The installed `localbox` CLI, which owns agent setup (D16): the global skill and the `localbox` link. HostDaemon runs
/// it for remote and MCP callers (`agents op`) and once at every start (`agents reconcile --reason daemon_start`).
public struct AgentSetupCLI: Sendable {
    public let executable: URL
    public let timeout: TimeInterval

    public init(executable: URL, timeout: TimeInterval = 60) { self.executable = executable; self.timeout = timeout }

    public struct Outcome: Sendable {
        public let status: Int32
        public let stdout: Data
        public let stderr: String
        public let timedOut: Bool
    }

    /// One agent setup operation: the CLI's response envelope, parsed.
    public func operation(_ id: String, input: [String: Any]) async -> Outcome {
        let json = (try? JSONSerialization.data(withJSONObject: input)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return await run(["agents", "op", id, "--input-json", json, "--json"])
    }

    /// The daemon-start reconcile; returns one line for the log.
    public func reconcile() async -> String {
        let outcome = await run(["agents", "reconcile", "--reason", "daemon_start", "--json"])
        if outcome.timedOut { return "timed out after \(Int(timeout)) s" }
        if let value = try? JSONSerialization.jsonObject(with: outcome.stdout), let compact = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            return String(decoding: compact, as: UTF8.self)
        }
        return "exit \(outcome.status): \(outcome.stderr.trimmingCharacters(in: .whitespacesAndNewlines))"
    }

    /// Runs the CLI with `arguments`, killing it after `timeout`.
    public func run(_ arguments: [String]) async -> Outcome {
        await withCheckedContinuation { continuation in
            let process = Process(), out = Pipe(), err = Pipe()
            process.executableURL = executable; process.arguments = arguments
            process.standardOutput = out; process.standardError = err; process.standardInput = FileHandle.nullDevice
            let timedOut = TimeoutFlag(), once = Once()
            let finish: @Sendable (Outcome) -> Void = { outcome in if once.first() { continuation.resume(returning: outcome) } }
            // Read both pipes while the CLI runs, so a large reply never blocks it on a full pipe.
            let reading = DispatchGroup(), stdout = Collected(), stderr = Collected()
            for (pipe, sink) in [(out, stdout), (err, stderr)] {
                reading.enter()
                DispatchQueue.global().async { sink.data = pipe.fileHandleForReading.readDataToEndOfFile(); reading.leave() }
            }
            process.terminationHandler = { finished in
                reading.notify(queue: .global()) {
                    finish(Outcome(status: finished.terminationStatus, stdout: stdout.data, stderr: String(decoding: stderr.data, as: UTF8.self), timedOut: timedOut.value))
                }
            }
            do { try process.run() } catch {
                try? out.fileHandleForWriting.close(); try? err.fileHandleForWriting.close()
                finish(Outcome(status: -1, stdout: Data(), stderr: "could not run \(executable.path): \(error)", timedOut: false)); return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                guard process.isRunning else { return }
                timedOut.value = true; process.terminate()
                // A grandchild can keep the pipes open after the CLI exits; answer anyway.
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) { finish(Outcome(status: -1, stdout: Data(), stderr: "", timedOut: true)) }
            }
        }
    }
}

private final class Collected: @unchecked Sendable { var data = Data() }
private final class TimeoutFlag: @unchecked Sendable { var value = false }
private final class Once: @unchecked Sendable {
    private let lock = NSLock(); private var done = false
    func first() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}
