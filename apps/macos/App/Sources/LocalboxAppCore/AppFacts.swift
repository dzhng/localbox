import Foundation

/// What `localbox app status --json` prints (`apps/cli/src/app-facts.ts`): everything the popover and Settings show,
/// warnings included (the CLI decides them; views only render them). The shared
/// fixtures under `apps/macos/App/tests/fixtures/facts/` are written by the CLI's tests and decoded by this type's, so
/// the two sides cannot drift. Keys are the CLI's snake_case; `update` is null in a build that cannot update itself.
public struct AppFacts: Codable, Equatable, Sendable {
    public enum Build: String, Codable, Sendable { case release, dev }
    public enum Daemon: String, Codable, Sendable { case running, starting, stopped, backingOff = "backing_off" }
    public enum Hibernate: String, Codable, Sendable { case available, onlyWhileUnlocked = "only_while_unlocked", unknown }
    public enum OpenAtLogin: String, Codable, Sendable { case enabled, disabled, requiresApproval = "requires_approval", notFound = "not_found" }
    public enum BuiltinImage: String, Codable, Sendable { case ready, downloading, failed, missing }

    public struct Account: Codable, Equatable, Sendable { public let email: String?; public let machineName: String }
    public struct Connector: Codable, Equatable, Sendable {
        public enum State: String, Codable, Sendable { case connected, connecting, signedOut = "signed_out", down }
        public let state: State
        public let detail: String?
    }
    public struct Capacity: Codable, Equatable, Sendable {
        public let cpusFree: Int, cpusTotal: Int
        public let memoryFreeBytes: UInt64, memoryTotalBytes: UInt64
        public let diskFreeBytes: UInt64?
    }
    public struct AgentSetup: Codable, Equatable, Sendable {
        public let enabled: Bool
        /// `cli.status` and `skill.status` states, shown as they are.
        public let command: String, skill: String
    }
    public struct Progress: Codable, Equatable, Sendable { public let doneBytes: UInt64, totalBytes: UInt64 }
    public struct Sandbox: Codable, Equatable, Sendable {
        public enum State: String, Codable, Sendable { case running, asleep, paused, stopped, starting, copying, failed }
        public let sandboxId: String, name: String, os: String
        public let state: State
        public let progress: Progress?
        public let error: String?
    }
    public struct Image: Codable, Equatable, Sendable {
        public enum State: String, Codable, Sendable { case building, copying, downloading, failed }
        public let name: String
        public let state: State
        public let phase: String?
        public let progress: Progress?
        public let error: String?
    }
    public struct Stopping: Codable, Equatable, Sendable { public let reason: String; public let pending: [String] }
    /// The update controls (null in a build without Sparkle, where Settings shows the manual-updates
    /// line). `available` is whether this build updates itself at all.
    public struct Update: Codable, Equatable, Sendable {
        public let available: Bool
        public let enabled: Bool
        public let canCheck: Bool
        /// A line about the last or current check or install, shown under the button.
        public let status: String?
        public let version: String?
    }
    public struct Warning: Codable, Equatable, Sendable {
        /// One of the CLI's warning codes; a view shows `message` and `fix`, never its own text for a code.
        public let code: String
        public let message: String
        public let fix: String?
    }

    public let version: String
    public let build: Build
    public let account: Account?
    public let daemon: Daemon
    public let connector: Connector
    public let capacity: Capacity?
    public let hibernate: Hibernate
    public let openAtLogin: OpenAtLogin
    public let agentSetup: AgentSetup
    public let sandboxes: [Sandbox]
    public let images: [Image]
    public let builtinImage: BuiltinImage
    public let stopping: Stopping?
    public let update: Update?
    public let warnings: [Warning]
    /// A fingerprint of the facts; passed back as `--since` to wait for the next change.
    public let watchVersion: Int

    /// The sandboxes the daemon hibernates on the way out (it saves running and paused ones), for `Lifetime.stop`.
    public var hibernating: [String] { sandboxes.filter { $0.state == .running || $0.state == .paused }.map(\.name) }

    public static func decode(_ data: Data) throws -> AppFacts {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(AppFacts.self, from: data)
    }

    public func encoded() throws -> Data {
        let encoder = JSONEncoder(); encoder.keyEncodingStrategy = .convertToSnakeCase; encoder.outputFormatting = .sortedKeys
        return try encoder.encode(self)
    }
}
