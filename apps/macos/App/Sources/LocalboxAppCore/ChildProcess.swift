import Darwin
import Foundation

/// What one supervised child runs.
public struct ChildLaunch: Sendable, Equatable {
    public var executable: URL
    public var arguments: [String]
    public var environment: [String: String]
    /// stdout and stderr are appended here directly, never piped through the app: a child whose app was killed must
    /// still be able to log its own shutdown (a write to a pipe nobody reads fails, and can kill the writer).
    public var log: URL

    public init(executable: URL, arguments: [String], environment: [String: String], log: URL) {
        self.executable = executable; self.arguments = arguments; self.environment = environment; self.log = log
    }
}

/// How a child is stopped. Either way stdin closes first: that is the stop signal every Localbox child obeys.
public enum StopPolicy: Sendable, Equatable {
    /// Wait `eof`, then SIGTERM, wait `signal`, then SIGKILL its process group. For children with nothing to save.
    case bounded(eof: TimeInterval, signal: TimeInterval)
    /// Wait for the exit however long it takes. SIGTERM once if the child has written nothing for `quiet` seconds;
    /// never SIGKILL, since a daemon that is quiet may still be saving a VM (specs/menu-bar-app, invariant 3).
    case patient(quiet: TimeInterval)

    /// The connector's: 4 s, SIGTERM, 2 s, SIGKILL (Bento's child window).
    public static let connector = StopPolicy.bounded(eof: 4, signal: 2)
    /// The daemon's: hibernating can take as long as the sandboxes need; 120 s without a progress line is a wedge.
    public static let daemon = StopPolicy.patient(quiet: 120)
}

/// Restart delays: `initial`, doubling to `maximum`; a child that stayed up longer than `resetAfter` starts over.
public struct Backoff: Sendable, Equatable {
    public var initial: TimeInterval, maximum: TimeInterval, resetAfter: TimeInterval
    public init(initial: TimeInterval = 1, maximum: TimeInterval = 30, resetAfter: TimeInterval = 30) {
        self.initial = initial; self.maximum = maximum; self.resetAfter = resetAfter
    }
}

/// Where a supervised child is, as `app.info` reports it. `running` means its process is alive (a child still
/// stopping is running until it exits), not that it serves yet: whether the daemon answers is the CLI's to check.
public enum ChildState: String, Sendable {
    case running
    /// Started, before its first launch.
    case starting
    /// Not supervised: never started, or stopped.
    case stopped
    /// It exited or could not be launched, and a restart is scheduled.
    case backingOff = "backing_off"
}

/// The one supervisor of Localbox.app's long-running children (the daemon and the connector), ported from Bento's
/// `ChildProcess`: it starts a child with a stdin pipe, restarts it with backoff whenever it exits on its own, and
/// stops it by closing that pipe, escalating as its `StopPolicy` allows. The pipe also stops the child when the app
/// dies, since the kernel closes the app's end. Every line the child writes reaches `onLine` (read back from its log).
public final class ChildProcess: @unchecked Sendable {
    public let name: String
    private let launch: ChildLaunch
    private let policy: StopPolicy
    private let backoff: Backoff
    private let onLine: @Sendable (String) -> Void
    private let diagnostic: @Sendable (String) -> Void
    private let queue: DispatchQueue
    private var delay: TimeInterval
    private var process: Process?
    private var input: Pipe?
    private var enabled = false
    /// Whether this start has launched (or tried to launch) a process yet.
    private var launched = false
    private var generation = 0
    private var tail: LogTail?
    private var lastOutput = Date()

    public init(name: String, launch: ChildLaunch, policy: StopPolicy, backoff: Backoff = Backoff(),
                onLine: @escaping @Sendable (String) -> Void = { _ in }, diagnostic: @escaping @Sendable (String) -> Void) {
        self.name = name; self.launch = launch; self.policy = policy; self.backoff = backoff
        self.onLine = onLine; self.diagnostic = diagnostic
        self.queue = DispatchQueue(label: "sh.localbox.mac.child.\(name)")
        self.delay = backoff.initial
    }

    /// The running child's pid, if one is running.
    public var pid: pid_t? { queue.sync { process.map(\.processIdentifier) } }

    public var state: ChildState {
        queue.sync {
            if process != nil { return .running }
            if !enabled { return .stopped }
            return launched ? .backingOff : .starting
        }
    }

    /// Starts the child; a child that cannot be launched is retried on the same backoff as one that exits.
    public func start() {
        queue.sync {
            guard !enabled else { return }
            enabled = true; launched = false
            if tail == nil { tail = LogTail(url: launch.log) { [weak self] line in self?.heard(line) } }
            startTailing()
            spawn()
        }
    }

