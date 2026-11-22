import Foundation

/// A child `Lifetime` starts and stops; `ChildProcess` in the app, fakes in tests.
public protocol Supervised: AnyObject, Sendable {
    func start()
    /// Returns once the child has exited.
    func stop()
}

extension ChildProcess: Supervised {}

/// The app's one way up and one way down: the daemon and the connector start together, and every quit (the menu,
/// SIGTERM, logout, an update) stops the connector first, so this Mac goes offline before its sandboxes stop being
/// served, then the daemon, which hibernates its sandboxes on the way out. The app exits only at `stopped`.
public final class Lifetime: @unchecked Sendable {
    public enum Reason: String, Sendable { case quit, logout, update }
    public enum State: Equatable, Sendable {
        case running
        /// `pending`: the sandboxes the daemon has not yet reported hibernated or stopped.
        case stopping(reason: Reason, pending: [String])
        case stopped
    }

    private let connector: Supervised
    private let daemon: Supervised
    /// `localbox app image ensure`, a one-shot: it ends once this release's built-in image is installed.
    private let image: Supervised?
    private let changed: @Sendable (State) -> Void
    private let lock = NSLock()
    private var current = State.running
    /// Why the children last stopped; only an update's stop can be undone.
    private var stoppedFor: Reason?

    public init(connector: Supervised, daemon: Supervised, image: Supervised? = nil, changed: @escaping @Sendable (State) -> Void) {
        self.connector = connector; self.daemon = daemon; self.image = image; self.changed = changed
    }

    public var state: State { lock.withLock { current } }

    /// The daemon first, so the connector finds its socket sooner; then the built-in image's check. Every launch runs
    /// it, so the relaunch after an update (`--localbox-update-relaunch` is a launch, and every Sparkle install ends in
    /// one) fetches the new release's image.
    public func start() {
        daemon.start(); connector.start(); image?.start()
    }

    /// Begins the stop and returns at once; `changed` reports `stopped` once both children are gone. `running` names
    /// the sandboxes that were running, for `pending`. Only the first request counts: a SIGTERM during a quit
    /// changes nothing.
    public func stop(_ reason: Reason, running: [String] = []) {
        let began: Bool = lock.withLock {
            guard current == .running else { return false }
            current = .stopping(reason: reason, pending: running); return true
        }
        guard began else { return }
        changed(.stopping(reason: reason, pending: running))
        Thread.detachNewThread { [self] in
            connector.stop()
            // A download stopped here resumes at the next launch.
            image?.stop()
            daemon.stop()
            lock.withLock { current = .stopped; stoppedFor = reason }
            changed(.stopped)
        }
    }

    /// Starts the children again after an update stopped them and then did not install (`UpdateCoordinator`). A quit's
    /// or a logout's stop is final, as is a stop still in progress: false then.
    @discardableResult
    public func restart() -> Bool {
        let resumed: Bool = lock.withLock {
            guard current == .stopped, stoppedFor == .update else { return false }
            current = .running; stoppedFor = nil; return true
        }
        guard resumed else { return false }
        changed(.running)
        start()
        return true
    }

    /// One line of the daemon's output. While stopping, `hibernated NAME` and `stopped NAME: why` (the daemon's
    /// shutdown progress, `DaemonShutdown`) take NAME off `pending`.
    public func daemonSaid(_ line: String) {
        guard let name = Self.finished(line) else { return }
        let update: State? = lock.withLock {
            guard case .stopping(let reason, var pending) = current, let index = pending.firstIndex(of: name) else { return nil }
            pending.remove(at: index)
            current = .stopping(reason: reason, pending: pending); return current
        }
        if let update { changed(update) }
    }

    static func finished(_ line: String) -> String? {
        let prefix = "localbox-hostd: "
        guard line.hasPrefix(prefix) else { return nil }
        let text = line.dropFirst(prefix.count)
        if text.hasPrefix("hibernated ") { return String(text.dropFirst("hibernated ".count)) }
        if text.hasPrefix("stopped "), let colon = text.range(of: ": ") { return String(text[text.index(text.startIndex, offsetBy: "stopped ".count)..<colon.lowerBound]) }
        return nil
    }
}
