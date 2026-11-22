import XCTest
@testable import HostDaemonCore

/// `sandbox.create` with `after_copy`, as the relay sends it to a Mac whose image is still copying: the create follows
/// the copy's record (a scripted stand-in for `image.copy`) and lays the sandbox down once the copy succeeds.
final class SandboxCreateAfterCopyTests: XCTestCase {
    static let image = "image_copied"

    func testTheCreateAnswersAtOnceShowsTheCopysProgressAndCreatesWhenTheCopyLands() async throws {
        let daemon = try await Daemon(root: try scratch())
        try await daemon.startCopy("copy-1")
        let answer = try await daemon.create("create-1", after: "copy-1")
        let produced = try XCTUnwrap((answer["result"] as? [String: Any])?["produced"] as? [String: Any], "\(answer)")
        XCTAssertEqual(produced["state"] as? String, "copying", "answers at once")
        let notYet = await daemon.host.runtime("sandbox_1")
        XCTAssertNil(notYet, "nothing is laid down before the image is here")

        daemon.copy.progress(HostOperationProgress(phase: "receiving", completed: 3, total: 8))
        let following = try await daemon.until("create-1") { $0.progress?.completed == 3 }
        XCTAssertEqual(following.progress, HostOperationProgress(phase: "receiving", completed: 3, total: 8), "the copy's progress is the create's")
        XCTAssertEqual(following.subject, Self.image, "its subject is the image, so image.wait follows it")
        let waited = try await daemon.request("image.wait", input: ["image": Self.image, "timeout_ms": 0])
        XCTAssertEqual((waited["result"] as? [String: Any])?["key"] as? String, "create-1", "image.wait on this Mac follows the create, the image's most recent operation")

        daemon.copy.finish(nil)
        let done = try await daemon.until("create-1") { $0.state != .running }
        XCTAssertEqual(done.state, .succeeded, "\(String(describing: done.error))")
        guard case .object(let result)? = done.result else { return XCTFail("no result") }
        XCTAssertEqual(result["copy_operation_id"], .string("copy-1"))
        XCTAssertEqual(result["name"], .string("one"))
        guard case .array(let actions)? = result["actions"], case .object(let created)? = actions.first else { return XCTFail("no actions: \(result)") }
        XCTAssertEqual(created["kind"], .string("created"))
        let status = await daemon.host.runtime("sandbox_1")?.status()
        XCTAssertEqual(status?.lifecycle, .ready, "created and booted from the copied image")
        let record = await daemon.host.runtime("sandbox_1")?.record
        XCTAssertEqual(record?.imageID, Self.image)

        let replay = try await daemon.create("create-1", after: "copy-1")
        XCTAssertEqual(((replay["result"] as? [String: Any])?["produced"] as? [String: Any])?["state"] as? String, "created", "a replay answers from the same operation")
        XCTAssertEqual(daemon.factory.boots, 1, "and boots nothing twice")
    }

    func testAFailedCopyFailsTheCreateWithTheCopysReasonAndNextStep() async throws {
        let daemon = try await Daemon(root: try scratch())
        try await daemon.startCopy("copy-2")
        _ = try await daemon.create("create-2", after: "copy-2")
        daemon.copy.finish(HostOperationFailure(code: "copy_unreachable", message: "no direct path between the two Macs", nextStep: "put both Macs on the same network once, then copy"))
        let failed = try await daemon.until("create-2") { $0.state != .running }
        XCTAssertEqual(failed.error, HostOperationFailure(code: "copy_unreachable", message: "image \(Self.image) did not arrive, so one was not created: no direct path between the two Macs",
                                                          nextStep: "put both Macs on the same network once, then copy; then delete it with localbox sandbox delete one --confirm one, then create it again"))
        let runtime = await daemon.host.runtime("sandbox_1")
        XCTAssertNil(runtime, "nothing was laid down")
        XCTAssertFalse(FileManager.default.fileExists(atPath: daemon.root.appendingPathComponent("sandboxes/sandbox_1").path))
    }

    func testACreateNamingNoCopyOfItsImageIsRefusedAndJournalsNothing() async throws {
        let daemon = try await Daemon(root: try scratch())
        let refused = try await daemon.create("create-3", after: "copy-missing")
        XCTAssertEqual((refused["error"] as? [String: Any])?["code"] as? String, "invalid_input", "\(refused)")
        let journaled = await daemon.operations.state("create-3")
        XCTAssertNil(journaled)
    }