    private func spawn() {
        launched = true
        let child = Process()
        child.executableURL = launch.executable
        child.arguments = launch.arguments
        child.environment = launch.environment
        child.currentDirectoryURL = URL(fileURLWithPath: "/")
        let pipe = Pipe()
        child.standardInput = pipe
        let started = Date()
        child.terminationHandler = { [weak self] child in self?.queue.async { self?.exited(child, started: started) } }
        do {
            let output = try LogTail.appending(launch.log)
            defer { try? output.close() }
            child.standardOutput = output; child.standardError = output
            try child.run()
        } catch {
            diagnostic("\(name) could not start: \(error.localizedDescription)")
            retry()
            return
        }
        process = child; input = pipe
        lastOutput = Date()
        diagnostic("\(name) started (pid \(child.processIdentifier))")
    }

    private func exited(_ child: Process, started: Date) {
        guard process === child else { return }
        // Foundation starts each child in its own process group; anything it left behind must not meet its successor.
        kill(-child.processIdentifier, SIGKILL)
        tail?.poll()
        process = nil; try? input?.fileHandleForWriting.close(); input = nil
        guard enabled else { return }
        if Date().timeIntervalSince(started) > backoff.resetAfter { delay = backoff.initial }
        diagnostic("\(name) exited (\(child.terminationReason == .exit ? "status" : "signal") \(child.terminationStatus)); restarting in \(delay) s")
        retry()
    }

    private func retry() {
        let wait = delay, attempt = generation
        delay = min(backoff.maximum, delay * 2)
        queue.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self, self.enabled, self.generation == attempt, self.process == nil else { return }
            self.spawn()
        }
    }

    /// Stops the child and cancels any pending restart; returns once it has exited. Blocks, so callers stay off the
    /// main thread. A stopped child can be started again.
    public func stop() {
        let (child, pipe): (Process?, Pipe?) = queue.sync { enabled = false; generation += 1; return (process, input) }
        defer { queue.sync { stopTailing() } }
        guard let child else { return }
        try? pipe?.fileHandleForWriting.close()
        switch policy {
        case .bounded(let eof, let signal):
            if Self.wait(child, eof) { return }
            diagnostic("\(name) still running \(eof) s after its stdin closed; sending SIGTERM")
            kill(child.processIdentifier, SIGTERM)
            if Self.wait(child, signal) { return }
            diagnostic("\(name) still running after SIGTERM; killing its process group")
            kill(-child.processIdentifier, SIGKILL); kill(child.processIdentifier, SIGKILL)
            _ = Self.wait(child, signal)
        case .patient(let quiet):
            queue.sync { lastOutput = Date() }
            var signalled = false
            while !Self.wait(child, 0.1) {
                let silent = Date().timeIntervalSince(queue.sync { lastOutput })
                if !signalled && silent > quiet {
                    diagnostic("\(name) has written nothing for \(Int(silent)) s since its stdin closed; sending SIGTERM and waiting on")
                    kill(child.processIdentifier, SIGTERM)
                    signalled = true
                }
            }
        }
    }

    private func heard(_ line: String) {
        lastOutput = Date()
        onLine(line)
    }

    private var timer: DispatchSourceTimer?
    private func startTailing() {
        guard timer == nil else { return }
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now(), repeating: 0.1)
        source.setEventHandler { [weak self] in self?.tail?.poll() }
        source.resume(); timer = source
    }
    private func stopTailing() { tail?.poll(); timer?.cancel(); timer = nil }

    private static func wait(_ child: Process, _ timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while child.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
        return !child.isRunning
    }
}

/// Reads what a child appends to its log, from where the log ended when tailing began, one whole line at a time.
final class LogTail {
    private let url: URL
    private let onLine: (String) -> Void
    private var offset: UInt64
    private var partial = Data()

    init(url: URL, onLine: @escaping (String) -> Void) {
        self.url = url; self.onLine = onLine
        offset = ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.uint64Value ?? 0
    }

    /// The log opened for appending (created 0600), so a restarted child, or an orphan still saving, never writes
    /// over another's lines.
    static func appending(_ url: URL) throws -> FileHandle {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let fd = open(url.path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }

    func poll() {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        if size < offset { offset = 0; partial.removeAll() }  // the log was replaced
        guard size > offset else { return }
        try? handle.seek(toOffset: offset)
        let data = (try? handle.readToEnd()) ?? Data()
        offset += UInt64(data.count)
        partial.append(data)
        while let newline = partial.firstIndex(of: 10) {
            onLine(String(decoding: partial[partial.startIndex..<newline], as: UTF8.self))
            partial.removeSubrange(partial.startIndex...newline)
        }
    }
}
