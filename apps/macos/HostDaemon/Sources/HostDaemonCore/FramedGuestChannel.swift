import Foundation

/// GuestService transport: a big-endian uint32 length followed by one JSON frame. Requests travel as
/// `{kind: "request", request, channel_epoch}` and replies as `{kind: "response", response, …}`; the epoch is
/// the one the guest announced in its ready frame. The actor serializes requests over the ordered stream.
public actor FramedFileHandleGuestChannel: GuestChannel, GuestReadinessProvider {
    private let reader: FileHandle
    private let writer: FileHandle
    private let maxFrameBytes: UInt32
    private var closed = false
    private var ready = false
    private var channelEpoch = 0

    public init(reader: FileHandle, writer: FileHandle, maxFrameBytes: UInt32 = 8 * 1024 * 1024) {
        self.reader = reader; self.writer = writer; self.maxFrameBytes = maxFrameBytes
    }

    public func send(_ envelope: Data) async throws -> Data {
        guard !closed else { throw HostDaemonError.guestUnavailable }
        guard let request = try JSONSerialization.jsonObject(with: envelope) as? [String: Any] else { throw HostDaemonError.unsupported("guest request is not a JSON object") }
        let frame = try JSONSerialization.data(withJSONObject: ["kind": "request", "request": request, "channel_epoch": channelEpoch])
        guard frame.count <= Int(maxFrameBytes) else { throw HostDaemonError.unsupported("guest envelope exceeds the configured frame limit") }
        var length = UInt32(frame.count).bigEndian
        let header = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
        try writer.write(contentsOf: header); try writer.write(contentsOf: frame)
        while true {
            let object = try JSONSerialization.jsonObject(with: try readFrame()) as? [String: Any]
            switch object?["kind"] as? String {
            case "ready": adopt(object); continue
            case "response":
                guard let response = object?["response"] else { throw HostDaemonError.unsupported("guest response frame has no response") }
                return try JSONSerialization.data(withJSONObject: response)
            default: throw HostDaemonError.unsupported("guest channel emitted an unexpected frame")
            }
        }
    }

    public func waitUntilReady() async throws {
        guard !closed else { throw HostDaemonError.guestUnavailable }
        while !ready {
            let object = try JSONSerialization.jsonObject(with: try readFrame()) as? [String: Any]
            guard object?["kind"] as? String == "ready" else { throw HostDaemonError.unsupported("guest channel emitted a frame before readiness") }
            adopt(object)
        }
    }

    private func adopt(_ ready: [String: Any]?) { self.ready = true; channelEpoch = ready?["channel_epoch"] as? Int ?? channelEpoch }

    public func close() async {
        guard !closed else { return }; closed = true
        try? writer.close(); try? reader.close()
    }

    private func readFrame() throws -> Data {
        let header = try readExactly(4); let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard length <= maxFrameBytes else { throw HostDaemonError.unsupported("guest frame exceeds the configured frame limit") }
        return try readExactly(Int(length))
    }

    private func readExactly(_ count: Int) throws -> Data {
        var result = Data(); result.reserveCapacity(count)
        while result.count < count {
            let chunk = try reader.read(upToCount: count - result.count) ?? Data()
            if chunk.isEmpty { throw HostDaemonError.guestUnavailable }
            result.append(chunk)
        }
        return result
    }
}

