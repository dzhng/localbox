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
        let daemon = HostDaemon(backend: FakeVMBackend())
        try await daemon.start()
        await daemon.attach(channel: FakeGuestChannel { data in data })
        let ipc = AuthenticatedLocalIPC(daemon: daemon, token: "secret")
        let envelope = Data("request".utf8)
        do { _ = try await ipc.handle(LocalIPCRequest(token: "wrong", envelope: envelope)); XCTFail("expected authentication failure") } catch { }
        let echoed = try await ipc.handle(LocalIPCRequest(token: "secret", envelope: envelope))
        XCTAssertEqual(echoed, envelope)
    }

    func testRequestRoutesHostLifecycleOperationsBeforeGuestChannel() async throws {
        let daemon = HostDaemon(backend: FakeVMBackend())
        try await daemon.start()
        await daemon.attach(channel: FakeGuestChannel { data in data })
        let statusRequest = Data(#"{"protocol_version":"v1","request_id":"status-1","operation":"vm.status","vm_id":"vm_01","deadline_ms":30000,"mutation_id":null,"input":{}}"#.utf8)
        let status = try JSONSerialization.jsonObject(with: try await daemon.request(statusRequest)) as! [String: Any]
        XCTAssertEqual(status["ok"] as? Bool, true)
        XCTAssertEqual((status["result"] as? [String: Any])?["status"] as? String, "ready")

        let stopRequest = Data(#"{"protocol_version":"v1","request_id":"stop-1","operation":"vm.stop","vm_id":"vm_01","deadline_ms":30000,"mutation_id":"stop-1","input":{}}"#.utf8)
        let stopped = try JSONSerialization.jsonObject(with: try await daemon.request(stopRequest)) as! [String: Any]
        XCTAssertEqual(stopped["ok"] as? Bool, true)
        let stoppedStatus = await daemon.status()
        XCTAssertEqual(stoppedStatus.lifecycle, .stopped)

        let guestRequest = Data(#"{"protocol_version":"v1","request_id":"guest-1","operation":"shell.exec","vm_id":"vm_01","deadline_ms":30000,"mutation_id":"guest-1","input":{"command":"true"}}"#.utf8)
        do { _ = try await daemon.request(guestRequest); XCTFail("stopped VM should reject guest work") } catch { }
    }

    func testFramedGuestChannelSpeaksTheGuestFrameProtocol() async throws {
        let toGuest = Pipe(); let fromGuest = Pipe()
        let channel = FramedFileHandleGuestChannel(reader: fromGuest.fileHandleForReading, writer: toGuest.fileHandleForWriting)
        func frame(_ value: Data) -> Data { var size = UInt32(value.count).bigEndian; return Data(bytes: &size, count: 4) + value }
        try fromGuest.fileHandleForWriting.write(contentsOf: frame(Data(#"{"kind":"ready","channel_epoch":7}"#.utf8)))
        try await channel.waitUntilReady()
        let guest = Task.detached { () throws -> [String: Any] in
            let header = try toGuest.fileHandleForReading.read(upToCount: 4)!
            let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            let sent = try JSONSerialization.jsonObject(with: try toGuest.fileHandleForReading.read(upToCount: Int(length))!) as! [String: Any]
            try fromGuest.fileHandleForWriting.write(contentsOf: frame(Data(#"{"kind":"response","channel_epoch":7,"response":{"ok":true}}"#.utf8)))
            return sent
        }
        let response = try await channel.send(Data(#"{"request_id":"r1"}"#.utf8))
        XCTAssertEqual(String(data: response, encoding: .utf8), #"{"ok":true}"#)
        let sent = try await guest.value
        XCTAssertEqual(sent["kind"] as? String, "request")
        XCTAssertEqual(sent["channel_epoch"] as? Int, 7, "requests carry the epoch the guest announced")
        XCTAssertEqual((sent["request"] as? [String: Any])?["request_id"] as? String, "r1")
        await channel.close()
    }
}

private func XCTAssertThrowsErrorAsync(_ expression: @autoclosure () async throws -> Void) async {
    do { try await expression(); XCTFail("expected error") } catch {}
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
        let daemon = HostDaemon(backend: FakeVMBackend())
        try await daemon.start()
        await daemon.attach(channel: FakeGuestChannel { data in data })
        let path = localSocketPath()
        let endpoint = LocalIPCEndpoint(socketPath: path)
        let ipc = AuthenticatedLocalIPC(daemon: daemon, token: "socket-secret", endpoint: endpoint)
        let server = UnixDomainSocketServer(ipc: ipc, endpoint: endpoint)
        try await server.start()
        defer { Task { await server.stop() } }

        let fd = try connectLocalSocket(path)
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        let request = LocalIPCRequest(token: "socket-secret", envelope: Data("ping".utf8))
        try sendSocketFrame(try JSONEncoder().encode(request), to: handle)
        let response = try JSONDecoder().decode(LocalIPCResponse.self, from: receiveSocketFrame(from: handle))
        XCTAssertEqual(response.envelope, Data("ping".utf8))
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
