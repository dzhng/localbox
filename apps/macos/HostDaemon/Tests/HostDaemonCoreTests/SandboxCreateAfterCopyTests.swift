import XCTest
@testable import HostDaemonCore

/// `sandbox.create` with `after_copy`, as the relay sends it to a Mac whose image is still copying: the create follows
/// the copy's record (a scripted stand-in for `image.copy`) and lays the sandbox down once the copy succeeds.
final class SandboxCreateAfterCopyTests: XCTestCase {
    static let image = "image_copied"

    func testTheCreateAnswersAtOnceShowsTheCopysProgressAndCreatesWhenTheCopyLands() async throws {
        let daemon = try await Daemon(test: self)
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
        let daemon = try await Daemon(test: self)
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
        let daemon = try await Daemon(test: self)
        let refused = try await daemon.create("create-3", after: "copy-missing")
        XCTAssertEqual((refused["error"] as? [String: Any])?["code"] as? String, "invalid_input", "\(refused)")
        let journaled = await daemon.operations.state("create-3")
        XCTAssertNil(journaled)
    }

    func testARestartMidCopyResumesTheCreateWhichCreatesOnceTheCopyLands() async throws {
        let daemon = try await Daemon(test: self)
        try await daemon.startCopy("copy-4")
        _ = try await daemon.create("create-4", after: "copy-4")
        await daemon.operations.stop()

        let restarted = try await Daemon(test: self, root: daemon.root)
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
private final class ScriptedCopy: @unchecked Sendable {
    private let lock = NSLock()
    private var shown: HostOperationProgress?
    private var outcome: HostOperationFailure??

    func progress(_ progress: HostOperationProgress) { lock.withLock { shown = progress } }
    /// nil succeeds the copy; a failure fails it.
    func finish(_ failure: HostOperationFailure?) { lock.withLock { outcome = .some(failure) } }

    func run(_ context: HostOperationContext) async throws -> JSONValue {
        var reported: HostOperationProgress?
        while true {
            let (progress, ended) = lock.withLock { (shown, outcome) }
            if let ended { if let failure = ended { throw failure }; return .object(["role": .string("receiver")]) }
            if let progress, progress != reported { try await context.report(progress, checkpoint: context.checkpoint); reported = progress }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}

/// One daemon whose fake Mac already has the image's files (the scripted copy moves none), with `image.copy` scripted.
private struct Daemon {
    let root: URL
    let operations: HostOperationStore, host: SandboxHost, factory: FakeBackendFactory
    let copy = ScriptedCopy()

    init(test: XCTestCase, root: URL? = nil) async throws {
        let root = try root ?? Self.scratch(test)
        self.root = root
        operations = try HostOperationStore(operationsDirectory: root.appendingPathComponent("operations"))
        factory = FakeBackendFactory(images: [builtInImage, SandboxCreateAfterCopyTests.image])
        let afterCopy = SandboxCreateAfterCopy(operations: operations)
        host = SandboxHost(sandboxesDirectory: root.appendingPathComponent("sandboxes"), factory: factory, hostCPUs: 4, hostMemoryBytes: 8 * 1024 * 1024 * 1024,
                           images: ImageHost(operations: operations), afterCopy: afterCopy)
        let copy = copy
        await operations.register(kind: ImageCopy.kind) { try await copy.run($0) }
        await afterCopy.attach(to: host)
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
        let envelope: [String: Any] = ["protocol_version": "v1", "request_id": "r-\(UUID().uuidString)", "operation": operation, "sandbox_id": sandboxID ?? NSNull(), "deadline_ms": 30_000, "mutation_id": mutationID ?? UUID().uuidString, "input": input]
        let response = try await host.request(try JSONSerialization.data(withJSONObject: envelope))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: response) as? [String: Any])
    }

    static func scratch(_ test: XCTestCase) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lb-after-copy-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        test.addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }
}
