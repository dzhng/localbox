import XCTest
@testable import HostDaemonCore

/// What the relay and the connector see of host operations and image files, through the daemon's routing as on the socket.
final class ImageHostTests: XCTestCase {
    func testImageWaitFollowsTheImagesLatestOperationAndIsBoundedByItsTimeoutAndDeadline() async throws {
        let rig = try await TestDaemon(root: try scratch()), host = rig.daemon, operations = rig.operations
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
        let pending = try await call(host, envelope("image.wait", ["image": "image_1", "timeout_ms": 100]))
        XCTAssertLessThan(clock.now - began, .seconds(5))
        let running = try XCTUnwrap(pending["result"] as? [String: Any])
        XCTAssertEqual(running["key"] as? String, "m-new", "a retried copy starts a new record; the wait follows the newest")
        XCTAssertEqual(running["state"] as? String, "running", "a pending state is a normal answer")
        XCTAssertEqual((running["progress"] as? [String: Any])?["completed"] as? Int, 10)
        XCTAssertNil(running["checkpoint"], "the checkpoint is the kind's own")

        // No timeout_ms: the request's deadline, less a second to answer in, bounds the wait.
        let deadlineBound = clock.now
        _ = try await call(host, envelope("image.wait", ["image": "image_1"], deadlineMs: 1_200))
        XCTAssertLessThan(clock.now - deadlineBound, .seconds(1))

        await slow.open()
        let done = try await result(host, "image.wait", ["image": "image_1", "timeout_ms": 5_000])
        XCTAssertEqual(done["state"] as? String, "succeeded")
        let unknown = try await failure(host, "image.wait", ["image": "image_2"])
        XCTAssertEqual(unknown["code"] as? String, "image_not_found")
    }

    func testFinishedOperationsAreHandedToTheConnectorUntilItReportsThemAcrossARestart() async throws {
        let directory = try scratch()
        let rig = try await TestDaemon(root: directory), host = rig.daemon, operations = rig.operations
        await operations.register(kind: "build") { _ in .object(["size_bytes": .number(7)]) }
        await operations.register(kind: "fails") { _ in throw HostOperationFailure(code: "disk_full", message: "no room", nextStep: "free some disk") }

        let clock = ContinuousClock(), began = clock.now
        let idle = try await result(host, "host.operations", ["timeout_ms": 100])
        XCTAssertEqual((idle["operations"] as? [Any])?.count, 0)
        XCTAssertGreaterThanOrEqual(clock.now - began, .milliseconds(100), "with nothing finished, the poll waits")

        // A poll that is waiting answers as soon as an operation finishes.
        let woken = Task { try await result(host, "host.operations", ["timeout_ms": 10_000]) }
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
        _ = try await call(host, envelope("host.operations", ["reported": ["m-1"], "timeout_ms": 1]))
        await operations.stop()
        let restarted = try await TestDaemon(root: directory)
        let after = try await result(restarted.daemon, "host.operations", ["timeout_ms": 1])
        XCTAssertEqual((after["operations"] as? [[String: Any]])?.compactMap { $0["key"] as? String }, ["m-2"])
    }

    func testOperationsStartDirectlyOnlyOnADevDaemon() async throws {
        let begin: [String: Any] = ["kind": "sleep_steps", "key": "m-1", "subject": "image_1", "checkpoint": ["done": 0, "steps": 3, "step_ms": 1]]
        let release = try await TestDaemon(root: try scratch()).daemon
        let refused = try await failure(release, "host.begin_operation", begin)
        XCTAssertEqual(refused["code"] as? String, "unsupported")

        let dev = try await TestDaemon(root: try scratch(), dev: true).daemon
        let begun = try await result(dev, "host.begin_operation", begin)
        XCTAssertEqual(begun["state"] as? String, "running")
        let done = try await result(dev, "image.wait", ["image": "image_1", "timeout_ms": 5_000])
        XCTAssertEqual(done["state"] as? String, "succeeded")
        XCTAssertEqual((done["progress"] as? [String: Any])?["completed"] as? Int, 3)
        XCTAssertEqual((done["result"] as? [String: Any])?["size_bytes"] as? Int, 3 * 1_048_576)
    }

    /// The mirror's `images` as the connector sends them.
    private func listing(_ ids: [String]) -> [[String: Any]] { ids.map { ["image_id": $0, "name": "name-of-\($0)"] } }

