import XCTest
@testable import HostDaemonCore

/// `image.capture` through `image.create` as the relay sends it, on fake VMs whose disk and boot store are real files.
final class ImageCaptureTests: XCTestCase {
    func testARunningSandboxIsFrozenOnlyForTheCloneAndKeepsRunning() async throws {
        let daemon = try await Daemon(root: try scratch())
        let record = try await daemon.capture("m-1", image: "image_1")
        XCTAssertEqual(record["state"] as? String, "succeeded", "\(record)")
        XCTAssertEqual(record["subject"] as? String, "image_1", "the operation's subject is the image it makes")
        let result = try XCTUnwrap(record["result"] as? [String: Any])
        XCTAssertNotNil(result["stall_ms"] as? Int, "a frozen capture reports its stall")
        XCTAssertNil(result["woke"])
        XCTAssertEqual(daemon.lane, ["freeze 10000", "pause", "resume", "thaw"], "frozen and paused only around the clone")
        let manifest = try daemon.store.manifest("image_1")
        XCTAssertEqual(manifest.os, .linux)
        XCTAssertEqual(result["size_bytes"] as? UInt64, manifest.sizeBytes)
        XCTAssertEqual(try Data(contentsOf: daemon.store.root.appendingPathComponent("image_1/disk.img")), Daemon.diskBytes)
        XCTAssertTrue(FileManager.default.fileExists(atPath: daemon.store.root.appendingPathComponent("image_1/boot/efi-vars").path))
        let status = await daemon.host.runtime("sandbox_1")!.status()
        XCTAssertEqual(status.lifecycle, .ready, "the sandbox carries on")
    }

    func testAStoppedSandboxIsClonedWithoutAFreeze() async throws {
        let daemon = try await Daemon(root: try scratch())
        _ = try await daemon.request("sandbox.stop", sandboxID: "sandbox_1")
        let record = try await daemon.capture("m-1", image: "image_1")
        XCTAssertEqual(record["state"] as? String, "succeeded", "\(record)")
        let result = try XCTUnwrap(record["result"] as? [String: Any])
        XCTAssertTrue(result["stall_ms"] is NSNull, "nothing froze")
        XCTAssertFalse(daemon.lane.contains { $0.hasPrefix("freeze") })
        let status = await daemon.host.runtime("sandbox_1")!.status()
        XCTAssertEqual(status.lifecycle, .stopped, "and nothing started it")
    }

    func testASleepingSandboxWakesThroughAdmissionThenFreezes() async throws {
        let daemon = try await Daemon(root: try scratch())
        _ = try await daemon.request("sandbox.sleep", sandboxID: "sandbox_1")
        let record = try await daemon.capture("m-1", image: "image_1")
        XCTAssertEqual(record["state"] as? String, "succeeded", "\(record)")
        let result = try XCTUnwrap(record["result"] as? [String: Any])
        XCTAssertEqual(result["woke"] as? String, "restored one from its saved state")
        XCTAssertEqual(daemon.lane, ["save", "freeze 10000", "pause", "resume", "thaw"], "restored from its save file, then frozen")
    }

    func testTooLittleDiskFailsBeforeAnythingFreezes() async throws {
        let daemon = try await Daemon(root: try scratch(), freeBytes: 1024)
        let record = try await daemon.capture("m-1", image: "image_1")
        XCTAssertEqual(record["state"] as? String, "failed")
        let error = try XCTUnwrap(record["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "disk_full")
        XCTAssertTrue((error["next_step"] as? String)?.hasPrefix("free at least") == true, "\(error)")
        XCTAssertTrue(daemon.lane.isEmpty, "nothing froze")
        XCTAssertTrue(daemon.store.list().isEmpty)
    }

    func testAReplayReturnsTheSameOperationAndAnUnknownSourceIsRefused() async throws {
        let daemon = try await Daemon(root: try scratch())
        let first = try await daemon.capture("m-1", image: "image_1")
        let replay = try await daemon.capture("m-1", image: "image_1")
        XCTAssertEqual(replay["key"] as? String, "m-1")
        XCTAssertEqual(replay["started_at"] as? Int, first["started_at"] as? Int, "the same record, not a second run")
        XCTAssertEqual(daemon.lane.filter { $0.hasPrefix("freeze") }.count, 1)
        let refused = try await daemon.request("image.create", input: ["from": "sandbox_9", "image": "image_2"], mutationID: "m-2")
        XCTAssertEqual((refused["error"] as? [String: Any])?["code"] as? String, "sandbox_not_found")
        let journaled = await daemon.operations.state("m-2")
        XCTAssertNil(journaled, "a refused create journals nothing")
    }

    func testAResumeAfterTheCommitOnlyRecordsTheResult() async throws {
        let daemon = try await Daemon(root: try scratch())
        _ = try await daemon.capture("m-1", image: "image_1")
        // The daemon died between the commit and the record's finish: the journal still says running.
        let journal = daemon.root.appendingPathComponent("operations/m-1.json")
        var record = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: journal)) as? [String: Any])
        record["state"] = "running"; record["result"] = nil
        try JSONSerialization.data(withJSONObject: record).write(to: journal)
        let restarted = try await Daemon(root: daemon.root, creating: false)
        await restarted.operations.start()
        let resumed = await restarted.operations.wait("m-1", timeoutMs: 5_000)
        XCTAssertEqual(resumed?.state, .succeeded)
        XCTAssertTrue(restarted.lane.isEmpty, "the image was already committed, so nothing froze again")
    }
}

/// One daemon's sandboxes, operations and image store in a scratch root, with sandbox `sandbox_1` running on a fake VM
/// whose directory holds a real disk and boot store.
private struct Daemon {
    static let diskBytes = Data(repeating: 7, count: 64 * 1024)
    let log = EventLog(), rig: TestDaemon
    var root: URL { rig.root }
    var store: ImageStore { rig.store }
    var operations: HostOperationStore { rig.operations }
    var host: SandboxHost { rig.host }

    init(root: URL, freeBytes: UInt64 = 1 << 40, creating: Bool = true) async throws {
        rig = try await TestDaemon(root: root, factory: FakeBackendFactory(log: log, guest: answeringGuest(log: log)), freeBytes: freeBytes)
        guard creating else { return }
        _ = try await request("sandbox.create", input: ["name": "one", "image": "linux", "cpus": 2, "memory_bytes": 2 * 1024 * 1024 * 1024, "sleep_after_ms": 1_800_000], sandboxID: "sandbox_1")
        let directory = SandboxDirectory(root.appendingPathComponent("sandboxes/sandbox_1"))
        try Self.diskBytes.write(to: directory.disk)
        try Data("efi".utf8).write(to: directory.bootStore(for: .linux))
    }

    /// The VM and control lane events, without requests and the lane's close.
    var lane: [String] { log.events.filter { $0 != "control closed" && !$0.hasPrefix("request ") } }

    func capture(_ key: String, image: String) async throws -> [String: Any] {
        let response = try await request("image.create", input: ["from": "sandbox_1", "image": image], mutationID: key)
        return try XCTUnwrap(response["result"] as? [String: Any], "\(response)")
    }

    func request(_ operation: String, input: [String: Any] = [:], sandboxID: String? = nil, mutationID: String? = nil) async throws -> [String: Any] {
        try await call(rig.daemon, envelope(operation, input, mutation: mutationID ?? UUID().uuidString, sandboxID: sandboxID))
    }
}
