import Foundation

/// Keeps the app's copy of `AppFacts` current by running `localbox app status` through `BundledCLI` (the app reads
/// nothing else). While something shows the facts (`watching`: the popover or Settings is open), it long-polls with `--since <last watch_version>`, so a change shows within the CLI's wait.
/// With nothing open it cancels the running poll, which stops its CLI child, and reads once every `idleRefresh`, so
/// the status item's warning badge stays true. Each value whose `watch_version` differs from the last is published;
/// a repeat is not.
public final class FactsSource: @unchecked Sendable {
    /// One CLI invocation: `localbox <arguments> --json`'s stdout. `BundledCLI.run` in the app.
    public typealias Fetch = @Sendable (_ arguments: [String]) async throws -> Data

    private let fetch: Fetch
    private let idleRefresh: TimeInterval
    private let retryAfter: TimeInterval
    private let published: @Sendable (AppFacts) -> Void
    private let failed: @Sendable (Error) -> Void
    private let lock = NSLock()
    private var current: AppFacts?
    private var watching = false
    private var loop: Task<Void, Never>?

    public init(fetch: @escaping Fetch, idleRefresh: TimeInterval = 60, retryAfter: TimeInterval = 2,
                published: @escaping @Sendable (AppFacts) -> Void, failed: @escaping @Sendable (Error) -> Void = { _ in }) {
        self.fetch = fetch; self.idleRefresh = idleRefresh; self.retryAfter = retryAfter; self.published = published; self.failed = failed
    }

    public convenience init(cli: BundledCLI, idleRefresh: TimeInterval = 60, published: @escaping @Sendable (AppFacts) -> Void, failed: @escaping @Sendable (Error) -> Void = { _ in }) {
        self.init(fetch: { try await cli.run($0) }, idleRefresh: idleRefresh, published: published, failed: failed)
    }

    /// The last facts read, if any.
    public var latest: AppFacts? { lock.withLock { current } }

    /// Begins reading, idle until `setWatching(true)`.
    public func start() { restart() }

    /// Stops reading; a poll in flight is cancelled with its CLI child.
    public func stop() { lock.withLock { loop?.cancel(); loop = nil } }

    /// Whether anything shows the facts. A change restarts the loop: opening reads at once and then long-polls;
    /// closing cancels the long poll and goes back to idle refreshes.
    public func setWatching(_ value: Bool) {
        let changed: Bool = lock.withLock { defer { watching = value }; return watching != value }
        if changed { restart() }
    }

    private func restart() {
        lock.withLock {
            loop?.cancel()
            let watching = self.watching
            loop = Task.detached { [weak self] in await self?.run(watching: watching) }
        }
    }

    private func run(watching: Bool) async {
        // A first read without `--since`, so whoever just opened sees the facts as they are now.
        var since: Int?
        while !Task.isCancelled {
            do {
                let facts = try AppFacts.decode(try await fetch(["app", "status"] + (since.map { ["--since", String($0)] } ?? [])))
                let fresh: Bool = lock.withLock { defer { current = facts }; return current?.watchVersion != facts.watchVersion }
                if fresh && !Task.isCancelled { published(facts) }
                if watching { since = facts.watchVersion; continue }
                try await Task.sleep(nanoseconds: UInt64(idleRefresh * 1_000_000_000))
            } catch {
                if Task.isCancelled || error is CancellationError { return }
                failed(error)
                // A failed read (the CLI unavailable, a garbled answer) is tried again, never in a tight loop.
                since = nil
                try? await Task.sleep(nanoseconds: UInt64((watching ? retryAfter : idleRefresh) * 1_000_000_000))
            }
        }
    }
}
