import AppKit
import Darwin
import LocalboxAppCore

/// Where the app's own diagnostics go: stderr, and `<logs>/app.log` once `app paths` has named the logs folder (what
/// was said before then is written there first).
final class Diagnostics: @unchecked Sendable {
    static let shared = Diagnostics()
    private let lock = NSLock()
    private var file: Int32 = -1
    private var early: [Data] = []

    func open(_ url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return }
        lock.withLock { file = fd; for line in early { Self.write(line, to: fd) }; early = [] }
    }

    func say(_ message: String) {
        let line = Data("\(ISO8601DateFormatter().string(from: Date())) localbox-app: \(message)\n".utf8)
        // A closed stderr (an app launched by `open`) must not cost the app; the log file is the record.
        Self.write(line, to: STDERR_FILENO)
        lock.withLock { if file >= 0 { Self.write(line, to: file) } else { early.append(line) } }
    }

    private static func write(_ line: Data, to fd: Int32) { _ = line.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) } }
}

@Sendable func diagnostic(_ message: String) { Diagnostics.shared.say(message) }

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let environment = ProcessInfo.processInfo.environment
    private var isRelease = false
    private var lifetime: Lifetime?
    private var appSocket: AppSocket?
    /// This Mac's facts, read through the CLI; the popover and Settings (slices 13, 14) set it watching.
    private var facts: FactsSource?
    private var inApplications = false
    /// A quit that arrived before supervision started: the startup finishes by answering it instead.
    private var quitBeforeStart = false
    private var startupFinished = false
    private var replyPending = false
    private var statusItem: NSStatusItem?
    private var headline: NSMenuItem?
    private var quitItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let bundle = Bundle.main
        isRelease = LaunchDecision.isRelease(bundle.infoDictionary ?? [:])
        let running = isRelease ? NSRunningApplication.runningApplications(withBundleIdentifier: bundle.bundleIdentifier ?? "")
            .filter { $0.processIdentifier != getpid() }.map(\.processIdentifier) : []
        let decision = LaunchDecision.decide(isRelease: isRelease, arguments: CommandLine.arguments, running: running)
        if case .handOff(let pid) = decision {
            diagnostic("another copy is running (pid \(pid)); exiting")
            exit(0)
        }
        inApplications = LaunchDecision.isInApplicationsFolder(bundle.bundleURL, home: FileManager.default.homeDirectoryForCurrentUser)
        diagnostic("launched \(bundle.bundleURL.path) (\(bundle.bundleIdentifier ?? "no bundle id"), \(decision), \(inApplications ? "in" : "not in") an Applications folder)")
        // Supervision never waits on the UI: a Mac with no display (a headless mini) still serves its sandboxes.
        startSupervision(bundle: bundle.bundleURL)
        showStatusItemOnceAScreenExists()
    }

    private func startSupervision(bundle: URL) {
        let cli = BundledCLI(bundle: bundle, environment: environment)
        let environment = self.environment
        Task.detached {
            let paths: AppPaths
            do { paths = try await AppPaths.load(cli) } catch {
                diagnostic("cannot learn this Mac's paths from \(cli.executable.path): \(error); nothing is supervised")
                await MainActor.run { self.startupFailed() }
                return
            }
            Diagnostics.shared.open(paths.log("app.log"))
            diagnostic("machine root \(paths.root)")
            await MainActor.run { self.supervise(bundle: bundle, cli: cli, paths: paths, environment: environment) }
        }
    }

    private func supervise(bundle: URL, cli: BundledCLI, paths: AppPaths, environment: [String: String]) {
        startupFinished = true
        if quitBeforeStart { answerTermination(); return }
        let lifetimeBox = LifetimeBox()
        let daemon = ChildProcess(name: "localbox-hostd", launch: DaemonLaunch.make(bundle: bundle, paths: paths, environment: environment),
                                  policy: .daemon, onLine: { line in lifetimeBox.value?.daemonSaid(line) }, diagnostic: diagnostic)
        let connector = ChildProcess(name: "connector", launch: cli.connector(log: paths.log("connector.log")), policy: .connector, diagnostic: diagnostic)
        let lifetime = Lifetime(connector: connector, daemon: daemon) { [weak self] state in
            RunLoop.main.perform(inModes: [.common]) { MainActor.assumeIsolated { self?.lifetimeChanged(state) } }
        }
        lifetimeBox.value = lifetime
        self.lifetime = lifetime
        let loginItem = makeLoginItem()
        diagnostic(loginItem.launched(isRelease: isRelease, inApplications: inApplications))
        serveAppSocket(paths: paths, control: AppControl(
            identity: .init(version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown", isRelease: isRelease, inApplications: inApplications),
            children: { (daemon.state, connector.state) }, lifetime: { lifetime.state }, loginItem: loginItem))
        lifetime.start()
        let facts = FactsSource(cli: cli, published: { _ in }, failed: { error in diagnostic("app status failed: \(error)") })
        self.facts = facts
        facts.start()
    }

    /// `SMAppService.mainApp`, except that a development build can stand in a fake (`LOCALBOX_APP_LOGIN_ITEM=fake`,
    /// as probes do), so a run on scratch roots never touches this account's login items.
    private func makeLoginItem() -> LoginItem {
        !isRelease && environment["LOCALBOX_APP_LOGIN_ITEM"] == "fake" ? .fake() : LoginItem(defaults: .standard)
    }

    /// The CLI's way to the app's native powers. A socket that cannot be served (another copy answers on this root)
    /// costs only `localbox app`; supervision goes on.
    private func serveAppSocket(paths: AppPaths, control: AppControl) {
        let socket = AppSocket(path: paths.appSocket) { operation, params in control.handle(operation, params) }
        do { try socket.start(); appSocket = socket } catch { diagnostic("app socket unavailable: \(error)") }
    }

    private func startupFailed() {
        startupFinished = true
        headline?.title = "Localbox could not start"
        if quitBeforeStart { answerTermination() }
    }

    private func lifetimeChanged(_ state: Lifetime.State) {
        switch state {
        case .running: break
        case .stopping(let reason, let pending):
            // A read now could find the app socket gone and start another copy of the app.
            facts?.stop()
            diagnostic("stopping (\(reason.rawValue))\(pending.isEmpty ? "" : ": waiting for \(pending.joined(separator: ", "))")")
            headline?.title = pending.isEmpty ? "Stopping: hibernating sandboxes…" : "Stopping: hibernating \(pending.joined(separator: ", "))…"
            quitItem?.isEnabled = false
        case .stopped:
            diagnostic("stopped")
            answerTermination()
        }
    }

    // MARK: - Status item

    /// The status item needs a screen. A development build can stub "no screens" (`LOCALBOX_APP_SCREENS=0`) to
    /// check that supervision does not depend on one.
    private func showStatusItemOnceAScreenExists() {
        let stubbed = !isRelease && environment["LOCALBOX_APP_SCREENS"] == "0"
        if !stubbed && !NSScreen.screens.isEmpty { showStatusItem(); return }
        diagnostic("no screen; the status item waits for one")
        guard !stubbed else { return }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.statusItem == nil && !NSScreen.screens.isEmpty { self?.showStatusItem() } }
        }
    }

    private func showStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        // A placeholder glyph until slice 13's popover.
        let image = NSImage(systemSymbolName: "shippingbox", accessibilityDescription: "Localbox")
        image?.isTemplate = true
        item.button?.image = image
        let menu = NSMenu()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let headline = NSMenuItem(title: "Localbox \(version)", action: nil, keyEquivalent: "")
        headline.isEnabled = false
        menu.addItem(headline)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Localbox", action: #selector(quitFromMenu), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item; self.headline = headline; quitItem = quit
    }

    @objc private func quitFromMenu() { quit() }

    // MARK: - Quitting

    /// The Quit item and SIGTERM.
    func quit() { NSApplication.shared.terminate(nil) }

    /// Every quit reaches this, including logout's. The app stays (status item and all) until both children have
    /// exited, however long the daemon takes to hibernate.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let lifetime else {
            if startupFinished { return .terminateNow }
            quitBeforeStart = true; replyPending = true
            return .terminateLater
        }
        if lifetime.state == .stopped { return .terminateNow }
        replyPending = true
        // The names the daemon reports as it saves each one, so the stop can say what it still waits for.
        lifetime.stop(Self.reason(), running: facts?.latest?.hibernating ?? [])
        return .terminateLater
    }

    private func answerTermination() {
        guard replyPending else { return }
        replyPending = false
        // Answering until here lets `localbox app status` show the stop in progress.
        appSocket?.stop(); appSocket = nil
        NSApplication.shared.reply(toApplicationShouldTerminate: true)
    }

    /// Logout, restart and shutdown arrive as a quit Apple event that names why.
    private static func reason() -> Lifetime.Reason {
        guard let why = NSAppleEventManager.shared().currentAppleEvent?.attributeDescriptor(forKeyword: kAEQuitReason)?.enumCodeValue else { return .quit }
        return [kAELogOut, kAEReallyLogOut, kAEShowRestartDialog, kAEShowShutdownDialog, kAERestart, kAEShutDown].contains(why) ? .logout : .quit
    }
}

/// Lets the daemon's line handler reach the `Lifetime` built after it.
private final class LifetimeBox: @unchecked Sendable { var value: Lifetime? }

// Writing to a pipe whose reader died (a CLI child, a closed stderr) must be an error, not the app's death.
signal(SIGPIPE, SIG_IGN)

let application = NSApplication.shared
// Top-level code runs on the main thread; Swift 5 mode does not know that it is the main actor.
let delegate = MainActor.assumeIsolated { AppDelegate() }
application.delegate = delegate
application.setActivationPolicy(.accessory)

// A menu bar app has no window to close, so an orderly quit from outside arrives as SIGTERM. It goes through the run
// loop, not straight from this handler, so termination starts as the Quit item's does.
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
terminate.setEventHandler { RunLoop.main.perform(inModes: [.common]) { MainActor.assumeIsolated { delegate.quit() } } }
terminate.resume()
signal(SIGTERM, SIG_IGN)

application.run()
