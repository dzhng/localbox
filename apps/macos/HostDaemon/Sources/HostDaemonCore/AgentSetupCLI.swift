import Foundation

/// The installed `localbox` CLI, which owns agent setup: the global skill and the `localbox` link. HostDaemon runs
/// it for remote and MCP callers (`agents op`) and once at every start (`agents reconcile --reason daemon_start`).
public struct AgentSetupCLI: Sendable {
    public let executable: URL
    public let timeout: TimeInterval

    public init(executable: URL, timeout: TimeInterval = 60) { self.executable = executable; self.timeout = timeout }

    /// One agent setup operation: the CLI's response envelope, parsed.
    public func operation(_ id: String, input: [String: Any]) async -> ProcessOutcome {
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
    public func run(_ arguments: [String]) async -> ProcessOutcome { await runProcess(executable, arguments, timeout: timeout) }
}
