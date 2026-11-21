import Foundation

/// The guest's control lane (`GuestPort.control`): freeze, thaw and agent updates, apart from the request lane, so they
/// never queue behind a guest request and never pass its mutation journal. Twin of `packages/guest-gateway/src/control.ts`.
public protocol GuestControlChannel: Sendable {
    /// `sync`, then freeze the guest's root filesystem; the guest thaws itself after `timeoutMs` if no thaw comes.
    func freeze(timeoutMs: Int) async throws
    /// Thaws a frozen guest; a no-op on one that is not frozen.
    func thaw() async throws
    /// Sends `binary` in chunks; on `.updated` the guest swapped it in and its agent is exiting.
    func updateAgent(_ binary: AgentBinary) async throws -> AgentUpdateOutcome
    func close() async
}

/// Backends whose guest has a control lane dial it per need, one connection per exclusive operation.
public protocol GuestControlDialer: Sendable {
    func dialControl() async throws -> any GuestControlChannel
}

/// A control lane over a byte stream: each frame the host writes gets one answer, in order. Every answer has a
/// deadline, so a guest that never answers fails the exchange instead of holding the sandbox's operation lock; a missed
/// deadline closes the lane, since the late answer would be taken for the next frame's.
public actor FramedControlChannel: GuestControlChannel {
    private let reader: FileHandle
    private let writer: FileHandle
    private let maxFrameBytes: UInt32
    private let readQueue = DispatchQueue(label: "org.localbox.guest-control.read")
    private let onClose: @Sendable () -> Void
    private var reading = false
    private var closed = false

    /// `onClose` releases what keeps the stream open (a vsock connection object).
    public init(reader: FileHandle, writer: FileHandle, maxFrameBytes: UInt32 = 8 * 1024 * 1024, onClose: @escaping @Sendable () -> Void = {}) {
        self.reader = reader; self.writer = writer; self.maxFrameBytes = maxFrameBytes; self.onClose = onClose
    }

    /// `sync` can take a while with much unwritten data, so a freeze waits longer for its answer than a thaw.
    public func freeze(timeoutMs: Int) async throws {
        _ = try await exchange(["kind": "freeze", "timeout_ms": timeoutMs], expecting: ["frozen"], within: 60)
    }

    public func thaw() async throws {
        _ = try await exchange(["kind": "thaw"], expecting: ["thawed"], within: 15)
    }

    /// The header, then each chunk as base64, every one answered before the next is sent. The last chunk's answer
    /// comes after the guest verified, synced and renamed the binary, so it gets the longest deadline.
    public func updateAgent(_ binary: AgentBinary) async throws -> AgentUpdateOutcome {
        let header = try await exchange(["kind": "agent.update", "version": binary.version, "sha256": binary.sha256, "size": binary.size], expecting: ["agent.receiving", "deferred"], within: 15)
        if header["kind"] as? String == "deferred" { return .deferred(runningJobs: (header["running_jobs"] as? NSNumber)?.intValue ?? 0) }
        let file = try FileHandle(forReadingFrom: binary.url); defer { try? file.close() }
        var offset = 0
        while offset < binary.size {
            guard let chunk = try file.read(upToCount: min(binary.chunkBytes, binary.size - offset)), !chunk.isEmpty else { throw HostDaemonError.unsupported("\(binary.url.path) is shorter than its \(binary.size) bytes") }
            let last = offset + chunk.count == binary.size
            _ = try await exchange(["kind": "agent.chunk", "offset": offset, "data": chunk.base64EncodedString()], expecting: [last ? "updated" : "agent.received"], within: last ? 60 : 30)
            offset += chunk.count
        }
        return .updated
    }

    /// Sends one frame and returns the guest's answer, whose kind must be one of `kinds` (a `control_error` says why not).
    func exchange(_ frame: [String: Any], expecting kinds: Set<String>, within seconds: TimeInterval) async throws -> [String: Any] {
        guard !closed, !reading else { throw HostDaemonError.guestUnavailable }
        try writer.write(contentsOf: try GuestFrameCodec.encode(frame, maxFrameBytes: maxFrameBytes))
        let reader = reader, maxFrameBytes = maxFrameBytes, deadline = Date().addingTimeInterval(seconds)
        reading = true
        let read = await withCheckedContinuation { (continuation: CheckedContinuation<Result<Data, Error>, Never>) in
            readQueue.async { continuation.resume(returning: Result { try GuestFrameCodec.read(from: reader, maxFrameBytes: maxFrameBytes, deadline: deadline) }) }
        }
        reading = false
        if closed { try? reader.close(); throw HostDaemonError.guestUnavailable }
        let sent = frame["kind"] as? String ?? "control"
        let data: Data
        do { data = try read.get() } catch is GuestFrameTimeout {
            close()
            throw HostDaemonError.guestUnresponsive("the guest did not answer \(sent) on its control lane within \(spoken(seconds)); the lane is closed")
        }
        let answer = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        switch answer["kind"] as? String {
        case let answered? where kinds.contains(answered): return answer
        case "control_error": throw HostDaemonError.invalidState("the guest refused \(sent): \(answer["message"] as? String ?? "no reason given")")
        default: throw HostDaemonError.unsupported("the guest answered \(sent) with \(answer["kind"] as? String ?? "no kind") on its control lane")
        }
    }

    public func close() {
        guard !closed else { return }; closed = true
        try? writer.close(); if !reading { try? reader.close() }
        onClose()
    }
}
