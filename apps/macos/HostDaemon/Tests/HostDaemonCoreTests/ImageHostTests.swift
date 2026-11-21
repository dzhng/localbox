import XCTest
@testable import HostDaemonCore

/// What the relay and the connector see of host operations, through `SandboxHost`'s routing as on the socket.
final class ImageHostTests: XCTestCase {
    func testImageWaitFollowsTheImagesLatestOperationAndIsBoundedByItsTimeoutAndDeadline() async throws {
        let (host, operations) = try await daemon()
        let held = Gate()
        await operations.register(kind: "build") { _ in await held.wait(); return .object(["size_bytes": .number(42)]) }
        _ = try await operations.begin(kind: "build", key: "m-old", subject: "image_1", checkpoint: .null)
        await held.open()
        _ = await operations.wait("m-old", timeoutMs: 5_000)
        let slow = Gate()
        await operations.register(kind: "copy") { context in
            try await context.report(HostOperationProgress(phase: "copying", completed: 10, total: 100), checkpoint: .null)
            await slow.wait(); return .null
        }
        _ = try await operations.begin(kind: "copy", key: "m-new", subject: "image_1", checkpoint: .null)

        let clock = ContinuousClock(), began = clock.now
        let pending = try await call(host, "image.wait", ["image": "image_1", "timeout_ms": 100])
        XCTAssertLessThan(clock.now - began, .seconds(5))
        let running = try XCTUnwrap(pending["result"] as? [String: Any])
        XCTAssertEqual(running["key"] as? String, "m-new", "a retried copy starts a new record; the wait follows the newest")
        XCTAssertEqual(running["state"] as? String, "running", "a pending state is a normal answer")
        XCTAssertEqual((running["progress"] as? [String: Any])?["completed"] as? Int, 10)
        XCTAssertNil(running["checkpoint"], "the checkpoint is the kind's own")

        // No timeout_ms: the request's deadline, less a second to answer in, bounds the wait.
        let deadlineBound = clock.now
        _ = try await call(host, "image.wait", ["image": "image_1"], deadlineMs: 1_200)
        XCTAssertLessThan(clock.now - deadlineBound, .seconds(1))

        await slow.open()
        let done = try await result(host, "image.wait", ["image": "image_1", "timeout_ms": 5_000])
        XCTAssertEqual(done["state"] as? String, "succeeded")
        let unknown = try await failure(host, "image.wait", ["image": "image_2"])
        XCTAssertEqual(unknown["code"] as? String, "image_not_found")
    }

    func testFinishedOperationsAreHandedToTheConnectorUntilItReportsThemAcrossARestart() async throws {
        let directory = try scratch()
        let (host, operations) = try await daemon(directory)
        await operations.register(kind: "build") { _ in .object(["size_bytes": .number(7)]) }
        await operations.register(kind: "fails") { _ in throw HostOperationFailure(code: "disk_full", message: "no room", nextStep: "free some disk") }

        let clock = ContinuousClock(), began = clock.now
        let idle = try await result(host, "host.operations", ["timeout_ms": 100])
        XCTAssertEqual((idle["operations"] as? [Any])?.count, 0)
        XCTAssertGreaterThanOrEqual(clock.now - began, .milliseconds(100), "with nothing finished, the poll waits")

        // A poll that is waiting answers as soon as an operation finishes.
        let woken = Task { try await self.result(host, "host.operations", ["timeout_ms": 10_000]) }
        try await Task.sleep(nanoseconds: 50_000_000)
        _ = try await operations.begin(kind: "build", key: "m-1", subject: "image_1", checkpoint: .null)
        _ = try await operations.begin(kind: "fails", key: "m-2", subject: "image_2", checkpoint: .null)
        _ = await operations.wait("m-2", timeoutMs: 5_000)
        let first = try await woken.value
        XCTAssertFalse((first["operations"] as? [[String: Any]] ?? []).isEmpty)
        let both = try await result(host, "host.operations", ["timeout_ms": 100])
        let outcomes = try XCTUnwrap(both["operations"] as? [[String: Any]])
        XCTAssertEqual(Set(outcomes.compactMap { $0["key"] as? String }), ["m-1", "m-2"])
        let failed = try XCTUnwrap(outcomes.first { $0["key"] as? String == "m-2" }?["error"] as? [String: Any])
        XCTAssertEqual(failed["next_step"] as? String, "free some disk")

        // Reported once: acknowledged outcomes stop coming, and an unreported one survives a restart.
        _ = try await call(host, "host.operations", ["reported": ["m-1"], "timeout_ms": 1])
        await operations.stop()
        let (restarted, _) = try await daemon(directory)
        let after = try await result(restarted, "host.operations", ["timeout_ms": 1])
        XCTAssertEqual((after["operations"] as? [[String: Any]])?.compactMap { $0["key"] as? String }, ["m-2"])
    }

    func testOperationsStartDirectlyOnlyOnADevDaemon() async throws {
        let operations = try HostOperationStore(operationsDirectory: try scratch())
        await FixtureOperations.register(on: operations)
        let release = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(), images: ImageHost(operations: operations))
        let begin: [String: Any] = ["kind": "sleep_steps", "key": "m-1", "subject": "image_1", "checkpoint": ["done": 0, "steps": 3, "step_ms": 1]]
        let refused = try await failure(release, "host.begin_operation", begin)
        XCTAssertEqual(refused["code"] as? String, "unsupported")

