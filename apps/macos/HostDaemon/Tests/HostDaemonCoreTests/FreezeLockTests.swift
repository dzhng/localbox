import XCTest
@testable import HostDaemonCore

/// `SandboxRuntime.freezeAndClone` and the `.freezing` lifecycle on a fake backend: the control lane, the pause around
/// the body, and everything that must wait for or pass by a freezing sandbox.
final class FreezeLockTests: XCTestCase {

    func testFreezeAndCloneRunsItsBodyFrozenAndPaused() async throws {
        let log = EventLog()
        let host = try await hostWithSandbox(log: log)
        let runtime = await host.runtime("sandbox_1")!
        let value = try await runtime.freezeAndClone { log.append("body"); return 42 }.value
        XCTAssertEqual(value, 42)
        XCTAssertEqual(lane(log), ["freeze 10000", "pause", "body", "resume", "thaw"])
        let status = await runtime.status()
        XCTAssertEqual(status.lifecycle, .ready); XCTAssertNil(status.detail)
    }

    func testRequestsWaitForAFreezingSandbox() async throws {
        let log = EventLog(), gate = BodyGate()
        let host = try await hostWithSandbox(log: log)
        let runtime = await host.runtime("sandbox_1")!
        let clone = Task { try await runtime.freezeAndClone { log.append("body"); await gate.pass() } }
        await gate.untilEntered()
        let status = try await result(host, "sandbox.status", sandboxID: "sandbox_1")
        XCTAssertEqual(status["lifecycle"] as? String, "freezing"); XCTAssertEqual(status["state"] as? String, "running", "a freezing sandbox still reads as running")
        let request = Task { try await host.request(envelope("fs.stat", #"{"path":"/"}"#)) }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(log.events.contains("request fs.stat"), "the request waits while the sandbox is frozen")
        await gate.open()
        _ = try await clone.value
        let response = try JSONSerialization.jsonObject(with: try await request.value) as? [String: Any]
        XCTAssertEqual(response?["ok"] as? Bool, true, "\(String(describing: response))")
        XCTAssertNil((response?["result"] as? [String: Any])?["actions"], "a request that waited out a freeze did not wake anything")
        XCTAssertEqual(lane(log), ["freeze 10000", "pause", "body", "resume", "thaw", "request fs.stat"])
    }

    func testIdleTickAndAdmissionPassAFreezingSandbox() async throws {
        let log = EventLog(), gate = BodyGate(), clock = Clock()
        let host = try sandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(log: log, guest: answeringGuest(log: log)), hostCPUs: 4, hostMemoryBytes: 8 * gib, now: { clock.now })
        _ = try await result(host, "sandbox.create", #"{"name":"one","image":"linux","cpus":2,"memory_bytes":4294967296,"sleep_after_ms":5000}"#, sandboxID: "sandbox_1")
        clock.now += 6
        let runtime = await host.runtime("sandbox_1")!
        let clone = Task { try await runtime.freezeAndClone { await gate.pass() } }
        await gate.untilEntered()
        let ticked = await host.idleTick()
        XCTAssertTrue(ticked.isEmpty, "the idle policy passes a freezing sandbox by")
        XCTAssertFalse(log.events.contains("request guest.activity"), "and does not ask its guest about jobs")
        let refused = try JSONSerialization.jsonObject(with: try await host.request(envelope("sandbox.create", #"{"name":"two","image":"linux","cpus":2,"memory_bytes":4294967296,"sleep_after_ms":5000}"#, sandboxID: "sandbox_2"))) as? [String: Any]
        let error = refused?["error"] as? [String: Any]
        XCTAssertEqual(error?["code"] as? String, "machine_full", "admission never sleeps a freezing sandbox for room")
        XCTAssertTrue((error?["message"] as? String)?.contains("one (4 GiB, frozen for a disk clone)") == true, "\(String(describing: error))")
        XCTAssertFalse(log.events.contains("save"))
        await gate.open()
        _ = try await clone.value
        let slept = await host.idleTick()
        XCTAssertEqual(slept["sandbox_1"]?["kind"], "slept", "once thawed it is idle like any other")
    }

    func testShutdownWaitsForTheCloneThenThawsAndSaves() async throws {
        let log = EventLog(), gate = BodyGate()
        let root = try scratch()
        let host = try sandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(log: log, guest: answeringGuest(log: log)), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await result(host, "sandbox.create", #"{"name":"one","image":"linux","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        let runtime = await host.runtime("sandbox_1")!
        let clone = Task { try await runtime.freezeAndClone { log.append("body"); await gate.pass() } }
        await gate.untilEntered()
        let shutdown = Task { await host.shutdown() }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(log.events.contains("save"), "a save never runs under a clone")
        await gate.open()
        _ = try await clone.value
        let actions = await shutdown.value
        XCTAssertEqual(actions["sandbox_1"]?["kind"], "slept")
        XCTAssertEqual(lane(log), ["freeze 10000", "pause", "body", "resume", "thaw", "save"])
        XCTAssertEqual(try SandboxDirectory(root.appendingPathComponent("sandbox_1")).load().lifecycle, .hibernated)
    }

    func testAFailedFreezeOrBodyStillThawsAndUnlocks() async throws {
        let log = EventLog()
        let host = try sandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(freezeError: .invalidState("the guest refused freeze: fsfreeze failed"), log: log, guest: answeringGuest(log: log)), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await result(host, "sandbox.create", #"{"name":"one","image":"linux","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        let runtime = await host.runtime("sandbox_1")!
        do { try await runtime.freezeAndClone { log.append("body") }; XCTFail("a refused freeze fails the clone") } catch {}
        XCTAssertEqual(lane(log), ["freeze 10000", "thaw"], "the body never runs, and the guest is told to thaw in case it froze")
        _ = try await result(host, "fs.stat", #"{"path":"/"}"#, sandboxID: "sandbox_1")

        let bodyLog = EventLog()
        let other = try await hostWithSandbox(log: bodyLog)
        let otherRuntime = await other.runtime("sandbox_1")!
        struct CloneFailed: Error {}
        do { try await otherRuntime.freezeAndClone { bodyLog.append("body"); throw CloneFailed() }; XCTFail("a failed body fails the clone") } catch is CloneFailed {}
        XCTAssertEqual(lane(bodyLog), ["freeze 10000", "pause", "body", "resume", "thaw"])
        let status = await otherRuntime.status()
        XCTAssertEqual(status.lifecycle, .ready)
    }

    func testTheProcessFixtureHasNoControlLane() async throws {
        let host = try sandboxHost(sandboxesDirectory: try scratch(), factory: ChannelOnlyFactory(), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await result(host, "sandbox.create", #"{"name":"one","image":"linux","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        let runtime = await host.runtime("sandbox_1")!
        do { try await runtime.freezeAndClone {}; XCTFail("no control lane, no freeze") } catch HostDaemonError.unsupported {}
        let status = await runtime.status()
        XCTAssertEqual(status.lifecycle, .ready)
    }

    func testFramedControlChannelSpeaksTheControlFrames() async throws {
        let toGuest = Pipe(), fromGuest = Pipe()
        let closed = EventLog()
        let channel = FramedControlChannel(reader: fromGuest.fileHandleForReading, writer: toGuest.fileHandleForWriting, onClose: { closed.append("closed") })
        func frame(_ json: String) -> Data { var size = UInt32(json.utf8.count).bigEndian; return Data(bytes: &size, count: 4) + Data(json.utf8) }
        func read() throws -> [String: Any] {
            let header = try toGuest.fileHandleForReading.read(upToCount: 4)!
            let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            return try JSONSerialization.jsonObject(with: try toGuest.fileHandleForReading.read(upToCount: Int(length))!) as! [String: Any]
        }
        let guest = Task.detached { () throws -> [[String: Any]] in
            let freeze = try read(); try fromGuest.fileHandleForWriting.write(contentsOf: frame(#"{"kind":"frozen","timeout_ms":5000}"#))
            let thaw = try read(); try fromGuest.fileHandleForWriting.write(contentsOf: frame(#"{"kind":"control_error","message":"fsfreeze -u: Invalid argument"}"#))
            return [freeze, thaw]
        }
        try await channel.freeze(timeoutMs: 5_000)
        do { try await channel.thaw(); XCTFail("a control_error answer fails the call") } catch HostDaemonError.invalidState(let message) {
            XCTAssertEqual(message, "the guest refused thaw: fsfreeze -u: Invalid argument")
        }
        let sent = try await guest.value
        XCTAssertEqual(sent[0]["kind"] as? String, "freeze"); XCTAssertEqual(sent[0]["timeout_ms"] as? Int, 5_000)
        XCTAssertEqual(sent[1]["kind"] as? String, "thaw")
        // A guest that never answers fails the exchange at its deadline instead of holding the operation lock, and the
        // lane closes, since a late answer would be read as the next frame's.
        do { _ = try await channel.exchange(["kind": "thaw"], expecting: ["thawed"], within: 0.2); XCTFail("no answer, no thaw") } catch HostDaemonError.guestUnresponsive(let message) {
            XCTAssertEqual(message, "the guest did not answer thaw on its control lane within 0 s; the lane is closed")
        }
        XCTAssertEqual(closed.events, ["closed"])
        do { try await channel.thaw(); XCTFail("a closed lane sends nothing") } catch HostDaemonError.guestUnavailable {}
        await channel.close()
        XCTAssertEqual(closed.events, ["closed"], "closed once")
    }
}

extension FreezeLockTests {
    func hostWithSandbox(log: EventLog) async throws -> SandboxHost {
        let host = try sandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(log: log, guest: answeringGuest(log: log)), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await result(host, "sandbox.create", #"{"name":"one","image":"linux","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        return host
    }

    /// The control lane and VM events, without the lane's close (it runs after the clone returns).
    func lane(_ log: EventLog) -> [String] { log.events.filter { $0 != "control closed" && $0 != "request guest.activity" } }
}

/// Holds a clone's body open until the test lets it finish.
private actor BodyGate {
    private var entered = false, opened = false
    private var enterWaiters: [CheckedContinuation<Void, Never>] = [], openWaiters: [CheckedContinuation<Void, Never>] = []
    func pass() async {
        entered = true; enterWaiters.forEach { $0.resume() }; enterWaiters = []
        if !opened { await withCheckedContinuation { openWaiters.append($0) } }
    }
    func untilEntered() async { if !entered { await withCheckedContinuation { enterWaiters.append($0) } } }
    func open() { opened = true; openWaiters.forEach { $0.resume() }; openWaiters = [] }
}

private final class Clock: @unchecked Sendable { var now = Date(timeIntervalSince1970: 1_800_000_000) }

/// A backend with a request lane and no control lane, as the process fixture is.
private struct ChannelOnlyFactory: SandboxBackendFactory {
    func provision(_ record: inout SandboxRecord, in directory: SandboxDirectory) throws -> [String: String] { [:] }
    func growDisk(_ record: SandboxRecord, in directory: SandboxDirectory) throws -> Bool { false }
    func backend(for record: SandboxRecord, in directory: SandboxDirectory) throws -> any SandboxBackend { ChannelOnlyBackend() }
}

private actor ChannelOnlyBackend: SandboxBackend, GuestChannelProvider {
    func start() {}
    func stop() {}
    func pause() {}
    func resume() {}
    func makeGuestChannel() -> any GuestChannel { FakeGuestChannel { $0 } }
}
