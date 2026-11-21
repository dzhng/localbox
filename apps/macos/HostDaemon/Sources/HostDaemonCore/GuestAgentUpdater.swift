import Foundation

/// What a guest agent announced in its ready frame: the build it runs and the OS it runs on.
public struct GuestAgentIdentity: Equatable, Sendable {
    public let version: String
    public let os: String
    public init(version: String, os: String) { self.version = version; self.os = os }
}

/// Request lanes that know which agent answered them.
public protocol GuestAgentReporting: Sendable {
    func agentIdentity() async -> GuestAgentIdentity?
}

/// Backends that can dial the request lane again on the same running guest, after its agent restarted. `name` is the
/// sandbox's name now, for the new connection's hello.
public protocol GuestReconnecting: Sendable {
    func reconnectGuest(name: String) async throws -> any GuestChannel
}

/// One agent binary to push: the build's version, the digest the guest verifies, and the file.
public struct AgentBinary: Equatable, Sendable {
    public let version: String
    public let sha256: String
    public let url: URL
    public let size: Int
    /// Raw bytes per `agent.chunk`; base64 grows them by a third, which must stay under the 8 MiB frame limit.
    public let chunkBytes: Int

    public init(version: String, sha256: String, url: URL, size: Int, chunkBytes: Int) {
        self.version = version; self.sha256 = sha256; self.url = url; self.size = size; self.chunkBytes = chunkBytes
    }
}

public enum AgentUpdateOutcome: Equatable, Sendable {
    /// Verified and swapped in; the old agent is exiting.
    case updated
    /// The guest started a job since the host looked; it keeps its agent until the jobs end (P5).
    case deferred(runningJobs: Int)
}

/// The host is the authority on the guest agent: `agent-version.json` and one binary per guest OS, as
/// `npm run build:guest-agent` writes them (`Contents/Resources/guest-agent/` in a release). A guest whose ready frame
/// names another version gets this host's build over its control lane; `SandboxRuntime.updateAgentIfDue` decides when.
public actor GuestAgentUpdater {
    public let directory: URL
    let chunkBytes: Int
    /// How long the restarted agent has to answer on the request lane: the forwarder's own retry (socat, 60 s).
    let restartWindow: TimeInterval
    private var cached: (modified: Date, release: Release)?

    struct Release: Decodable, Equatable { let version: String; let sha256: [String: String] }

    public init(directory: URL, chunkBytes: Int = 4 * 1024 * 1024, restartWindow: TimeInterval = 60) {
        self.directory = directory; self.chunkBytes = chunkBytes; self.restartWindow = restartWindow
    }

    /// The binary `agent` should run, or nil when it already runs this host's build (or the host has none for its OS).
    /// `agent-version.json` is read again whenever it changes, so a guest is held to the build on disk now.
    func due(for agent: GuestAgentIdentity) -> AgentBinary? {
        guard let release = release(), release.version != agent.version, let sha256 = release.sha256[agent.os] else { return nil }
        let url = directory.appendingPathComponent("localbox-agent-\(agent.os)-arm64")
        guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue else { return nil }
        return AgentBinary(version: release.version, sha256: sha256, url: url, size: size, chunkBytes: chunkBytes)
    }

    /// The version this host ships, or nil when `agent-version.json` is missing or unreadable.
    public func version() -> String? { release()?.version }

    private func release() -> Release? {
        let file = directory.appendingPathComponent("agent-version.json")
        guard let modified = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date else { cached = nil; return nil }
        if let cached, cached.modified == modified { return cached.release }
        guard let data = try? Data(contentsOf: file), let release = try? JSONDecoder().decode(Release.self, from: data) else { cached = nil; return nil }
        cached = (modified, release)
        return release
    }
}
