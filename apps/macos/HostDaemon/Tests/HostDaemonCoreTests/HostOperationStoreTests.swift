import XCTest
@testable import HostDaemonCore

/// The test-only kind from the slice: `sleep_steps` advances a counter to `steps`, journaling each step as its
/// checkpoint. `log` records every step actually run, so a test can tell a resume from a restart from scratch.
private actor StepLog {
    var ran: [Int] = []
    func append(_ step: Int) { ran.append(step) }
}

private func sleepSteps(steps: Int, stepMs: UInt64, log: StepLog) -> HostOperationWork {
    { context in
        guard case .object(let checkpoint) = context.checkpoint, case .number(let done)? = checkpoint["done"] else {
            throw HostOperationFailure(code: "invalid_input", message: "sleep_steps needs a checkpoint")
        }
        for step in Int(done)..<steps {
            try await Task.sleep(nanoseconds: stepMs * 1_000_000)
            await log.append(step + 1)
            try await context.report(HostOperationProgress(phase: "stepping", completed: step + 1, total: steps), checkpoint: .object(["done": .number(Double(step + 1))]))
        }
        return .object(["steps": .number(Double(steps))])
    }
}

private let start: JSONValue = .object(["done": .number(0)])

final class HostOperationStoreTests: XCTestCase {
    func testAnUnfinishedOperationResumesFromItsCheckpointAfterARestart() async throws {
        let directory = try scratch()
        let log = StepLog()
        let first = try HostOperationStore(operationsDirectory: directory)
        await first.register(kind: "sleep_steps", resume: sleepSteps(steps: 6, stepMs: 20, log: log))
        _ = try await first.begin(kind: "sleep_steps", key: "m-1", subject: "counter", checkpoint: start, work: sleepSteps(steps: 6, stepMs: 20, log: log))
        try await until { (await first.state("m-1")?.progress?.completed ?? 0) >= 2 }
        await first.stop()
        let stopped = await first.state("m-1")
        let left = try XCTUnwrap(stopped)
        XCTAssertEqual(left.state, .running, "a daemon exit leaves the record for the next start")
        let journaled = try XCTUnwrap(left.progress?.completed)
        XCTAssertLessThan(journaled, 6)

        let second = try HostOperationStore(operationsDirectory: directory)
        await second.register(kind: "sleep_steps", resume: sleepSteps(steps: 6, stepMs: 1, log: log))
        let resumed = await second.start()
        XCTAssertEqual(resumed, ["m-1"])
        let finished = await second.wait("m-1", timeoutMs: 5_000)
        let done = try XCTUnwrap(finished)
        XCTAssertEqual(done.state, .succeeded)
        XCTAssertEqual(done.result, .object(["steps": .number(6)]))
        XCTAssertEqual(done.progress, HostOperationProgress(phase: "stepping", completed: 6, total: 6))
        let ran = await log.ran
        // Only a step past the last checkpoint (one cancelled mid-report) may run twice; nothing restarts at 1.
        XCTAssertEqual(ran.filter { $0 == 1 }.count, 1, "resumed from the checkpoint, not from scratch: \(ran)")
        XCTAssertEqual(Array(ran.suffix(6 - journaled)), Array((journaled + 1)...6))
        let journal = await (try HostOperationStore(operationsDirectory: directory)).state("m-1")
        XCTAssertEqual(journal, done, "the finished record is what the journal holds")
    }

    func testAReplayedKeyReturnsTheSameRecordAndNeverRunsTwice() async throws {
        let directory = try scratch()
        let log = StepLog()
        let store = try HostOperationStore(operationsDirectory: directory)
        await store.register(kind: "sleep_steps", resume: sleepSteps(steps: 3, stepMs: 1, log: log))
        let begun = try await store.begin(kind: "sleep_steps", key: "m-1", subject: "counter", checkpoint: start, work: sleepSteps(steps: 3, stepMs: 1, log: log))
        let replayed = try await store.begin(kind: "sleep_steps", key: "m-1", subject: "counter", checkpoint: start, work: sleepSteps(steps: 3, stepMs: 1, log: log))
        XCTAssertEqual(replayed.startedAt, begun.startedAt)
        let finished = await store.wait("m-1", timeoutMs: 5_000)
        let done = try XCTUnwrap(finished)
        let afterFinish = try await store.begin(kind: "sleep_steps", key: "m-1", subject: "counter", checkpoint: start, work: sleepSteps(steps: 3, stepMs: 1, log: log))
        XCTAssertEqual(afterFinish, done)

        // A replay after a restart is answered from the journal, still without running anything.
        let restarted = try HostOperationStore(operationsDirectory: directory)
        await restarted.register(kind: "sleep_steps", resume: sleepSteps(steps: 3, stepMs: 1, log: log))
        let resumed = await restarted.start()
        XCTAssertEqual(resumed, [])
        let afterRestart = try await restarted.begin(kind: "sleep_steps", key: "m-1", subject: "counter", checkpoint: start, work: sleepSteps(steps: 3, stepMs: 1, log: log))
        XCTAssertEqual(afterRestart, done)
        let ran = await log.ran
        XCTAssertEqual(ran, [1, 2, 3])
    }

