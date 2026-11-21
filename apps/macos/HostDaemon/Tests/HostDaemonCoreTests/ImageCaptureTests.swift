import XCTest
@testable import HostDaemonCore

/// `image.capture` through `image.create` as the relay sends it, on fake VMs whose disk and boot store are real files.
final class ImageCaptureTests: XCTestCase {
    func testARunningSandboxIsFrozenOnlyForTheCloneAndKeepsRunning() async throws {
        let daemon = try await Daemon(test: self)
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
        let daemon = try await Daemon(test: self)
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
        let daemon = try await Daemon(test: self)
        _ = try await daemon.request("sandbox.sleep", sandboxID: "sandbox_1")
        let record = try await daemon.capture("m-1", image: "image_1")
        XCTAssertEqual(record["state"] as? String, "succeeded", "\(record)")
        let result = try XCTUnwrap(record["result"] as? [String: Any])
        XCTAssertEqual(result["woke"] as? String, "restored one from its saved state")
        XCTAssertEqual(daemon.lane, ["save", "freeze 10000", "pause", "resume", "thaw"], "restored from its save file, then frozen")
    }

    func testTooLittleDiskFailsBeforeAnythingFreezes() async throws {
        let daemon = try await Daemon(test: self, freeBytes: 1024)
        let record = try await daemon.capture("m-1", image: "image_1")
        XCTAssertEqual(record["state"] as? String, "failed")
        let error = try XCTUnwrap(record["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "disk_full")
        XCTAssertTrue((error["next_step"] as? String)?.hasPrefix("free at least") == true, "\(error)")
        XCTAssertTrue(daemon.lane.isEmpty, "nothing froze")
        XCTAssertTrue(daemon.store.list().isEmpty)
    }

    func testAReplayReturnsTheSameOperationAndAnUnknownSourceIsRefused() async throws {
        let daemon = try await Daemon(test: self)
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
        let daemon = try await Daemon(test: self)
        _ = try await daemon.capture("m-1", image: "image_1")
        // The daemon died between the commit and the record's finish: the journal still says running.
        let journal = daemon.root.appendingPathComponent("operations/m-1.json")
        var record = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: journal)) as? [String: Any])
        record["state"] = "running"; record["result"] = nil
        try JSONSerialization.data(withJSONObject: record).write(to: journal)
        let restarted = try await Daemon(test: self, root: daemon.root, creating: false)
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
    let root: URL, log = EventLog()
    let store: ImageStore, operations: HostOperationStore, host: SandboxHost

    init(test: XCTestCase, freeBytes: UInt64 = .max, root: URL? = nil, creating: Bool = true) async throws {
        let root = try root ?? Self.scratch(test)
        self.root = root
        operations = try HostOperationStore(operationsDirectory: root.appendingPathComponent("operations"))
        store = try ImageStore(imagesDirectory: root.appendingPathComponent("images"))
        let capture = ImageCapture(store: store, operations: operations, freeBytes: { freeBytes })
        host = SandboxHost(sandboxesDirectory: root.appendingPathComponent("sandboxes"), factory: FakeBackendFactory(log: log, guest: FreezeLockTests.guest(log)), hostCPUs: 4, hostMemoryBytes: 8 * 1024 * 1024 * 1024,
                           images: ImageHost(operations: operations, files: StoredImageFiles(store: store), capture: capture))
        await capture.attach(to: host)
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
        let envelope: [String: Any] = ["protocol_version": "v1", "request_id": "r-\(UUID().uuidString)", "operation": operation, "sandbox_id": sandboxID ?? NSNull(), "deadline_ms": 30_000, "mutation_id": mutationID ?? UUID().uuidString, "input": input]
        let response = try await host.request(try JSONSerialization.data(withJSONObject: envelope))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: response) as? [String: Any])
    }

    static func scratch(_ test: XCTestCase) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lb-capture-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        test.addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }
}
