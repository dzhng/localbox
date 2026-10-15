import XCTest
@testable import HostDaemonCore

final class HostDaemonCoreTests: XCTestCase {
    private let gib: UInt64 = 1024 * 1024 * 1024

    func testDefaultSizeIsHalfTheCoresAndAQuarterOfMemory() {
        for (cpus, memory, expected) in [(12, 24 * gib, (6, 6 * gib)), (4, 8 * gib, (2, 2 * gib)), (2, 4 * gib, (2, 2 * gib)), (10, 64 * gib, (5, 16 * gib))] {
            let size = defaultSize(hostCPUs: cpus, hostMemoryBytes: memory)
            XCTAssertEqual(size.cpus, expected.0, "\(cpus) cores"); XCTAssertEqual(size.memoryBytes, expected.1, "\(memory) bytes")
        }
    }

    func testEveryRequestNamesASandboxOnThisMac() async throws {
        let host = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(), hostCPUs: 12, hostMemoryBytes: 24 * gib)
        let unknown = try await call(host, envelope("fs.stat", #"{"path":"/"}"#))
        XCTAssertEqual((unknown["error"] as? [String: Any])?["code"] as? String, "sandbox_not_found")
        let missing = try await call(host, Data(#"{"protocol_version":"v1","request_id":"r","operation":"sandbox.status","sandbox_id":null,"deadline_ms":1000,"mutation_id":null,"input":{}}"#.utf8))
        XCTAssertEqual((missing["error"] as? [String: Any])?["code"] as? String, "invalid_input")
        let malformed = try await call(host, Data("ping".utf8))
        XCTAssertEqual((malformed["error"] as? [String: Any])?["code"] as? String, "invalid_input")
    }

    func testSandboxHostLifecycle() async throws {
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(), hostCPUs: 12, hostMemoryBytes: 24 * gib)
        let first = try await hostCall(host, "sandbox.create", #"{"name":"quiet-otter"}"#, sandboxID: "sandbox_1")
        XCTAssertEqual((first["produced"] as? [String: Any])?["cpus"] as? Int, 6)
        XCTAssertEqual((first["produced"] as? [String: Any])?["memory_bytes"] as? Int, 6 * 1024 * 1024 * 1024)
        XCTAssertEqual(kinds(first), ["created", "cold_booted"])
        let second = try await hostCall(host, "sandbox.create", #"{"name":"brave-fox","cpus":2,"memory_bytes":2147483648}"#, sandboxID: "sandbox_2")
        XCTAssertEqual(kinds(second), ["created", "cold_booted"], "each sandbox has its own runtime")
        let record = try SandboxDirectory(root.appendingPathComponent("sandbox_2")).load()
        XCTAssertEqual(record.cpus, 2); XCTAssertEqual(record.lifecycle, .running); XCTAssertNotNil(record.mac)

        // Routing: stopping one leaves the other answering.
        _ = try await hostCall(host, "sandbox.stop", "{}", sandboxID: "sandbox_1")
        let request = envelope("shell.exec", #"{"command":"true"}"#, mutation: "e1", sandboxID: "sandbox_2")
        let echoed = try await host.request(request); XCTAssertEqual(echoed, request)
        do { _ = try await host.request(envelope("shell.exec", #"{"command":"true"}"#, mutation: "e2")); XCTFail("a stopped sandbox refuses guest work") } catch {}
        let watched = try await hostCall(host, "host.watch", #"{"since":0}"#)
        XCTAssertEqual((watched["sandboxes"] as? [[String: Any]])?.map { $0["state"] as? String }, ["stopped", "running"])
        XCTAssertEqual(((watched["capacity"] as? [String: Any])?["committed"] as? [String: Any])?["cpus"] as? Int, 2, "only running sandboxes are committed")

        let renamed = try await hostCall(host, "sandbox.rename", #"{"name":"calm-heron"}"#, sandboxID: "sandbox_1")
        XCTAssertEqual((renamed["produced"] as? [String: Any])?["previous_name"] as? String, "quiet-otter")
        let deleted = try await hostCall(host, "sandbox.delete", "{}", sandboxID: "sandbox_2")
        XCTAssertEqual((deleted["produced"] as? [String: Any])?["removed"] as? [String], ["sandbox identity"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_2").path), "delete removes the directory")

        let reloaded = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory())
        let records = await reloaded.sandboxes()
        XCTAssertEqual(records.map(\.name), ["calm-heron"]); XCTAssertEqual(records.first?.lifecycle, .stopped)
        let listed = try await hostCall(reloaded, "sandbox.list", "{}", sandboxID: nil)
        XCTAssertEqual((listed["sandboxes"] as? [[String: Any]])?.first?["name"] as? String, "calm-heron")
    }

    func testTheMirrorFollowsNamesAndNeverDeletesADisk() async throws {
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one","cpus":3,"memory_bytes":3221225472}"#, sandboxID: "sandbox_1")
        _ = try await hostCall(host, "sandbox.create", #"{"name":"two"}"#, sandboxID: "sandbox_2")
        let version = try await hostCall(host, "host.watch", #"{"since":0}"#)["version"] as! Int
        let pushed = try await hostCall(host, "sandbox.mirror", #"{"sandboxes":[{"sandbox_id":"sandbox_1","name":"renamed","cpus":2,"memory_bytes":2147483648},{"sandbox_id":"sandbox_9","name":"elsewhere"}]}"#)
        XCTAssertEqual(pushed["unknown"] as? [String], ["sandbox_2"]); XCTAssertEqual(pushed["missing"] as? [String], ["sandbox_9"])
        let records = await host.sandboxes()
        XCTAssertEqual(records.map(\.name), ["renamed"]); XCTAssertEqual(records.first?.cpus, 3, "the daemon keeps the size it runs a sandbox at")
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_2/sandbox.json").path), "a push never deletes a sandbox")
        let hidden = try await call(host, envelope("shell.exec", #"{"command":"true"}"#, mutation: "h", sandboxID: "sandbox_2"))
        XCTAssertEqual((hidden["error"] as? [String: Any])?["code"] as? String, "sandbox_not_found", "a sandbox the catalog no longer lists does not answer")
        let watched = try await hostCall(host, "host.watch", #"{"since":\#(version),"timeout_ms":50}"#)
        XCTAssertGreaterThan(watched["version"] as? Int ?? 0, version, "a mirror push bumps the watch version")
        XCTAssertEqual((watched["sandboxes"] as? [[String: Any]])?.compactMap { $0["sandbox_id"] as? String }, ["sandbox_1"])
    }

    func testResizeReportsRestart() async throws {
        let ps = #"{"ok":true,"result":{"stdout":"40\n1 0 /sbin/init\n2 0 [kthreadd]\n90 1 /usr/bin/socat VSOCK-LISTEN:1024 EXEC:node guest-agent\n120 1 node server.js\n121 120 /usr/bin/python3 -m http.server\n41 40 ps -eo pid=,ppid=,args=\n"}}"#
        let factory = FakeBackendFactory { request in
            let operation = (try JSONSerialization.jsonObject(with: request) as? [String: Any])?["operation"] as? String
            return operation == "shell.exec" ? Data(ps.utf8) : request
        }
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: factory, hostCPUs: 12, hostMemoryBytes: 24 * gib)
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one","cpus":2,"memory_bytes":2147483648}"#, sandboxID: "sandbox_1")
        let resized = try await hostCall(host, "sandbox.resize", #"{"cpus":3}"#, sandboxID: "sandbox_1")
        let action = (resized["actions"] as? [[String: Any]])?.first
        XCTAssertEqual(action?["kind"] as? String, "restarted")
        XCTAssertEqual(action?["detail"] as? String, "restarted one at 3 CPUs and 2 GiB; 3 processes ended: init, node, python3")
        XCTAssertEqual((resized["produced"] as? [String: Any])?["cpus"] as? Int, 3); XCTAssertEqual((resized["produced"] as? [String: Any])?["state"] as? String, "running")
        XCTAssertEqual(factory.boots, 2, "the new size needs a new boot")
        _ = try await hostCall(host, "sandbox.stop", "{}", sandboxID: "sandbox_1")
        let stopped = try await hostCall(host, "sandbox.resize", #"{"memory_bytes":4294967296}"#, sandboxID: "sandbox_1")
        XCTAssertEqual((stopped["actions"] as? [[String: Any]])?.count, 0, "a stopped sandbox only records the size")
        XCTAssertEqual(try SandboxDirectory(root.appendingPathComponent("sandbox_1")).load().memoryBytes, 4 * gib)
    }

    func testSigtermHibernates() async throws {
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one"}"#, sandboxID: "sandbox_1")
        _ = try await hostCall(host, "sandbox.create", #"{"name":"two"}"#, sandboxID: "sandbox_2")
        _ = try await hostCall(host, "sandbox.stop", "{}", sandboxID: "sandbox_2")
        await host.shutdown()
        let saved = try SandboxDirectory(root.appendingPathComponent("sandbox_1")).load()
        XCTAssertEqual(saved.lifecycle, .hibernated); XCTAssertNil(saved.coldBootPending)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_1/state.vzsave").path))

        let restarted = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory())
        let actions = await restarted.recover()
        XCTAssertEqual(actions["sandbox_1"]?["kind"], "woke"); XCTAssertNil(actions["sandbox_2"], "a sandbox stopped on purpose stays down")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_1/state.vzsave").path), "a restored state is spent")
        let status = try await hostCall(restarted, "sandbox.status", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(status["state"] as? String, "running"); XCTAssertEqual((status["last_boot"] as? [String: Any])?["kind"] as? String, "woke")
    }

    func testSigtermColdBootsWhenSaveFails() async throws {
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(saveError: "permission denied"), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one"}"#, sandboxID: "sandbox_1")
        await host.shutdown()
        let record = try SandboxDirectory(root.appendingPathComponent("sandbox_1")).load()
        XCTAssertEqual(record.lifecycle, .stopped)
        XCTAssertEqual(record.coldBootPending, "could not save its state: permission denied")
        let actions = await SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory()).recover()
        XCTAssertEqual(actions["sandbox_1"], ["kind": "cold_booted", "detail": "cold-booted one: could not save its state: permission denied"])
        XCTAssertNil(try SandboxDirectory(root.appendingPathComponent("sandbox_1")).load().coldBootPending, "the debt is paid")
    }

    func testSleepAndStartReportWhatTheyDid() async throws {
        let host = try await hostWithSandbox()
        let slept = try await hostCall(host, "sandbox.sleep", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(kinds(slept), ["slept"])
        let woke = try await hostCall(host, "sandbox.start", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(kinds(woke), ["woke"])
        XCTAssertEqual((woke["produced"] as? [String: Any])?["state"] as? String, "running")
    }

    func testAuthenticatedLocalIPCRejectsWrongTokenAndForwardsEnvelope() async throws {
        let host = try await hostWithSandbox()
        let ipc = AuthenticatedLocalIPC(host: host, token: "secret")
        let request = envelope("shell.exec", #"{"command":"true"}"#, mutation: "e1")
        do { _ = try await ipc.handle(LocalIPCRequest(token: "wrong", envelope: request)); XCTFail("expected authentication failure") } catch { }
        let echoed = try await ipc.handle(LocalIPCRequest(token: "secret", envelope: request))
        XCTAssertEqual(echoed, request)
    }

    func testHostWatchAnswersImmediatelyWhenTheCallerIsBehind() async throws {
        let host = try await hostWithSandbox()
        let started = Date()
        let watched = try await hostCall(host, "host.watch", #"{"since":0,"timeout_ms":5000}"#)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        XCTAssertGreaterThan(watched["version"] as? Int ?? 0, 0)
        XCTAssertEqual(((watched["capacity"] as? [String: Any])?["cpus"] as? Int), 4)
    }

    func testHostWatchWaitsForALifecycleChangeOrTheTimeout() async throws {
        let host = try await hostWithSandbox()
        try await Task.sleep(nanoseconds: 50_000_000)
        let version = try await hostCall(host, "host.watch", #"{"since":0}"#)["version"] as! Int
        let timedOut = try await hostCall(host, "host.watch", #"{"since":\#(version),"timeout_ms":50}"#)
        XCTAssertEqual(timedOut["version"] as? Int, version)
        let waiter = Task { try await hostCall(host, "host.watch", #"{"since":\#(version),"timeout_ms":5000}"#) }
        try await Task.sleep(nanoseconds: 100_000_000)
        _ = try await hostCall(host, "sandbox.sleep", "{}", sandboxID: "sandbox_1")
        let changed = try await waiter.value
        XCTAssertGreaterThan(changed["version"] as? Int ?? 0, version)
        XCTAssertEqual((changed["sandboxes"] as? [[String: Any]])?.first?["state"] as? String, "sleeping")
    }

    func testRelayStatusAnswersFromTheConnectorReport() async throws {
        let clock = TestClock()
        let host = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(), now: { clock.now })
        let none = try await hostCall(host, "relay.status", "{}")
        XCTAssertEqual(none["connector"] as? String, "not_running"); XCTAssertEqual(none["connected"] as? Bool, false)
        _ = try await hostCall(host, "connector.report", #"{"state":"connected"}"#)
        let connected = try await hostCall(host, "relay.status", "{}")
        XCTAssertEqual(connected["connector"] as? String, "connected"); XCTAssertEqual(connected["connected"] as? Bool, true)
        XCTAssertNotNil(connected["reported_at"] as? String)
        clock.now = clock.now.addingTimeInterval(121)
        let stale = try await hostCall(host, "relay.status", "{}")
        XCTAssertEqual(stale["connector"] as? String, "not_running"); XCTAssertEqual(stale["connected"] as? Bool, false)
    }

    func testFramedGuestChannelSpeaksTheGuestFrameProtocol() async throws {
        let toGuest = Pipe(); let fromGuest = Pipe()
        let channel = FramedFileHandleGuestChannel(reader: fromGuest.fileHandleForReading, writer: toGuest.fileHandleForWriting, sandboxID: "sandbox_1", name: "quiet-otter")
        func frame(_ value: Data) -> Data { var size = UInt32(value.count).bigEndian; return Data(bytes: &size, count: 4) + value }
        func read() throws -> [String: Any] {
            let header = try toGuest.fileHandleForReading.read(upToCount: 4)!
            let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            return try JSONSerialization.jsonObject(with: try toGuest.fileHandleForReading.read(upToCount: Int(length))!) as! [String: Any]
        }
        try fromGuest.fileHandleForWriting.write(contentsOf: frame(Data(#"{"kind":"ready","channel_epoch":7}"#.utf8)))
        try await channel.waitUntilReady()
        let hello = try read()
        XCTAssertEqual(hello["kind"] as? String, "hello")
        XCTAssertEqual(hello["channel_epoch"] as? Int, 8, "hello moves the guest one epoch past the one it reported")
        XCTAssertEqual(hello["sandbox_id"] as? String, "sandbox_1"); XCTAssertEqual(hello["hostname"] as? String, "quiet-otter")
        XCTAssertNotNil(hello["wall_clock_ms"] as? Int)
        let guest = Task.detached { () throws -> [String: Any] in
            let sent = try read()
            try fromGuest.fileHandleForWriting.write(contentsOf: frame(Data(#"{"kind":"response","channel_epoch":8,"response":{"ok":true}}"#.utf8)))
            return sent
        }
        let response = try await channel.send(Data(#"{"request_id":"r1"}"#.utf8))
        XCTAssertEqual(String(data: response, encoding: .utf8), #"{"ok":true}"#)
        let sent = try await guest.value
        XCTAssertEqual(sent["kind"] as? String, "request")
        XCTAssertEqual(sent["channel_epoch"] as? Int, 8, "requests carry the epoch the host moved to, one past the guest's")
        XCTAssertEqual((sent["request"] as? [String: Any])?["request_id"] as? String, "r1")
        try await channel.rename(to: "calm-heron")
        let renamed = try read()
        XCTAssertEqual(renamed["channel_epoch"] as? Int, 9, "a rename is a hello under the next epoch"); XCTAssertEqual(renamed["hostname"] as? String, "calm-heron")
        await channel.close()
    }
}

extension HostDaemonCoreTests {
    private static let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../..").standardizedFileURL
    private static let fixture = ProcessFixtureConfiguration(guestCommand: ["/usr/bin/env", "node", "--import", "tsx", repoRoot.appendingPathComponent("apps/guest-agent/src/index.ts").path], workingDirectory: repoRoot)

    func testProcessFixtureSandboxesEachRunTheirOwnGuest() async throws {
        let root = try scratch()
        let factory = try ProcessFixtureFactory(configuration: Self.fixture, environment: ["LOCALBOX_VM_BACKEND": "process-fixture"])
        let host = SandboxHost(sandboxesDirectory: root, factory: factory, hostCPUs: 4, hostMemoryBytes: 8 * gib)
        for id in ["sandbox_1", "sandbox_2"] {
            let created = try await hostCall(host, "sandbox.create", #"{"name":"\#(id)"}"#, sandboxID: id)
            XCTAssertEqual(kinds(created), ["created", "cold_booted"])
        }
        let wrote = try await call(host, envelope("fs.write", #"{"path":"/hello.txt","content":"fixture"}"#, mutation: "w1"))
        XCTAssertEqual(wrote["ok"] as? Bool, true, "\(wrote)")
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("sandbox_1/root/hello.txt"), encoding: .utf8), "fixture", "the guest root is <sandbox>/root")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_2/root/hello.txt").path), "each sandbox has its own root")

        let echoed = try await call(host, envelope("shell.exec", #"{"command":"echo","args":["round trip"],"cwd":"/","env":{}}"#, mutation: "e1", sandboxID: "sandbox_2"))
        XCTAssertEqual(((echoed["result"] as? [String: Any])?["stdout"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), "round trip", "\(echoed)")

        _ = try await hostCall(host, "sandbox.sleep", "{}", sandboxID: "sandbox_1")
        _ = try await hostCall(host, "sandbox.start", "{}", sandboxID: "sandbox_1")
        let resumed = try await call(host, envelope("fs.read", #"{"path":"/hello.txt"}"#))
        XCTAssertEqual((resumed["result"] as? [String: Any])?["content"] as? String, "fixture", "SIGCONT resumes the same guest process")

        await host.shutdown()
        XCTAssertEqual(try SandboxDirectory(root.appendingPathComponent("sandbox_1")).load().coldBootPending, "fixture: the process fixture cannot save its state")
    }

    func testFixtureBackendRefusedWithoutOptIn() throws {
        XCTAssertThrowsError(try ProcessFixtureFactory(configuration: Self.fixture, environment: [:]))
        XCTAssertThrowsError(try ProcessFixtureFactory(configuration: Self.fixture, environment: ["LOCALBOX_VM_BACKEND": "apple"]))
        XCTAssertNoThrow(try ProcessFixtureFactory(configuration: Self.fixture, environment: ["LOCALBOX_VM_BACKEND": "process-fixture"]))
    }

    /// A fresh sandboxes directory, removed after the test.
    func scratch() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lb-sandboxes-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    /// A host holding a running `sandbox_1` whose guest answers each envelope with itself.
    func hostWithSandbox() async throws -> SandboxHost {
        let host = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one"}"#, sandboxID: "sandbox_1")
        return host
    }
}

private final class TestClock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
}

private func envelope(_ operation: String, _ input: String, mutation: String? = nil, sandboxID: String? = "sandbox_1") -> Data {
    Data(#"{"protocol_version":"v1","request_id":"\#(operation)-1","operation":"\#(operation)","sandbox_id":\#(sandboxID.map { "\"\($0)\"" } ?? "null"),"deadline_ms":60000,"mutation_id":\#(mutation.map { "\"\($0)\"" } ?? "null"),"input":\#(input)}"#.utf8)
}

private func call(_ host: SandboxHost, _ request: Data) async throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: try await host.request(request)) as! [String: Any]
}

private func hostCall(_ host: SandboxHost, _ operation: String, _ input: String, sandboxID: String? = nil) async throws -> [String: Any] {
    let response = try await call(host, envelope(operation, input, sandboxID: sandboxID))
    XCTAssertEqual(response["ok"] as? Bool, true, "\(operation): \(response)")
    return response["result"] as? [String: Any] ?? [:]
}

private func kinds(_ report: [String: Any]) -> [String] { (report["actions"] as? [[String: Any]])?.compactMap { $0["kind"] as? String } ?? [] }

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

private func localSocketPath() -> String {
    "/tmp/ac-\(UUID().uuidString).sock"
}

private func socketType() -> Int32 {
    #if canImport(Darwin)
    return SOCK_STREAM
    #else
    return Int32(SOCK_STREAM.rawValue)
    #endif
}

private func connectLocalSocket(_ path: String) throws -> Int32 {
    let fd = socket(AF_UNIX, socketType(), 0)
    guard fd >= 0 else { throw POSIXTestError.systemCall("socket", errno) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        destination.copyBytes(from: [UInt8](repeating: 0, count: destination.count))
        destination.copyBytes(from: bytes)
    }
    let length = socklen_t(MemoryLayout<sa_family_t>.size + bytes.count + 1)
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            #if canImport(Darwin)
            Darwin.connect(fd, $0, length)
            #else
            Glibc.connect(fd, $0, length)
            #endif
        }
    }
    guard result == 0 else { close(fd); throw POSIXTestError.systemCall("connect", errno) }
    return fd
}

private enum POSIXTestError: Error { case systemCall(String, Int32) }

private func readExactly(_ count: Int, from handle: FileHandle) throws -> Data {
    var data = Data(); data.reserveCapacity(count)
    while data.count < count {
        guard let chunk = try handle.read(upToCount: count - data.count), !chunk.isEmpty else { throw POSIXTestError.systemCall("read", 0) }
        data.append(chunk)
    }
    return data
}

private func sendSocketFrame(_ body: Data, to handle: FileHandle) throws {
    var length = UInt32(body.count).bigEndian
    try handle.write(contentsOf: Data(bytes: &length, count: 4))
    try handle.write(contentsOf: body)
}

private func receiveSocketFrame(from handle: FileHandle) throws -> Data {
    let header = try readExactly(4, from: handle)
    let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    return try readExactly(Int(length), from: handle)
}

extension HostDaemonCoreTests {
    func testUnixDomainSocketForwardsAuthenticatedRequest() async throws {
        let host = try await hostWithSandbox()
        let path = localSocketPath()
        let endpoint = LocalIPCEndpoint(socketPath: path)
        let ipc = AuthenticatedLocalIPC(host: host, token: "socket-secret", endpoint: endpoint)
        let server = UnixDomainSocketServer(ipc: ipc, endpoint: endpoint)
        try await server.start()
        defer { Task { await server.stop() } }

        let fd = try connectLocalSocket(path)
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        let sent = envelope("shell.exec", #"{"command":"true"}"#, mutation: "e1")
        let request = LocalIPCRequest(token: "socket-secret", envelope: sent)
        try sendSocketFrame(try JSONEncoder().encode(request), to: handle)
        let response = try JSONDecoder().decode(LocalIPCResponse.self, from: receiveSocketFrame(from: handle))
        XCTAssertEqual(response.envelope, sent)
        XCTAssertNil(response.error)
        try handle.close()
        await server.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testUnixDomainSocketReturnsUnauthorizedAndMalformedResponses() async throws {
        let host = try await hostWithSandbox()
        let path = localSocketPath()
        let endpoint = LocalIPCEndpoint(socketPath: path)
        let ipc = AuthenticatedLocalIPC(host: host, token: "socket-secret", endpoint: endpoint)
        let server = UnixDomainSocketServer(ipc: ipc, endpoint: endpoint)
        try await server.start()
        defer { Task { await server.stop() } }

        do {
            let fd = try connectLocalSocket(path)
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            let request = LocalIPCRequest(token: "wrong", envelope: Data("ping".utf8))
            try sendSocketFrame(try JSONEncoder().encode(request), to: handle)
            let response = try JSONDecoder().decode(LocalIPCResponse.self, from: receiveSocketFrame(from: handle))
            XCTAssertEqual(response.error, "unauthorized")
            try handle.close()
        }
        do {
            let fd = try connectLocalSocket(path)
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            try sendSocketFrame(Data("not-json".utf8), to: handle)
            let response = try JSONDecoder().decode(LocalIPCResponse.self, from: receiveSocketFrame(from: handle))
            XCTAssertEqual(response.error, "malformed")
            try handle.close()
        }
        await server.stop()
    }
}

extension HostDaemonCoreTests {
    func testUnixDomainSocketRejectsOversizedFrame() async throws {
        let host = try await hostWithSandbox()
        let path = localSocketPath()
        let endpoint = LocalIPCEndpoint(socketPath: path)
        let ipc = AuthenticatedLocalIPC(host: host, token: "socket-secret", endpoint: endpoint)
        let server = UnixDomainSocketServer(ipc: ipc, endpoint: endpoint, maxFrameBytes: 16)
        try await server.start()
        defer { Task { await server.stop() } }

        let fd = try connectLocalSocket(path)
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var length = UInt32(17).bigEndian
        try handle.write(contentsOf: Data(bytes: &length, count: 4))
        try handle.write(contentsOf: Data(repeating: 0x41, count: 17))
        let response = try JSONDecoder().decode(LocalIPCResponse.self, from: receiveSocketFrame(from: handle))
        XCTAssertEqual(response.error, "frame_too_large")
        try handle.close()
        await server.stop()
    }
}