    func testWaitIsBoundedAndAnswersAtOnceWhenFinished() async throws {
        let store = try HostOperationStore(operationsDirectory: try scratch())
        let log = StepLog()
        await store.register(kind: "sleep_steps", resume: sleepSteps(steps: 1, stepMs: 60_000, log: log))
        _ = try await store.begin(kind: "sleep_steps", key: "slow", subject: "counter", checkpoint: start, work: sleepSteps(steps: 1, stepMs: 60_000, log: log))
        let clock = ContinuousClock()
        let began = clock.now
        let timedOut = await store.wait("slow", timeoutMs: 100)
        let pending = try XCTUnwrap(timedOut)
        let waited = clock.now - began
        XCTAssertEqual(pending.state, .running, "a pending state is a normal answer, never a timeout error")
        XCTAssertGreaterThanOrEqual(waited, .milliseconds(100)); XCTAssertLessThan(waited, .seconds(5))
        let unknown = await store.wait("never-begun", timeoutMs: 60_000)
        XCTAssertNil(unknown)
        XCTAssertEqual(HostOperationStore.maxWaitMs, 120_000)
        await store.stop()

        let failing = try HostOperationStore(operationsDirectory: try scratch())
        await failing.register(kind: "fails", resume: { _ in throw HostOperationFailure(code: "invalid_input", message: "no") })
        _ = try await failing.begin(kind: "fails", key: "m-1", subject: "x", work: { _ in throw HostOperationFailure(code: "invalid_input", message: "no") })
        let finished = await failing.wait("m-1", timeoutMs: 5_000)
        let failed = try XCTUnwrap(finished)
        XCTAssertEqual(failed.state, .failed); XCTAssertEqual(failed.error, HostOperationFailure(code: "invalid_input", message: "no"))
        let again = clock.now
        _ = await failing.wait("m-1", timeoutMs: 60_000)
        XCTAssertLessThan(clock.now - again, .seconds(1), "a finished record answers without waiting")
    }

    func testAKindWithNoResumerIsRefusedAndAnOrphanedRecordFails() async throws {
        let directory = try scratch()
        let store = try HostOperationStore(operationsDirectory: directory)
        do { _ = try await store.begin(kind: "unregistered", key: "m-1", subject: "x", work: { _ in .null }); XCTFail("began a kind no restart could resume") } catch {}
        await store.register(kind: "gone", resume: { _ in try await Task.sleep(nanoseconds: 60_000_000_000); return .null })
        _ = try await store.begin(kind: "gone", key: "m-2", subject: "x", work: { _ in try await Task.sleep(nanoseconds: 60_000_000_000); return .null })
        await store.stop()

        let restarted = try HostOperationStore(operationsDirectory: directory)
        let resumed = await restarted.start()
        XCTAssertEqual(resumed, [])
        let orphaned = await restarted.state("m-2")
        let orphan = try XCTUnwrap(orphaned)
        XCTAssertEqual(orphan.state, .failed); XCTAssertEqual(orphan.error?.code, "unsupported")
    }

    /// Long work never queues behind the sandbox owner: two kinds run at once while `SandboxHost` keeps answering.
    func testTwoKindsRunAtOnceWithoutBlockingTheSandboxHost() async throws {
        let store = try HostOperationStore(operationsDirectory: try scratch())
        let gate = Gate()
        let held: HostOperationWork = { context in
            try await context.report(HostOperationProgress(phase: "holding"), checkpoint: .null)
            await gate.wait()
            return .string(context.subject)
        }
        await store.register(kind: "build", resume: held)
        await store.register(kind: "copy", resume: held)
        _ = try await store.begin(kind: "build", key: "b", subject: "macos", work: held)
        _ = try await store.begin(kind: "copy", key: "c", subject: "linux", work: held)
        try await until {
            let b = await store.state("b"), c = await store.state("c")
            return b?.progress != nil && c?.progress != nil
        }

        let host = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory())
        let request = Data(#"{"protocol_version":"v1","request_id":"r","operation":"sandbox.list","sandbox_id":null,"deadline_ms":1000,"mutation_id":null,"input":{}}"#.utf8)
        let listed = try JSONSerialization.jsonObject(with: try await host.request(request)) as? [String: Any]
        XCTAssertEqual(listed?["ok"] as? Bool, true)
        let b = await store.state("b")?.state, c = await store.state("c")?.state
        XCTAssertEqual(b, .running); XCTAssertEqual(c, .running)

        await gate.open()
        let built = await store.wait("b", timeoutMs: 5_000), copied = await store.wait("c", timeoutMs: 5_000)
        XCTAssertEqual(built?.result, .string("macos")); XCTAssertEqual(copied?.result, .string("linux"))
    }

    private func scratch() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lb-operations-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    private func until(_ condition: @escaping @Sendable () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<500 { if await condition() { return }; try await Task.sleep(nanoseconds: 10_000_000) }
        XCTFail("condition never held", file: file, line: line)
    }
}

/// Holds every waiter until opened.
private actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() { isOpen = true; for waiter in waiters { waiter.resume() }; waiters = [] }
}
