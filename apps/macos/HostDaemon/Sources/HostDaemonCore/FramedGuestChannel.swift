import Foundation

/// GuestService transport: a big-endian uint32 length followed by one JSON envelope.
/// The actor serializes requests because the virtio console is an ordered byte stream.
public actor FramedFileHandleGuestChannel: GuestChannel, GuestReadinessProvider {
    private let reader: FileHandle
    private let writer: FileHandle
    private let maxFrameBytes: UInt32
    private var closed = false
    private var ready = false

    public init(reader: FileHandle, writer: FileHandle, maxFrameBytes: UInt32 = 8 * 1024 * 1024) {
        self.reader = reader; self.writer = writer; self.maxFrameBytes = maxFrameBytes
    }

    public func send(_ envelope: Data) async throws -> Data {
        guard !closed else { throw HostDaemonError.guestUnavailable }
        guard envelope.count <= Int(maxFrameBytes) else { throw HostDaemonError.unsupported("guest envelope exceeds the configured frame limit") }
        var length = UInt32(envelope.count).bigEndian
        let header = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
        try writer.write(contentsOf: header); try writer.write(contentsOf: envelope)
        while true {
            let response = try readFrame()
            if let object = try? JSONSerialization.jsonObject(with: response) as? [String: Any], object["kind"] as? String == "ready" { ready = true; continue }
            return response
        }
    }

    public func waitUntilReady() async throws {
        guard !closed else { throw HostDaemonError.guestUnavailable }
        while !ready {
            let response = try readFrame()
            guard let object = try? JSONSerialization.jsonObject(with: response) as? [String: Any], object["kind"] as? String == "ready" else { throw HostDaemonError.unsupported("guest channel emitted a non-readiness frame before startup") }
            ready = true
        }
    }

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