        let dev = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(), images: ImageHost(operations: operations, allowsDirectOperations: true))
        let begun = try await result(dev, "host.begin_operation", begin)
        XCTAssertEqual(begun["state"] as? String, "running")
        let done = try await result(dev, "image.wait", ["image": "image_1", "timeout_ms": 5_000])
        XCTAssertEqual(done["state"] as? String, "succeeded")
        XCTAssertEqual((done["progress"] as? [String: Any])?["completed"] as? Int, 3)
        XCTAssertEqual((done["result"] as? [String: Any])?["size_bytes"] as? Int, 3 * 1_048_576)

        let bare = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory())
        let unsupported = try await failure(bare, "image.wait", ["image": "image_1"])
        XCTAssertEqual(unsupported["code"] as? String, "unsupported")
    }

    func testTheCatalogMirrorRemovesOnlyImagesThatSameMachinesCatalogListedBefore() async throws {
        let files = FakeImageFiles(["image_kept": "m1", "image_dropped": "m1", "image_other_sign_in": "m0", "image_never_listed": nil, "image_building": "m1"])
        let (host, operations) = try await daemon(files: files)
        let gate = Gate()
        await operations.register(kind: "build") { _ in await gate.wait(); return .null }
        _ = try await operations.begin(kind: "build", key: "m-b", subject: "image_building", checkpoint: .null)

        let mirrored = try await result(host, "image.mirror", ["machine_id": "m1", "images": ["image_kept", "image_new", "image_absent"]])
        XCTAssertEqual((mirrored["deleted"] as? [[String: String]])?.map { $0["image"] }, ["image_dropped"])
        XCTAssertEqual(mirrored["unknown"] as? [String], ["image_building", "image_never_listed", "image_other_sign_in"], "running work, never listed, or listed by another sign-in: left alone")
        XCTAssertEqual(mirrored["missing"] as? [String], ["image_absent", "image_new"])
        let left = await files.held()
        XCTAssertEqual(left.keys.sorted(), ["image_building", "image_kept", "image_never_listed", "image_other_sign_in"])

        // A listed image is marked as this machine's, so a later push without it removes it.
        _ = try await result(host, "image.mirror", ["machine_id": "m1", "images": ["image_kept", "image_never_listed"]])
        let afterListing = await files.held()
        XCTAssertEqual(afterListing["image_never_listed"], "m1")
        let dropped = try await result(host, "image.mirror", ["machine_id": "m1", "images": []])
        XCTAssertEqual(Set((dropped["deleted"] as? [[String: String]])?.compactMap { $0["image"] } ?? []), ["image_kept", "image_never_listed"])
        let remaining = await files.held()
        XCTAssertEqual(remaining.keys.sorted(), ["image_building", "image_other_sign_in"])
        await gate.open()
    }

    func testDeleteRemovesTheFilesUnlessWorkOnTheImageIsRunning() async throws {
        let files = FakeImageFiles(["image_1": "m1", "image_2": "m1"])
        let (host, operations) = try await daemon(files: files)
        let removed = try await result(host, "image.delete", ["image": "image_1"])
        XCTAssertEqual(removed["removed"] as? Bool, true)
        let again = try await result(host, "image.delete", ["image": "image_1"])
        XCTAssertEqual(again["removed"] as? Bool, false, "deleting what is gone is not an error")
        let gate = Gate()
        await operations.register(kind: "copy") { _ in await gate.wait(); return .null }
        _ = try await operations.begin(kind: "copy", key: "m-c", subject: "image_2", checkpoint: .null)
        let busy = try await failure(host, "image.delete", ["image": "image_2"])
        XCTAssertEqual(busy["code"] as? String, "conflict")
        await gate.open()
        let (bare, _) = try await daemon()
        let unsupported = try await failure(bare, "image.mirror", ["machine_id": "m1", "images": []])
        XCTAssertEqual(unsupported["code"] as? String, "unsupported", "no image store yet")
    }

    private func daemon(_ directory: URL? = nil, files: (any ImageFiles)? = nil) async throws -> (SandboxHost, HostOperationStore) {
        let operations = try HostOperationStore(operationsDirectory: try directory ?? scratch())
        let host = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(), images: ImageHost(operations: operations, files: files))
        return (host, operations)
    }

    private func call(_ host: SandboxHost, _ operation: String, _ input: [String: Any], deadlineMs: Int = 30_000) async throws -> [String: Any] {
        let envelope: [String: Any] = ["protocol_version": "v1", "request_id": "r-\(UUID().uuidString)", "operation": operation, "sandbox_id": NSNull(), "deadline_ms": deadlineMs, "mutation_id": NSNull(), "input": input]
        let response = try await host.request(try JSONSerialization.data(withJSONObject: envelope))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: response) as? [String: Any])
    }

    private func result(_ host: SandboxHost, _ operation: String, _ input: [String: Any], deadlineMs: Int = 30_000) async throws -> [String: Any] {
        let response = try await call(host, operation, input, deadlineMs: deadlineMs)
        return try XCTUnwrap(response["result"] as? [String: Any], "\(response)")
    }

    private func failure(_ host: SandboxHost, _ operation: String, _ input: [String: Any]) async throws -> [String: Any] {
        let response = try await call(host, operation, input)
        return try XCTUnwrap(response["error"] as? [String: Any], "\(response)")
    }

    private func scratch() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lb-image-host-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }
}

/// Image files in memory: image id to the machine whose catalog listed it.
actor FakeImageFiles: ImageFiles {
    private var images: [String: String?]
    init(_ images: [String: String?]) { self.images = images }
    func held() -> [String: String?] { images }
    func list() -> [HeldImage] { images.map { HeldImage(imageID: $0.key, listedBy: $0.value) } }
    func markListed(_ imageID: String, by machineID: String) { if images[imageID] != nil { images[imageID] = machineID } }
    func remove(_ imageID: String) -> Bool { images.removeValue(forKey: imageID) != nil }
}
