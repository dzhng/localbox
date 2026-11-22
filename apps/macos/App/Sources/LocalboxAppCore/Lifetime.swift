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
        /// `pending`: the sandboxes the daemon has not yet reported hibernated or stopped. `quiet`: the daemon has
        /// written nothing for `quietAfter` (it is still waited for; nothing kills a daemon that may be saving).
        case stopping(reason: Reason, pending: [String], quiet: Bool)
        case stopped
    }

    /// Longer than any save measured (spike 02: 4 × 2 GiB in at most 10.7 s) by far.
    public static let quietAfter: TimeInterval = 120

    private let connector: Supervised
    private let daemon: Supervised
    /// `localbox app image ensure`, a one-shot: it ends once this release's built-in image is installed.
    private let image: Supervised?
    private let quietAfter: TimeInterval
    private let changed: @Sendable (State) -> Void
    private let lock = NSLock()
    private var current = State.running
    /// Why the children last stopped; only an update's stop can be undone.
    private var stoppedFor: Reason?
    /// When the daemon last wrote a line during a stop, and the timer that notices it going quiet.
    private var lastHeard = Date()
    private var watchdog: DispatchSourceTimer?

    public init(connector: Supervised, daemon: Supervised, image: Supervised? = nil, quietAfter: TimeInterval = Lifetime.quietAfter,
                changed: @escaping @Sendable (State) -> Void) {
        self.connector = connector; self.daemon = daemon; self.image = image; self.quietAfter = quietAfter; self.changed = changed
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
            current = .stopping(reason: reason, pending: running, quiet: false); lastHeard = Date(); return true
        }
        guard began else { return }
        changed(.stopping(reason: reason, pending: running, quiet: false))
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + min(1, quietAfter / 4), repeating: min(1, quietAfter / 4))
        timer.setEventHandler { [weak self] in self?.noticeQuiet() }
        lock.withLock { watchdog = timer }
        timer.resume()
        Thread.detachNewThread { [self] in
            connector.stop()
            // A download stopped here resumes at the next launch.
            image?.stop()
            daemon.stop()
            lock.withLock { watchdog?.cancel(); watchdog = nil; current = .stopped; stoppedFor = reason }
            changed(.stopped)
        }
    }

    private func noticeQuiet() {
        let update: State? = lock.withLock {
            guard case .stopping(let reason, let pending, false) = current, Date().timeIntervalSince(lastHeard) > quietAfter else { return nil }
            current = .stopping(reason: reason, pending: pending, quiet: true); return current
        }
        if let update { changed(update) }
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

    /// One line of the daemon's output. While stopping, any line ends `quiet` (a daemon still writing is not wedged),
    /// and `hibernated NAME` and `stopped NAME: why` (the daemon's shutdown progress, `DaemonShutdown`) take NAME off
    /// `pending`.
    public func daemonSaid(_ line: String) {
        let name = Self.finished(line)
        let update: State? = lock.withLock {
            guard case .stopping(let reason, var pending, let quiet) = current else { return nil }
            lastHeard = Date()
            let index = name.flatMap { pending.firstIndex(of: $0) }
            guard quiet || index != nil else { return nil }
            if let index { pending.remove(at: index) }
            current = .stopping(reason: reason, pending: pending, quiet: false); return current
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
