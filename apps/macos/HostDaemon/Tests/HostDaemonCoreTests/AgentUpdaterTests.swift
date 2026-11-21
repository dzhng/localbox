import XCTest
@testable import HostDaemonCore

/// `SandboxRuntime.updateAgentIfDue` and `GuestAgentUpdater` on a fake backend: a guest on another agent build gets the
/// host's over the control lane, the request lane is dialled again, and the VM never restarts.
final class AgentUpdaterTests: XCTestCase {

    func testAGuestOnAnotherBuildIsUpdatedWithoutRestarting() async throws {
        let log = EventLog(), agent = FakeAgent(version: "0.1.0+aaaaaaaaaaaa")
        let factory = FakeBackendFactory(log: log, agent: agent, guest: answeringGuest(log: log))
        let host = try sandboxHost(sandboxesDirectory: try scratch(), factory: factory, hostCPUs: 4, hostMemoryBytes: 8 * gib, agentUpdater: GuestAgentUpdater(directory: try agentDirectory("0.2.0+bbbbbbbbbbbb")))
        _ = try await result(host, "sandbox.create", #"{"name":"one","image":"linux","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        var reported: [String] = []
        try await until {
            let info = try await result(host, "system.info", sandboxID: "sandbox_1")
            reported += (info["actions"] as? [[String: Any]] ?? []).compactMap { $0["detail"] as? String }
            return info["agent_version"] as? String == "0.2.0+bbbbbbbbbbbb"
        }
        XCTAssertEqual(reported, ["updated one's guest agent from 0.1.0+aaaaaaaaaaaa to 0.2.0+bbbbbbbbbbbb without restarting the sandbox"], "the update is reported once, with the next result")
        XCTAssertEqual(factory.boots, 1, "the VM was never restarted")
        XCTAssertEqual(log.events.filter { $0.hasPrefix("update") || $0 == "reconnect" }, ["update 0.2.0+bbbbbbbbbbbb 9 bytes", "reconnect"])
        let after = try await call(host, envelope("fs.stat", #"{"path":"/"}"#))
        XCTAssertEqual(after["ok"] as? Bool, true, "requests reach the restarted agent: \(after)")
        let status = try await result(host, "sandbox.status", sandboxID: "sandbox_1")
        XCTAssertEqual(status["lifecycle"] as? String, "ready")
        let ticked = await host.idleTick()
        XCTAssertTrue(ticked.isEmpty, "a guest on the host's build is left alone")
    }

    func testAnUpdateWaitsWhileAJobRunsAndFollowsTheBuildOnDisk() async throws {
        let log = EventLog(), jobs = Locked(0)
        let directory = try agentDirectory("0.1.0+aaaaaaaaaaaa")
        let host = try sandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(log: log, agent: FakeAgent(version: "0.1.0+aaaaaaaaaaaa"), guest: answeringGuest(log: log, jobs: { _ in jobs.value })), hostCPUs: 4, hostMemoryBytes: 8 * gib, agentUpdater: GuestAgentUpdater(directory: directory))
        _ = try await result(host, "sandbox.create", #"{"name":"one","image":"linux","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        jobs.value = 1
        try writeRelease("0.2.0+bbbbbbbbbbbb", in: directory)
        for _ in 0..<3 { let ticked = await host.idleTick(); XCTAssertTrue(ticked.isEmpty, "a running job defers the update") }
        XCTAssertFalse(log.events.contains { $0.hasPrefix("update") })
        XCTAssertTrue(log.events.contains("request guest.activity"), "the host asked the guest about its jobs")
        jobs.value = 0
        let updated = await host.idleTick()
        XCTAssertEqual(updated["sandbox_1"]?["kind"], "agent_updated", "the deferred update lands once the job ended")
        let info = try await result(host, "system.info", sandboxID: "sandbox_1")
        XCTAssertEqual(info["agent_version"] as? String, "0.2.0+bbbbbbbbbbbb")
    }

    func testARefusedUpdateIsNotRetriedUntilTheNextBoot() async throws {
        let log = EventLog()
        let agent = FakeAgent(version: "0.1.0+aaaaaaaaaaaa", updateError: .invalidState("the guest refused agent.chunk: sha256 mismatch"))
        let host = try sandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(log: log, agent: agent, guest: answeringGuest(log: log)), hostCPUs: 4, hostMemoryBytes: 8 * gib, agentUpdater: GuestAgentUpdater(directory: try agentDirectory("0.2.0+bbbbbbbbbbbb")))
        _ = try await result(host, "sandbox.create", #"{"name":"one","image":"linux","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        try await until { (try await result(host, "sandbox.status", sandboxID: "sandbox_1"))["detail"] != nil }
        for _ in 0..<3 { _ = await host.idleTick() }
        XCTAssertEqual(log.events.filter { $0.hasPrefix("update") }.count, 1, "one push, not one per tick")
        let status = try await result(host, "sandbox.status", sandboxID: "sandbox_1")
        XCTAssertEqual(status["lifecycle"] as? String, "ready", "the old agent keeps serving")
        XCTAssertEqual(status["detail"] as? String, "could not update the guest agent to 0.2.0+bbbbbbbbbbbb: the guest refused agent.chunk: sha256 mismatch")
        _ = try await result(host, "fs.stat", #"{"path":"/"}"#, sandboxID: "sandbox_1")
    }

    func testAnExpectedCloseRedialsButAnAgentThatNeverReturnsOrAnUnexpectedCloseStops() async throws {
        let log = EventLog()
        let gone = FakeAgent(version: "0.1.0+aaaaaaaaaaaa", reconnectError: .unsupported("the guest agent did not accept a vsock connection on port 1024 within 2 min"))
        let factory = FakeBackendFactory(log: log, agent: gone, guest: answeringGuest(log: log))
        let host = try sandboxHost(sandboxesDirectory: try scratch(), factory: factory, hostCPUs: 4, hostMemoryBytes: 8 * gib, agentUpdater: GuestAgentUpdater(directory: try agentDirectory("0.2.0+bbbbbbbbbbbb"), restartWindow: 0.3))
        _ = try await result(host, "sandbox.create", #"{"name":"one","image":"linux","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        try await until { (try await result(host, "sandbox.status", sandboxID: "sandbox_1"))["lifecycle"] as? String == "error" }
        XCTAssertGreaterThan(log.events.filter { $0 == "reconnect" }.count, 1, "the host keeps dialling through the restart window")
        let status = try await result(host, "sandbox.status", sandboxID: "sandbox_1")
        XCTAssertEqual(status["detail"] as? String, "the guest agent did not come back after its update to 0.2.0+bbbbbbbbbbbb: the guest agent did not accept a vsock connection on port 1024 within 2 min")
        let running = await factory.made.last?.running
        XCTAssertEqual(running, false, "a guest whose agent never returned is stopped")

        // Without an update, a closed request lane is still the guest lost.
        let closing = FakeBackendFactory(agent: FakeAgent(version: "0.2.0+bbbbbbbbbbbb")) { _ in throw HostDaemonError.guestUnavailable }
        let closed = try sandboxHost(sandboxesDirectory: try scratch(), factory: closing, hostCPUs: 4, hostMemoryBytes: 8 * gib, agentUpdater: GuestAgentUpdater(directory: try agentDirectory("0.2.0+bbbbbbbbbbbb")))
        _ = try await result(closed, "sandbox.create", #"{"name":"two","image":"linux","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        do { _ = try await closed.request(envelope("fs.stat", #"{"path":"/"}"#)); XCTFail("a closed channel fails the request") } catch {}
        let lost = try await result(closed, "sandbox.status", sandboxID: "sandbox_1")
        XCTAssertEqual(lost["lifecycle"] as? String, "error"); XCTAssertEqual(lost["detail"] as? String, "the guest agent closed its channel")
    }

    func testTheUpdaterNamesTheBinaryForTheGuestsOS() async throws {
        let directory = try agentDirectory("0.2.0+bbbbbbbbbbbb")
        let updater = GuestAgentUpdater(directory: directory, chunkBytes: 1024)
        let due = await updater.due(for: GuestAgentIdentity(version: "0.1.0+aaaaaaaaaaaa", os: "linux"))
        XCTAssertEqual(due, AgentBinary(version: "0.2.0+bbbbbbbbbbbb", sha256: String(repeating: "1", count: 64), url: directory.appendingPathComponent("localbox-agent-linux-arm64"), size: 9, chunkBytes: 1024))
        let current = await updater.due(for: GuestAgentIdentity(version: "0.2.0+bbbbbbbbbbbb", os: "linux"))
        XCTAssertNil(current)
        let noBinary = await updater.due(for: GuestAgentIdentity(version: "0.1.0+aaaaaaaaaaaa", os: "darwin"))
        XCTAssertNil(noBinary, "no darwin binary on disk, nothing to push")
        let missing = await GuestAgentUpdater(directory: try scratch()).due(for: GuestAgentIdentity(version: "x", os: "linux"))
        XCTAssertNil(missing, "a host without agent-version.json pushes nothing")
    }
}

extension AgentUpdaterTests {
    /// A host agent directory with `agent-version.json` naming `version` and a 9-byte linux binary.
    func agentDirectory(_ version: String) throws -> URL {
        let directory = try scratch()
        try Data("new agent".utf8).write(to: directory.appendingPathComponent("localbox-agent-linux-arm64"))
        try writeRelease(version, in: directory)
        return directory
    }

    func writeRelease(_ version: String, in directory: URL) throws {
        try Data(#"{"version":"\#(version)","sha256":{"linux":"\#(String(repeating: "1", count: 64))","darwin":"\#(String(repeating: "2", count: 64))"}}"#.utf8).write(to: directory.appendingPathComponent("agent-version.json"), options: .atomic)
    }
}
