import Foundation

/// The guest's control lane (vsock port 1025): freeze and thaw, apart from the request lane, so they never queue
/// behind a guest request (the request lane has no timeout) and never pass its mutation journal. Twin of
/// `packages/guest-gateway/src/control.ts`.
public protocol GuestControlChannel: Sendable {
    /// `sync`, then freeze the guest's root filesystem; the guest thaws itself after `timeoutMs` if no thaw comes.
    func freeze(timeoutMs: Int) async throws
    /// Thaws a frozen guest; a no-op on one that is not frozen.
    func thaw() async throws
    func close() async
}

/// Backends whose guest has a control lane dial it per need, one connection per exclusive operation.
public protocol GuestControlDialer: Sendable {
    func dialControl() async throws -> any GuestControlChannel
}

/// A control lane over a byte stream: each frame the host writes gets one answer, in order. Every answer has a
/// deadline, so a guest that never answers fails the exchange instead of holding the sandbox's operation lock.
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
        _ = try await exchange(["kind": "freeze", "timeout_ms": timeoutMs], expecting: "frozen", within: 60)
    }

    public func thaw() async throws {
        _ = try await exchange(["kind": "thaw"], expecting: "thawed", within: 15)
    }

    /// Sends one frame and returns the guest's answer, which must be `expecting` (a `control_error` says why not).
    func exchange(_ frame: [String: Any], expecting kind: String, within seconds: TimeInterval) async throws -> [String: Any] {
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
            throw HostDaemonError.unsupported("the guest did not answer \(sent) on its control lane within \(spoken(seconds))")
        }
        let answer = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        switch answer["kind"] as? String {
        case kind: return answer
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
