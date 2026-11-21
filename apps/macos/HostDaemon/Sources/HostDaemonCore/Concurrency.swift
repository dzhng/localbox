import Foundation

/// A value behind a lock, for state that callbacks on other threads share (pipe readers, completion handlers, a
/// download's byte count).
public final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    public init(_ value: Value) { stored = value }
    public var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
    @discardableResult public func withLock<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
        try lock.withLock { try body(&stored) }
    }
}

extension Locked where Value == Bool {
    /// True for the first caller only: a continuation that two callbacks race to resume is resumed once.
    public func claim() -> Bool { withLock { done in defer { done = true }; return !done } }
}

/// Callers parked until their owner wakes them, their timeout passes or their task is cancelled: every long poll in
/// the daemon (`host.watch`, `image.wait`, the connector's outcome and copy polls, a copy waiting for its row). It
/// belongs to one actor, which calls `wait` and `wake` only from its own isolation; `wait` takes that isolation, so the
/// list is never touched off the actor.
final class WaitList<Key: Sendable>: @unchecked Sendable {
    private var parked: [UUID: (key: Key, continuation: CheckedContinuation<Void, Never>)] = [:]

    /// Returns once a `wake` matches `key`, after `timeout` (nil: none) or once the task is cancelled. The caller looks
    /// again at whatever it waited for: a wake says only that something changed.
    func wait(for key: Key, timeout: TimeInterval?, isolation: isolated (any Actor)? = #isolation) async {
        let id = UUID()
        // The timer inherits the owner's isolation (it captures it), so it resumes on the owner.
        let timer = timeout.map { seconds in
            Task { try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000)); self.resume(id, isolation: isolation) }
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if Task.isCancelled { continuation.resume() } else { parked[id] = (key, continuation) }
            }
        } onCancel: { Task { await self.resume(id, isolation: isolation) } }
        timer?.cancel()
    }

    /// Wakes every caller whose key matches.
    func wake(where matches: (Key) -> Bool) {
        for (id, entry) in parked where matches(entry.key) { parked.removeValue(forKey: id); entry.continuation.resume() }
    }

    func wakeAll() { wake { _ in true } }

    private func resume(_ id: UUID, isolation: isolated (any Actor)?) { parked.removeValue(forKey: id)?.continuation.resume() }
}

extension WaitList where Key: Equatable {
    func wake(_ key: Key) { wake { $0 == key } }
}
