import Foundation

/// GuestService transport: a big-endian uint32 length followed by one JSON frame. Requests travel as
/// `{kind: "request", request, channel_epoch}` and replies as `{kind: "response", response, …}`; the epoch is
/// the one the guest announced in its ready frame. One request at a time goes over the ordered stream; reads block
/// on the channel's own queue, so a long request never holds a thread of the cooperative pool.
public actor FramedFileHandleGuestChannel: GuestChannel, GuestReadinessProvider {
    private let reader: FileHandle
    private let readQueue = DispatchQueue(label: "org.localbox.guest-channel.read")
    /// A read is blocked on `readQueue`; `close` leaves the reader to it, so its descriptor is never closed under it.
    private var reading = false
    /// Held from a request's write to its response (and through readiness), so exchanges never interleave.
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private let writer: FileHandle
    private let maxFrameBytes: UInt32
    private var closed = false
    private var ready = false
    private var channelEpoch = 0
    /// Who the guest is: it keys its machine-id and SSH host keys on the id and takes the name as its hostname.
    private let sandboxID: String
    private var name: String
    private let wallClock: () -> Int64
    private var helloSent = false

    public init(reader: FileHandle, writer: FileHandle, sandboxID: String, name: String, maxFrameBytes: UInt32 = 8 * 1024 * 1024, wallClock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.reader = reader; self.writer = writer; self.sandboxID = sandboxID; self.name = name; self.maxFrameBytes = maxFrameBytes; self.wallClock = wallClock
    }

    public func send(_ envelope: Data) async throws -> Data {
        await acquire(); defer { release() }
        guard !closed else { throw HostDaemonError.guestUnavailable }
        guard let request = try JSONSerialization.jsonObject(with: envelope) as? [String: Any] else { throw HostDaemonError.unsupported("guest request is not a JSON object") }
        try writer.write(contentsOf: try GuestFrameCodec.encode(["kind": "request", "request": request, "channel_epoch": channelEpoch], maxFrameBytes: maxFrameBytes))
        while true {
            let object = try JSONSerialization.jsonObject(with: try await readFrame()) as? [String: Any]
            switch object?["kind"] as? String {
            case "ready": adopt(object); try sendHello(); continue
            case "response":
                guard let response = object?["response"] else { throw HostDaemonError.unsupported("guest response frame has no response") }
                return try JSONSerialization.data(withJSONObject: response)
            default: throw HostDaemonError.unsupported("guest channel emitted an unexpected frame")
            }
        }
    }

    public func waitUntilReady() async throws {
        await acquire(); defer { release() }
        guard !closed else { throw HostDaemonError.guestUnavailable }
        while !ready {
            let object = try JSONSerialization.jsonObject(with: try await readFrame()) as? [String: Any]
            guard object?["kind"] as? String == "ready" else { throw HostDaemonError.unsupported("guest channel emitted a frame before readiness") }
            adopt(object)
            try sendHello()
        }
    }

    /// A hello under the next epoch carries the new name; the guest applies a hello only when its epoch is newer.
    public func rename(to name: String) throws {
        self.name = name
        guard ready, !closed else { return }
        channelEpoch += 1; helloSent = false
        try sendHello()
    }

    /// The host owns the epoch: each (re)connection moves one past what the guest announced, and the hello
    /// frame tells the guest to adopt it, so frames from an earlier connection are stale on both sides.
    private func adopt(_ ready: [String: Any]?) { self.ready = true; channelEpoch = max(channelEpoch, (ready?["channel_epoch"] as? Int ?? 0) + 1); helloSent = false }

    private func sendHello() throws {
        guard !helloSent else { return }
        try writer.write(contentsOf: try GuestFrameCodec.encode(["kind": "hello", "channel_epoch": channelEpoch, "wall_clock_ms": wallClock(), "sandbox_id": sandboxID, "hostname": name], maxFrameBytes: maxFrameBytes))
        helloSent = true
    }

    public func close() async {
        guard !closed else { return }; closed = true
        try? writer.close(); if !reading { try? reader.close() }
    }

    private func acquire() async {
        guard busy else { busy = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    /// Hands the stream to the next waiter, or frees it.
    private func release() {
        if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
    }

    private func readFrame() async throws -> Data {
        let reader = reader, maxFrameBytes = maxFrameBytes
        reading = true
        let frame = await withCheckedContinuation { (continuation: CheckedContinuation<Result<Data, Error>, Never>) in
            readQueue.async { continuation.resume(returning: Result { try GuestFrameCodec.read(from: reader, maxFrameBytes: maxFrameBytes) }) }
        }
        reading = false
        // Closed while the read was blocked: the reader was left to it, so it closes here.
        if closed { try? reader.close(); throw HostDaemonError.guestUnavailable }
        return try frame.get()
    }
}

/// The guest wire format both lanes share: a big-endian uint32 length, then one JSON object.
enum GuestFrameCodec {
    static func encode(_ frame: [String: Any], maxFrameBytes: UInt32) throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: frame)
        guard body.count <= Int(maxFrameBytes) else { throw HostDaemonError.unsupported("a \(frame["kind"] as? String ?? "guest") frame exceeds the configured frame limit") }
        var length = UInt32(body.count).bigEndian
        return Data(bytes: &length, count: 4) + body
    }

    /// Blocks until one whole frame arrives; `deadline` bounds the wait (a guest that never answers), else it waits forever.
    static func read(from reader: FileHandle, maxFrameBytes: UInt32, deadline: Date? = nil) throws -> Data {
        let header = try readExactly(4, from: reader, deadline: deadline); let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard length <= maxFrameBytes else { throw HostDaemonError.unsupported("guest frame exceeds the configured frame limit") }
        return try readExactly(Int(length), from: reader, deadline: deadline)
    }

    private static func readExactly(_ count: Int, from reader: FileHandle, deadline: Date?) throws -> Data {
        var result = Data(); result.reserveCapacity(count)
        while result.count < count {
            if let deadline { try waitReadable(reader.fileDescriptor, until: deadline) }
            let chunk = try reader.read(upToCount: count - result.count) ?? Data()
            if chunk.isEmpty { throw HostDaemonError.guestUnavailable }
            result.append(chunk)
        }
        return result
    }

    private static func waitReadable(_ descriptor: Int32, until deadline: Date) throws {
        while true {
            let remaining = Int32(max(0, min(Double(Int32.max), deadline.timeIntervalSinceNow * 1000)).rounded(.up))
            var poller = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            let ready = poll(&poller, 1, remaining)
            if ready > 0 { return }
            if ready < 0, errno == EINTR { continue }
            if ready < 0 { throw HostDaemonError.unsupported("could not wait on the guest channel: errno \(errno)") }
            throw GuestFrameTimeout()
        }
    }
}

/// The guest did not answer before the deadline.
struct GuestFrameTimeout: Error {}
