import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// The daemon's one way down. SIGTERM and SIGINT (a quiet supervisor's escalation, a probe, a terminal) and, for a supervised daemon, the end
/// of its stdin (the parent closed the pipe, or died and the kernel closed it) all run the same steps, once: stop taking
/// requests, hibernate every running sandbox, let the Mac idle-sleep again, exit 0. A supervisor learns about each sandbox from one stderr line as it is
/// done, `hibernated NAME` or `stopped NAME: reason`, so it can show progress from real events, and it only ever waits
/// for the exit: nothing here has a deadline, because a save that is cut off loses that sandbox's memory.
public final class DaemonShutdown: Sendable {
    private let server: UnixDomainSocketServer
    private let host: SandboxHost
    private let log: @Sendable (String) -> Void
    private let exit: @Sendable (Int32) -> Void
    private let started = Locked(false)
    private let signalSources = Locked<[DispatchSourceSignal]>([])

    /// `exit` ends the process; tests pass one that records the status instead.
    public init(server: UnixDomainSocketServer, host: SandboxHost, log: @escaping @Sendable (String) -> Void, exit: @escaping @Sendable (Int32) -> Void = { status in
        #if canImport(Darwin)
        Darwin.exit(status)
        #else
        Glibc.exit(status)
        #endif
    }) {
        self.server = server; self.host = host; self.log = log; self.exit = exit
    }

    /// Stops on each of `signals`, which no longer end the process by themselves.
    public func onSignals(_ signals: [Int32]) {
        for number in signals {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            let name = number == SIGTERM ? "SIGTERM" : number == SIGINT ? "SIGINT" : "signal \(number)"
            source.setEventHandler { [self] in run(because: name) }
            source.resume()
            signalSources.withLock { $0.append(source) }
        }
    }

    /// Stops when `descriptor` reaches its end. The supervisor never writes to the pipe, so anything read is dropped; a
    /// read error ends the watch the same way, since the parent can no longer be heard either way.
    public func onEndOfInput(_ descriptor: Int32) {
        let thread = Thread { [self] in
            var buffer = [UInt8](repeating: 0, count: 512)
            while true {
                let count = read(descriptor, &buffer, buffer.count)
                if count > 0 || (count < 0 && errno == EINTR) { continue }
                run(because: count == 0 ? "stdin closed" : "stdin failed (errno \(errno))")
                return
            }
        }
        thread.name = "sh.localbox.hostd.stdin"
        thread.start()
    }

    /// Runs the shutdown the first time it is asked. A second request (SIGTERM, then the pipe closing as the parent
    /// exits) is dropped: the first is already saving every sandbox.
    public func run(because reason: String) {
        let first = started.withLock { running -> Bool in
            if running { return false }
            running = true; return true
        }
        guard first else { return }
        Task { [self] in
            log("stopping (\(reason)): hibernating running sandboxes")
            await server.stop()
            await host.shutdown { [log] name, failure in log(failure.map { "stopped \(name): \($0)" } ?? "hibernated \(name)") }
            await host.releaseIdleSleep()
            exit(0)
        }
    }
}
