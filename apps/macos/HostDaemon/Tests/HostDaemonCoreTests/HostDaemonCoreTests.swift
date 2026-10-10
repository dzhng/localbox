import XCTest
@testable import HostDaemonCore

final class HostDaemonCoreTests: XCTestCase {
    func testFakeLifecycleAndGuestChannel() async throws {
        let backend = FakeVMBackend()
        let daemon = HostDaemon(backend: backend)
        try await daemon.start()
        let channel = FakeGuestChannel { data in data }
        await daemon.attach(channel: channel)
        let started = await daemon.status(); XCTAssertEqual(started.lifecycle, .ready)
        let echoed = try await daemon.request(Data("ping".utf8)); XCTAssertEqual(echoed, Data("ping".utf8))
        try await daemon.pause(); let paused = await daemon.status(); XCTAssertEqual(paused.lifecycle, .paused)
        try await daemon.resume(); let resumed = await daemon.status(); XCTAssertEqual(resumed.lifecycle, .ready)
        try await daemon.stop(); let stopped = await daemon.status(); XCTAssertEqual(stopped.lifecycle, .stopped)
    }
    func testResetRequiresConfirmation() async throws {
        let daemon = HostDaemon(backend: FakeVMBackend())
        await XCTAssertThrowsErrorAsync(try await daemon.reset(confirm: "no"))
    }
    func testAuthenticatedLocalIPCRejectsWrongTokenAndForwardsEnvelope() async throws {
        let daemon = HostDaemon(backend: FakeVMBackend())
        try await daemon.start()
        await daemon.attach(channel: FakeGuestChannel { data in data })
        let ipc = AuthenticatedLocalIPC(daemon: daemon, token: "secret")
        let envelope = Data("request".utf8)
        do { _ = try await ipc.handle(LocalIPCRequest(token: "wrong", envelope: envelope)); XCTFail("expected authentication failure") } catch { }
        let echoed = try await ipc.handle(LocalIPCRequest(token: "secret", envelope: envelope))
        XCTAssertEqual(echoed, envelope)
    }
}

private func XCTAssertThrowsErrorAsync(_ expression: @autoclosure () async throws -> Void) async {
    do { try await expression(); XCTFail("expected error") } catch {}
}
