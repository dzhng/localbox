import XCTest
@testable import HostDaemonCore

/// Records what the host asked the idle-sleep prevention to be, in place of the IOKit assertion.
final class RecordingIdleSleep: IdleSleepPrevention, @unchecked Sendable {
    private let asked = Locked<[Bool]>([])
    func hold(_ held: Bool) { asked.withLock { $0.append(held) } }
    var held: Bool { asked.value.last ?? false }
}

final class KeepAwakeTests: XCTestCase {
    func testOnlyUpOrChangingSandboxesAndHostWorkKeepTheMacAwake() {
        let awake: [RuntimeLifecycle] = [.starting, .ready, .freezing, .stopping]
        let asleep: [RuntimeLifecycle] = [.paused, .asleep, .stopped, .error]
        for lifecycle in awake { XCTAssertTrue(KeepAwake.shouldStayAwake([.asleep, lifecycle], hostWorkRunning: false), "\(lifecycle)") }
        for lifecycle in asleep { XCTAssertFalse(KeepAwake.shouldStayAwake([lifecycle], hostWorkRunning: false), "\(lifecycle)") }
        XCTAssertFalse(KeepAwake.shouldStayAwake([], hostWorkRunning: false), "no sandboxes")
        XCTAssertTrue(KeepAwake.shouldStayAwake(asleep, hostWorkRunning: true), "an image build, capture or copy")
    }

    func testARunningSandboxHoldsItUntilItSleepsOrStops() async throws {
        let idle = RecordingIdleSleep()
        let host = try sandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(guest: answeringGuest()), idleSleep: idle)
        let watching = { (try await result(host, "host.watch", #"{"since":0}"#))["keeping_awake"] as? Bool }
        let before = try await watching(); XCTAssertEqual(before, false)

        _ = try await result(host, "sandbox.create", #"{"name":"one","image":"linux","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":300000}"#, sandboxID: "sandbox_1")
        try await until { idle.held }
        let running = try await watching(); XCTAssertEqual(running, true)

        _ = try await result(host, "sandbox.sleep", "{}", sandboxID: "sandbox_1")
        try await until { !idle.held }
        let slept = try await watching(); XCTAssertEqual(slept, false)

        _ = try await call(host, envelope("fs.stat", #"{"path":"/"}"#))
        try await until { idle.held }
        _ = try await result(host, "sandbox.stop", "{}", sandboxID: "sandbox_1")
        try await until { !idle.held }

        _ = try await result(host, "sandbox.start", "{}", sandboxID: "sandbox_1")
        try await until { idle.held }
        await host.releaseIdleSleep()
        XCTAssertFalse(idle.held, "daemon exit lets go")
        _ = try await result(host, "sandbox.stop", "{}", sandboxID: "sandbox_1")
        _ = try await result(host, "sandbox.start", "{}", sandboxID: "sandbox_1")
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(idle.held, "and holds nothing after")
    }

    func testHostWorkHoldsItWhileItRuns() async throws {
        let idle = RecordingIdleSleep(), gate = Gate()
        let rig = try await TestDaemon(root: try scratch(), idleSleep: idle)
        let work: HostOperationWork = { _ in await gate.wait(); return .null }
        await rig.operations.register(kind: "gated", resume: work)
        _ = try await rig.operations.begin(kind: "gated", key: "m-1", subject: "image_1", checkpoint: .null, work: work)
        try await until { idle.held }
        let watched = try await result(rig.host, "host.watch", #"{"since":0}"#); XCTAssertEqual(watched["keeping_awake"] as? Bool, true)
        await gate.open()
        try await until { !idle.held }
    }
}