    func testDeletingTheWaitingSandboxStopsItsCreateSoTheLandedCopyLaysNothingDown() async throws {
        let daemon = try await Daemon(root: try scratch())
        try await daemon.startCopy("copy-5")
        _ = try await daemon.create("create-5", after: "copy-5")
        let deleted = try await daemon.request("sandbox.delete", input: ["confirm": "one"], sandboxID: "sandbox_1")
        let produced = try XCTUnwrap((deleted["result"] as? [String: Any])?["produced"] as? [String: Any], "\(deleted)")
        XCTAssertEqual(produced["removed"] as? [String], ["the create waiting for its image"])
        let stopped = await daemon.operations.state("create-5")
        XCTAssertEqual(stopped?.state, .failed, "stopped before the delete answered")
        XCTAssertEqual(stopped?.error?.code, "operation_cancelled")

        daemon.copy.finish(nil)
        let copied = try await daemon.until("copy-5") { $0.state != .running }
        XCTAssertEqual(copied.state, .succeeded, "a copy another sandbox may wait on goes on")
        try await Task.sleep(nanoseconds: 100_000_000)
        let runtime = await daemon.host.runtime("sandbox_1")
        XCTAssertNil(runtime, "the deleted sandbox is never created")
        let again = try await daemon.request("sandbox.delete", input: ["confirm": "one"], sandboxID: "sandbox_1")
        XCTAssertEqual((again["error"] as? [String: Any])?["code"] as? String, "sandbox_not_found", "nothing waits any more")
    }

    func testARestartMidCopyResumesTheCreateWhichCreatesOnceTheCopyLands() async throws {
        let daemon = try await Daemon(root: try scratch())
        try await daemon.startCopy("copy-4")
        _ = try await daemon.create("create-4", after: "copy-4")
        await daemon.operations.stop()

        let restarted = try await Daemon(root: daemon.root)
        let resumed = await restarted.operations.start()
        XCTAssertEqual(Set(resumed), ["copy-4", "create-4"])
        restarted.copy.finish(nil)
        let done = try await restarted.until("create-4") { $0.state != .running }
        XCTAssertEqual(done.state, .succeeded, "\(String(describing: done.error))")
        let status = await restarted.host.runtime("sandbox_1")?.status()
        XCTAssertEqual(status?.lifecycle, .ready)
    }
}

private struct NeverReached: Error, CustomStringConvertible { let description: String }

/// A scripted copy: its progress and outcome are set by the test; the work polls them.
private final class ScriptedCopy: Sendable {
    private let state = Locked<(shown: HostOperationProgress?, outcome: HostOperationFailure??)>((nil, nil))

    func progress(_ progress: HostOperationProgress) { state.withLock { $0.shown = progress } }
    /// nil succeeds the copy; a failure fails it.
    func finish(_ failure: HostOperationFailure?) { state.withLock { $0.outcome = .some(failure) } }

    func run(_ context: HostOperationContext) async throws -> JSONValue {
        var reported: HostOperationProgress?
        while true {
            let (progress, ended) = state.value
            if let ended { if let failure = ended { throw failure }; return .object(["role": .string("receiver")]) }
            if let progress, progress != reported { try await context.report(progress, checkpoint: context.checkpoint); reported = progress }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}

/// One daemon whose fake Mac already has the image's files (the scripted copy moves none), with `image.copy` scripted.
private struct Daemon {
    let rig: TestDaemon, factory = FakeBackendFactory(images: [builtInImage, SandboxCreateAfterCopyTests.image])
    let copy = ScriptedCopy()
    var root: URL { rig.root }
    var operations: HostOperationStore { rig.operations }
    var host: SandboxHost { rig.host }

    init(root: URL) async throws {
        rig = try await TestDaemon(root: root, factory: factory)
        let copy = copy
        await operations.register(kind: ImageCopy.kind) { try await copy.run($0) }
    }

    func startCopy(_ key: String) async throws {
        _ = try await operations.begin(kind: ImageCopy.kind, key: key, subject: SandboxCreateAfterCopyTests.image, checkpoint: .object([:]))
    }

    func create(_ key: String, after copyKey: String) async throws -> [String: Any] {
        try await request("sandbox.create", input: ["name": "one", "image": SandboxCreateAfterCopyTests.image, "cpus": 2, "memory_bytes": 2 * 1024 * 1024 * 1024, "sleep_after_ms": 1_800_000, "after_copy": copyKey], sandboxID: "sandbox_1", mutationID: key)
    }

    /// The record under `key` once `done` holds, within five seconds.
    func until(_ key: String, _ done: (HostOperationRecord) -> Bool) async throws -> HostOperationRecord {
        for _ in 0..<500 {
            if let record = await operations.state(key), done(record) { return record }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let last = await operations.state(key)
        throw NeverReached(description: "\(key) never reached the state: \(String(describing: last))")
    }

    func request(_ operation: String, input: [String: Any] = [:], sandboxID: String? = nil, mutationID: String? = nil) async throws -> [String: Any] {
        try await call(rig.daemon, envelope(operation, input, mutation: mutationID ?? UUID().uuidString, sandboxID: sandboxID))
    }
}