    func testTheCatalogMirrorRemovesOnlyImagesThatSameMachinesCatalogListedBefore() async throws {
        let rig = try await TestDaemon(root: try scratch()), host = rig.daemon
        for (id, machine) in [("image_kept", "m1"), ("image_dropped", "m1"), ("image_other_sign_in", "m0"), ("image_never_listed", nil), ("image_building", "m1")] { try rig.store.plant(id, listedBy: machine) }
        try rig.store.plant(builtInImage)
        let gate = Gate()
        await rig.operations.register(kind: "build") { _ in await gate.wait(); return .null }
        _ = try await rig.operations.begin(kind: "build", key: "m-b", subject: "image_building", checkpoint: .null)

        let mirrored = try await result(host, "image.mirror", ["machine_id": "m1", "images": listing(["image_kept", "image_new", "image_absent"])])
        XCTAssertEqual((mirrored["deleted"] as? [[String: String]])?.map { $0["image"] }, ["image_dropped"])
        XCTAssertEqual(mirrored["unknown"] as? [String], ["image_building", "image_never_listed", "image_other_sign_in"], "running work, never listed, or listed by another sign-in: left alone")
        XCTAssertEqual(mirrored["missing"] as? [String], ["image_absent", "image_new"])
        XCTAssertEqual(rig.store.list().map(\.imageID), ["image_building", "image_kept", "image_never_listed", "image_other_sign_in", builtInImage], "the built-in image is never the catalog's to remove")

        // A listed image is marked as this machine's, so a later push without it removes it.
        _ = try await result(host, "image.mirror", ["machine_id": "m1", "images": listing(["image_kept", "image_never_listed"])])
        XCTAssertEqual(rig.store.held().first { $0.imageID == "image_never_listed" }?.listedBy, "m1")
        let dropped = try await result(host, "image.mirror", ["machine_id": "m1", "images": []])
        XCTAssertEqual(Set((dropped["deleted"] as? [[String: String]])?.compactMap { $0["image"] } ?? []), ["image_kept", "image_never_listed"])
        XCTAssertEqual(rig.store.held().map(\.imageID), ["image_building", "image_other_sign_in"])
        await gate.open()
    }

    func testImageWorkInTheWatchIsCalledByTheNameTheMirrorLastGave() async throws {
        let rig = try await TestDaemon(root: try scratch()), host = rig.daemon
        let gate = Gate()
        await rig.operations.register(kind: "copy") { _ in await gate.wait(); return .null }
        for id in ["image_copying", "image_unlisted"] { _ = try await rig.operations.begin(kind: "copy", key: "m-\(id)", subject: id, checkpoint: .null) }
        func names() async throws -> [String: String] {
            let watch = try await result(host, "host.watch", ["since": 0, "timeout_ms": 0])
            return Dictionary(uniqueKeysWithValues: (watch["operations"] as? [[String: Any]] ?? []).compactMap { record in (record["image_name"] as? String).map { (record["subject"] as! String, $0) } })
        }
        let unnamed = try await names()
        XCTAssertEqual(unnamed, [:], "before any mirror the daemon knows only ids")

        _ = try await result(host, "image.mirror", ["machine_id": "m1", "images": [["image_id": "image_copying", "name": "ubuntu-dev"]]])
        let named = try await names()
        XCTAssertEqual(named, ["image_copying": "ubuntu-dev"], "an image the account doesn't list here stays unnamed")
        _ = try await result(host, "image.mirror", ["machine_id": "m1", "images": [["image_id": "image_copying", "name": "ubuntu-24"]]])
        let renamed = try await names()
        XCTAssertEqual(renamed, ["image_copying": "ubuntu-24"], "a rename in the account reaches the watch")
        await gate.open()
    }

    func testDeleteRemovesTheFilesUnlessWorkOnTheImageIsRunning() async throws {
        let rig = try await TestDaemon(root: try scratch()), host = rig.daemon
        for id in ["image_1", "image_2"] { try rig.store.plant(id, listedBy: "m1") }
        let removed = try await result(host, "image.delete", ["image": "image_1"])
        XCTAssertEqual(removed["removed"] as? Bool, true)
        XCTAssertThrowsError(try rig.store.manifest("image_1"))
        let again = try await result(host, "image.delete", ["image": "image_1"])
        XCTAssertEqual(again["removed"] as? Bool, false, "deleting what is gone is not an error")
        let gate = Gate()
        await rig.operations.register(kind: "copy") { _ in await gate.wait(); return .null }
        _ = try await rig.operations.begin(kind: "copy", key: "m-c", subject: "image_2", checkpoint: .null)
        let busy = try await failure(host, "image.delete", ["image": "image_2"])
        XCTAssertEqual(busy["code"] as? String, "conflict")
        await gate.open()
    }
}
