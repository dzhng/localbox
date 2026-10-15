import XCTest
@testable import HostDaemonCore

final class HostDaemonCoreTests: XCTestCase {
    func testFakeLifecycleAndGuestChannel() async throws {
        let daemon = try await daemonWithSandbox(echo: true)
        let started = await daemon.status(); XCTAssertEqual(started.lifecycle, .ready)
        let request = envelope("shell.exec", #"{"command":"true"}"#, mutation: "e1")
        let echoed = try await daemon.request(request); XCTAssertEqual(echoed, request)
        try await daemon.pause(); let paused = await daemon.status(); XCTAssertEqual(paused.lifecycle, .paused)
        try await daemon.resume(); let resumed = await daemon.status(); XCTAssertEqual(resumed.lifecycle, .ready)
        try await daemon.stop(); let stopped = await daemon.status(); XCTAssertEqual(stopped.lifecycle, .stopped)
    }

    func testDefaultSizeIsHalfTheCoresAndAQuarterOfMemory() {
        let gib: UInt64 = 1024 * 1024 * 1024
        for (cpus, memory, expected) in [(12, 24 * gib, (6, 6 * gib)), (4, 8 * gib, (2, 2 * gib)), (2, 4 * gib, (2, 2 * gib)), (10, 64 * gib, (5, 16 * gib))] {
            let size = defaultSize(hostCPUs: cpus, hostMemoryBytes: memory)
            XCTAssertEqual(size.cpus, expected.0, "\(cpus) cores"); XCTAssertEqual(size.memoryBytes, expected.1, "\(memory) bytes")
        }
    }

    func testEveryRequestNamesASandboxInTheMirror() async throws {
        let daemon = HostDaemon(backend: FakeVMBackend(), hostCPUs: 12, hostMemoryBytes: 24 * 1024 * 1024 * 1024)
        let unknown = try await call(daemon, envelope("fs.stat", #"{"path":"/"}"#))
        XCTAssertEqual((unknown["error"] as? [String: Any])?["code"] as? String, "sandbox_not_found")
        let missing = try await call(daemon, Data(#"{"protocol_version":"v1","request_id":"r","operation":"sandbox.status","sandbox_id":null,"deadline_ms":1000,"mutation_id":null,"input":{}}"#.utf8))
        XCTAssertEqual((missing["error"] as? [String: Any])?["code"] as? String, "invalid_input")
        let malformed = try await call(daemon, Data("ping".utf8))
        XCTAssertEqual((malformed["error"] as? [String: Any])?["code"] as? String, "invalid_input")
    }

    func testCreateColdBootsReportsSizeAndTheMirrorPersists() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mirror-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("sandboxes.json")
        let daemon = HostDaemon(backend: FakeVMBackend(), mirrorFile: file, hostCPUs: 12, hostMemoryBytes: 24 * 1024 * 1024 * 1024)
        let created = try await hostCall(daemon, "sandbox.create", #"{"name":"quiet-otter"}"#, sandboxID: "sandbox_1")
        XCTAssertEqual((created["produced"] as? [String: Any])?["cpus"] as? Int, 6)
        XCTAssertEqual((created["produced"] as? [String: Any])?["memory_bytes"] as? Int, 6 * 1024 * 1024 * 1024)
        XCTAssertEqual((created["actions"] as? [[String: Any]])?.compactMap { $0["kind"] as? String }, ["created", "cold_booted"])
        let second = try await hostCall(daemon, "sandbox.create", #"{"name":"brave-fox","cpus":2,"memory_bytes":2147483648}"#, sandboxID: "sandbox_2")
        XCTAssertEqual((second["actions"] as? [[String: Any]])?.compactMap { $0["kind"] as? String }, ["created"], "the runtime is already up")
        let renamed = try await hostCall(daemon, "sandbox.rename", #"{"name":"calm-heron"}"#, sandboxID: "sandbox_1")
        XCTAssertEqual((renamed["produced"] as? [String: Any])?["previous_name"] as? String, "quiet-otter")
        let deleted = try await hostCall(daemon, "sandbox.delete", "{}", sandboxID: "sandbox_2")
        XCTAssertEqual((deleted["produced"] as? [String: Any])?["removed"] as? [String], ["sandbox identity"])
        let reloaded = HostDaemon(backend: FakeVMBackend(), mirrorFile: file)
        let identities = await reloaded.sandboxes()
        XCTAssertEqual(identities, [SandboxIdentity(sandboxID: "sandbox_1", name: "calm-heron", cpus: 6, memoryBytes: 6 * 1024 * 1024 * 1024)])
        let listed = try await hostCall(reloaded, "sandbox.list", "{}", sandboxID: nil)
        XCTAssertEqual((listed["sandboxes"] as? [[String: Any]])?.first?["name"] as? String, "calm-heron")
    }

    func testTheMirrorFollowsTheCatalogButKeepsTheSizeItRuns() async throws {
        let daemon = HostDaemon(backend: FakeVMBackend(), hostCPUs: 4, hostMemoryBytes: 8 * 1024 * 1024 * 1024)
        _ = try await hostCall(daemon, "sandbox.create", #"{"name":"one","cpus":3,"memory_bytes":3221225472}"#, sandboxID: "sandbox_1")
        let version = try await hostCall(daemon, "host.watch", #"{"since":0}"#)["version"] as! Int
        _ = try await hostCall(daemon, "sandbox.mirror", #"{"sandboxes":[{"sandbox_id":"sandbox_1","name":"renamed","cpus":2,"memory_bytes":2147483648},{"sandbox_id":"sandbox_9","name":"new","cpus":2,"memory_bytes":2147483648}]}"#)
        let identities = await daemon.sandboxes()
        XCTAssertEqual(identities.map(\.name), ["renamed", "new"])
        XCTAssertEqual(identities.first?.cpus, 3, "the daemon keeps the size it runs a sandbox at")
        let watched = try await hostCall(daemon, "host.watch", #"{"since":\#(version),"timeout_ms":50}"#)
        XCTAssertGreaterThan(watched["version"] as? Int ?? 0, version, "a mirror change bumps the watch version")
        XCTAssertEqual((watched["sandboxes"] as? [[String: Any]])?.map { $0["state"] as? String }, ["running", "running"])
    }

    func testSleepAndStartReportWhatTheyDid() async throws {
        let daemon = try await daemonWithSandbox(echo: true)
        let slept = try await hostCall(daemon, "sandbox.sleep", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual((slept["actions"] as? [[String: Any]])?.first?["kind"] as? String, "slept")
        let woke = try await hostCall(daemon, "sandbox.start", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual((woke["actions"] as? [[String: Any]])?.first?["kind"] as? String, "woke")
        XCTAssertEqual((woke["produced"] as? [String: Any])?["state"] as? String, "running")
    }

    #if os(macOS)
    func testAppleResetRestoresTemplateDisk() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("host-reset-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let template = directory.appendingPathComponent("template.img")
        let disk = directory.appendingPathComponent("disk.img")
        try Data("clean-state".utf8).write(to: template)
        try Data("mutated-state".utf8).write(to: disk)
        let backend = AppleVirtualizationBackend(image: AppleVMConfiguration(kernelURL: directory.appendingPathComponent("kernel"), initialRamdiskURL: directory.appendingPathComponent("initrd"), diskURL: disk, templateDiskURL: template))
        try await backend.reset()
        XCTAssertEqual(try Data(contentsOf: disk), Data("clean-state".utf8))
    }
    #endif

    func testAuthenticatedLocalIPCRejectsWrongTokenAndForwardsEnvelope() async throws {
        let daemon = try await daemonWithSandbox(echo: true)
        let ipc = AuthenticatedLocalIPC(daemon: daemon, token: "secret")
        let request = envelope("shell.exec", #"{"command":"true"}"#, mutation: "e1")
        do { _ = try await ipc.handle(LocalIPCRequest(token: "wrong", envelope: request)); XCTFail("expected authentication failure") } catch { }
        let echoed = try await ipc.handle(LocalIPCRequest(token: "secret", envelope: request))
        XCTAssertEqual(echoed, request)
    }

    func testRequestRoutesHostLifecycleOperationsBeforeGuestChannel() async throws {
        let daemon = try await daemonWithSandbox(echo: true)
        let status = try await hostCall(daemon, "sandbox.status", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(status["state"] as? String, "running")
        _ = try await hostCall(daemon, "sandbox.stop", "{}", sandboxID: "sandbox_1")
        let stoppedStatus = await daemon.status()
        XCTAssertEqual(stoppedStatus.lifecycle, .stopped)
        do { _ = try await daemon.request(envelope("shell.exec", #"{"command":"true"}"#, mutation: "guest-1")); XCTFail("stopped runtime should reject guest work") } catch { }
    }

    func testHostWatchAnswersImmediatelyWhenTheCallerIsBehind() async throws {
        let daemon = HostDaemon(backend: FakeVMBackend())
        try await daemon.start()
        let started = Date()
        let watched = try await hostCall(daemon, "host.watch", #"{"since":0,"timeout_ms":5000}"#)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        XCTAssertEqual(watched["lifecycle"] as? String, "ready")
        XCTAssertGreaterThan(watched["version"] as? Int ?? 0, 0)
        XCTAssertGreaterThan(((watched["capacity"] as? [String: Any])?["cpus"] as? Int) ?? 0, 0)
    }

    func testHostWatchWaitsForALifecycleChangeOrTheTimeout() async throws {
        let daemon = HostDaemon(backend: FakeVMBackend())
        try await daemon.start()
        let version = try await hostCall(daemon, "host.watch", #"{"since":0}"#)["version"] as! Int
        let timedOut = try await hostCall(daemon, "host.watch", #"{"since":\#(version),"timeout_ms":50}"#)
        XCTAssertEqual(timedOut["version"] as? Int, version)
        let waiter = Task { try await hostCall(daemon, "host.watch", #"{"since":\#(version),"timeout_ms":5000}"#) }
        try await Task.sleep(nanoseconds: 100_000_000)
        try await daemon.pause()
        let changed = try await waiter.value
        XCTAssertGreaterThan(changed["version"] as? Int ?? 0, version)
        XCTAssertEqual(changed["lifecycle"] as? String, "paused")
    }

    func testRelayStatusAnswersFromTheConnectorReport() async throws {
        let clock = TestClock()
        let daemon = HostDaemon(backend: FakeVMBackend(), now: { clock.now })
        _ = try await hostCall(daemon, "sandbox.mirror", #"{"sandboxes":[{"sandbox_id":"sandbox_1","name":"one","cpus":2,"memory_bytes":2147483648}]}"#)
        let none = try await hostCall(daemon, "relay.status", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(none["connector"] as? String, "not_running"); XCTAssertEqual(none["connected"] as? Bool, false)
        _ = try await hostCall(daemon, "connector.report", #"{"state":"connected"}"#)
        let connected = try await hostCall(daemon, "relay.status", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(connected["connector"] as? String, "connected"); XCTAssertEqual(connected["connected"] as? Bool, true)
        XCTAssertNotNil(connected["reported_at"] as? String)
        clock.now = clock.now.addingTimeInterval(121)
        let stale = try await hostCall(daemon, "relay.status", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(stale["connector"] as? String, "not_running"); XCTAssertEqual(stale["connected"] as? Bool, false)
    }

    func testFramedGuestChannelSpeaksTheGuestFrameProtocol() async throws {
        let toGuest = Pipe(); let fromGuest = Pipe()
        let channel = FramedFileHandleGuestChannel(reader: fromGuest.fileHandleForReading, writer: toGuest.fileHandleForWriting)
        func frame(_ value: Data) -> Data { var size = UInt32(value.count).bigEndian; return Data(bytes: &size, count: 4) + value }
        try fromGuest.fileHandleForWriting.write(contentsOf: frame(Data(#"{"kind":"ready","channel_epoch":7}"#.utf8)))
        try await channel.waitUntilReady()
        let guest = Task.detached { () throws -> (hello: [String: Any], sent: [String: Any]) in
            func read() throws -> [String: Any] {
                let header = try toGuest.fileHandleForReading.read(upToCount: 4)!
                let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
                return try JSONSerialization.jsonObject(with: try toGuest.fileHandleForReading.read(upToCount: Int(length))!) as! [String: Any]
            }
            let hello = try read(); let sent = try read()
            try fromGuest.fileHandleForWriting.write(contentsOf: frame(Data(#"{"kind":"response","channel_epoch":8,"response":{"ok":true}}"#.utf8)))
            return (hello, sent)
        }
        let response = try await channel.send(Data(#"{"request_id":"r1"}"#.utf8))
        XCTAssertEqual(String(data: response, encoding: .utf8), #"{"ok":true}"#)
        let (hello, sent) = try await guest.value
        XCTAssertEqual(hello["kind"] as? String, "hello")
        XCTAssertEqual(hello["channel_epoch"] as? Int, 8, "hello moves the guest one epoch past the one it reported")
        XCTAssertNotNil(hello["wall_clock_ms"] as? Int)
        XCTAssertEqual(sent["kind"] as? String, "request")
        XCTAssertEqual(sent["channel_epoch"] as? Int, 8, "requests carry the epoch the host moved to, one past the guest's")
        XCTAssertEqual((sent["request"] as? [String: Any])?["request_id"] as? String, "r1")
        await channel.close()
    }
}

extension HostDaemonCoreTests {
    private static let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../..").standardizedFileURL

    private func fixtureConfiguration(_ sandbox: URL) -> ProcessFixtureConfiguration {
        ProcessFixtureConfiguration(sandboxDirectory: sandbox, guestCommand: ["/usr/bin/env", "node", "--import", "tsx", Self.repoRoot.appendingPathComponent("apps/guest-agent/src/index.ts").path], workingDirectory: Self.repoRoot)
    }


    func testProcessFixtureBackendRoundTrip() async throws {
        let sandbox = FileManager.default.temporaryDirectory.appendingPathComponent("lb-fixture-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let backend = try ProcessFixtureBackend(configuration: fixtureConfiguration(sandbox), environment: ["LOCALBOX_VM_BACKEND": "process-fixture"])
        let daemon = HostDaemon(backend: backend)
        let created = try await hostCall(daemon, "sandbox.create", #"{"name":"fixture"}"#, sandboxID: "sandbox_1")
        XCTAssertEqual((created["actions"] as? [[String: Any]])?.last?["kind"] as? String, "cold_booted")
        let ready = await daemon.status()
        XCTAssertEqual(ready.lifecycle, .ready)

        let wrote = try JSONSerialization.jsonObject(with: try await daemon.request(envelope("fs.write", #"{"path":"/hello.txt","content":"fixture"}"#, mutation: "w1"))) as! [String: Any]
        XCTAssertEqual(wrote["ok"] as? Bool, true, "\(wrote)")
        XCTAssertEqual(try String(contentsOf: sandbox.appendingPathComponent("root/hello.txt"), encoding: .utf8), "fixture", "the guest root is <sandbox>/root")

        let echoed = try JSONSerialization.jsonObject(with: try await daemon.request(envelope("shell.exec", #"{"command":"echo","args":["round trip"],"cwd":"/","env":{}}"#, mutation: "e1"))) as! [String: Any]
        XCTAssertEqual(echoed["ok"] as? Bool, true, "\(echoed)")
        XCTAssertEqual(((echoed["result"] as? [String: Any])?["stdout"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), "round trip")

        try await daemon.pause()
        let paused = await daemon.status()
        XCTAssertEqual(paused.lifecycle, .paused)
        try await daemon.resume()
        let resumed = try JSONSerialization.jsonObject(with: try await daemon.request(envelope("fs.read", #"{"path":"/hello.txt"}"#))) as! [String: Any]
        XCTAssertEqual((resumed["result"] as? [String: Any])?["content"] as? String, "fixture", "SIGCONT resumes the same guest process")

        let pid = await backend.pid
        try await daemon.stop()
        XCTAssertNotNil(pid)
        if let pid { XCTAssertEqual(kill(pid, 0), -1, "stop ends the guest process") }
    }

    func testFixtureBackendRefusedWithoutOptIn() throws {
        let configuration = fixtureConfiguration(FileManager.default.temporaryDirectory)
        XCTAssertThrowsError(try ProcessFixtureBackend(configuration: configuration, environment: [:]))
        XCTAssertThrowsError(try ProcessFixtureBackend(configuration: configuration, environment: ["LOCALBOX_VM_BACKEND": "apple"]))
        XCTAssertNoThrow(try ProcessFixtureBackend(configuration: configuration, environment: ["LOCALBOX_VM_BACKEND": "process-fixture"]))
    }
}

private final class TestClock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
}

private func envelope(_ operation: String, _ input: String, mutation: String? = nil, sandboxID: String? = "sandbox_1") -> Data {
    Data(#"{"protocol_version":"v1","request_id":"\#(operation)-1","operation":"\#(operation)","sandbox_id":\#(sandboxID.map { "\"\($0)\"" } ?? "null"),"deadline_ms":60000,"mutation_id":\#(mutation.map { "\"\($0)\"" } ?? "null"),"input":\#(input)}"#.utf8)
}

private func call(_ daemon: HostDaemon, _ request: Data) async throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: try await daemon.request(request)) as! [String: Any]
}

private func hostCall(_ daemon: HostDaemon, _ operation: String, _ input: String, sandboxID: String? = nil) async throws -> [String: Any] {
    let response = try await call(daemon, envelope(operation, input, sandboxID: sandboxID))
    XCTAssertEqual(response["ok"] as? Bool, true, "\(operation): \(response)")
    return response["result"] as? [String: Any] ?? [:]
}

/// A started daemon holding `sandbox_1`; with `echo`, a guest channel that answers each envelope with itself.
private func daemonWithSandbox(echo: Bool) async throws -> HostDaemon {
    let daemon = HostDaemon(backend: FakeVMBackend(), hostCPUs: 4, hostMemoryBytes: 8 * 1024 * 1024 * 1024)
    _ = try await hostCall(daemon, "sandbox.create", #"{"name":"one"}"#, sandboxID: "sandbox_1")
    if echo { await daemon.attach(channel: FakeGuestChannel { data in data }) }
    return daemon
}


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
        let daemon = try await daemonWithSandbox(echo: true)
        let path = localSocketPath()
        let endpoint = LocalIPCEndpoint(socketPath: path)
        let ipc = AuthenticatedLocalIPC(daemon: daemon, token: "socket-secret", endpoint: endpoint)
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
        let daemon = HostDaemon(backend: FakeVMBackend())
        try await daemon.start()
        await daemon.attach(channel: FakeGuestChannel { data in data })
        let path = localSocketPath()
        let endpoint = LocalIPCEndpoint(socketPath: path)
        let ipc = AuthenticatedLocalIPC(daemon: daemon, token: "socket-secret", endpoint: endpoint)
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
        let daemon = HostDaemon(backend: FakeVMBackend())
        try await daemon.start()
        await daemon.attach(channel: FakeGuestChannel { data in data })
        let path = localSocketPath()
        let endpoint = LocalIPCEndpoint(socketPath: path)
        let ipc = AuthenticatedLocalIPC(daemon: daemon, token: "socket-secret", endpoint: endpoint)
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
