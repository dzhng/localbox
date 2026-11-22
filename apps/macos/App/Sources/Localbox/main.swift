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
    /// This Mac's facts, read through the CLI; the popover and Settings set it watching while either shows.
    private var facts: FactsSource?
    private let menuBar = MenuBar()
    private var settings: SettingsWindow?
    private var popoverOpen = false, settingsOpen = false
    private var inApplications = false
    /// A quit that arrived before supervision started: the startup finishes by answering it instead.
    private var quitBeforeStart = false
    private var startupFinished = false
    private var replyPending = false
    /// Updates: nil in a build without Sparkle, or a bundle with no feed (a development build).
    private var updates: UpdateCoordinator?
    #if LOCALBOX_SPARKLE
    private var sparkle: SparkleDriver?
    #endif
    /// An update's stop in progress waits here for `Lifetime` to report the children gone.
    private var updateStopped: CheckedContinuation<Void, Never>?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let bundle = Bundle.main
        menuBar.quit = { [weak self] in self?.quit() }
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
        let image = ChildProcess(name: "image-ensure", launch: cli.imageEnsure(log: paths.log("image.log")), policy: .imageEnsure, backoff: .imageEnsure,
                                 restart: .untilSuccess, diagnostic: diagnostic)
        let lifetime = Lifetime(connector: connector, daemon: daemon, image: image) { [weak self] state in
            RunLoop.main.perform(inModes: [.common]) { MainActor.assumeIsolated { self?.lifetimeChanged(state) } }
        }
        lifetimeBox.value = lifetime
        self.lifetime = lifetime
        let loginItem = makeLoginItem()
        diagnostic(loginItem.launched(isRelease: isRelease, inApplications: inApplications))
        if CommandLine.arguments.contains(LaunchDecision.updateRelaunchArgument) {
            // Lifetime.start() below runs the built-in image's check, as every launch does, so the new release's image arrives.
            diagnostic("relaunched by an update into \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown")")
        }
        startUpdates(cli: cli, lifetime: lifetime)
        serveAppSocket(paths: paths, control: AppControl(
            identity: .init(version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown", isRelease: isRelease, inApplications: inApplications),
            children: { (daemon.state, connector.state) }, lifetime: { lifetime.state }, loginItem: loginItem, testHooks: testHooks(),
            updates: updateHook(), update: updateSnapshot()))
        lifetime.start()
        let menuBar = self.menuBar
        let settings = SettingsWindow(cli: cli, quiet: testHooksEnabled)
        self.settings = settings
        let facts = FactsSource(cli: cli, published: { [weak self] facts in
            RunLoop.main.perform(inModes: [.common]) { MainActor.assumeIsolated {
                menuBar.factsChanged(facts)
                settings.model.factsChanged(facts)
                self?.updates?.factsChanged()
            } }
        }, failed: { error in diagnostic("app status failed: \(error)") })
        self.facts = facts
        menuBar.cli = cli
        menuBar.watching = { [weak self] open in self?.popoverOpen = open; self?.watchingChanged() }
        settings.watching = { [weak self] open in self?.settingsOpen = open; self?.watchingChanged() }
        menuBar.openSettings = { [weak settings] in settings?.show() }
        popoverOpen = menuBar.isShown
        watchingChanged()
        facts.start()
        // A person's own choice; never on the relaunch after an update.
        if settings.model.showAtLaunch && !CommandLine.arguments.contains(LaunchDecision.updateRelaunchArgument) { settings.show() }
    }

    /// The facts are long-polled while the popover or Settings shows.
    private func watchingChanged() { facts?.setWatching(popoverOpen || settingsOpen) }

    private var testHooksEnabled: Bool { !isRelease && environment["LOCALBOX_APP_TEST_HOOKS"] == "1" }

    /// `SMAppService.mainApp`, except that a development build can stand in a fake (`LOCALBOX_APP_LOGIN_ITEM=fake`,
    /// as probes do), so a run on scratch roots never touches this account's login items.
    private func makeLoginItem() -> LoginItem {
        !isRelease && environment["LOCALBOX_APP_LOGIN_ITEM"] == "fake" ? .fake() : LoginItem(defaults: .standard)
    }

    /// A socket handler run on the main thread: the socket answers on its own queue, while the popover, Settings and
    /// the update coordinator live on the main thread.
    private func onMain(_ body: @escaping @MainActor @Sendable (AppDelegate, String, [String: Any]) -> Result<[String: Any], AppSocketFailure>) -> AppControl.Hook {
        return { [weak self] operation, params in
            nonisolated(unsafe) let params = params
            return DispatchQueue.main.sync { MainActor.assumeIsolated {
                guard let self else { return .failure(AppSocketFailure(code: "unsupported", message: "the app is going away")) }
                return body(self, operation, params)
            } }
        }
    }

    /// The popover's and Settings' test hooks on the app socket: a development build launched with
    /// `LOCALBOX_APP_TEST_HOOKS=1` only.
    private func testHooks() -> AppControl.Hook? {
        guard testHooksEnabled else { return nil }
        return onMain { app, operation, params in
            operation.hasPrefix("settings.") ? app.settingsHook(operation, params) : app.menuBar.testHook(operation, params)
        }
    }

    /// `settings.open`, `settings.close`, `settings.state` and `settings.set_open_at_login {enabled}`: the window as a
    /// person uses it (the switch runs `localbox app login-item` as the real one does), for probes.
    private func settingsHook(_ operation: String, _ params: [String: Any]) -> Result<[String: Any], AppSocketFailure> {
        guard let settings else { return .failure(AppSocketFailure(code: "conflict", message: "Settings is not ready yet")) }
        switch operation {
        case "settings.open": settings.show()
        case "settings.close": settings.close()
        case "settings.state": break
        case "settings.set_open_at_login":
            guard let enabled = params["enabled"] as? Bool else {
                return .failure(AppSocketFailure(code: "invalid_input", message: "settings.set_open_at_login takes {\"enabled\": true|false}"))
            }
            Task { await settings.model.setOpenAtLogin(enabled) }
        default:
            return .failure(AppSocketFailure(code: "unsupported", message: "no test hook \(operation)"))
        }
        let model = settings.model
        let account: String
        switch model.account {
        case .loading: account = "loading"
        case .signedOut: account = "signed_out"
        case .codeSent: account = "code_sent"
        case .signedIn: account = "signed_in"
        }
        return .success(["shown": settings.isShown, "account": account, "open_at_login": model.openAtLogin,
                         "login_item": model.loginItem.rawValue, "login_item_description": model.loginItemDescription,
                         "login_failure": model.loginFailure ?? NSNull(), "pending": model.openAtLoginPending != nil])
    }

    /// The CLI's way to the app's native powers. A socket that cannot be served (another copy answers on this root)
    /// costs only `localbox app`; supervision goes on.
    private func serveAppSocket(paths: AppPaths, control: AppControl) {
        let socket = AppSocket(path: paths.appSocket) { operation, params in control.handle(operation, params) }
        do { try socket.start(); appSocket = socket } catch { diagnostic("app socket unavailable: \(error)") }
    }

    private func startupFailed() {
        startupFinished = true
        menuBar.couldNotStart()
        if quitBeforeStart { answerTermination() }
    }

    private func lifetimeChanged(_ state: Lifetime.State) {
        switch state {
        case .running:
            // An update stopped the children and did not install: back to normal.
            diagnostic("running again")
            menuBar.quitting(nil, quiet: false)
            facts?.start()
        case .stopping(let reason, let pending, let quiet):
            // A read now could find the app socket gone and start another copy of the app.
            facts?.stop()
            diagnostic("stopping (\(reason.rawValue))\(pending.isEmpty ? "" : ": waiting for \(pending.joined(separator: ", "))")"
                       + (quiet ? "; the daemon has written nothing for \(Int(Lifetime.quietAfter)) s, still waiting" : ""))
            menuBar.quitting(pending, quiet: quiet)
        case .stopped:
            diagnostic("stopped")
            updateStopped?.resume(); updateStopped = nil
            answerTermination()
        }
    }

    // MARK: - Updates

    /// The coordinator and Sparkle, in a build that links Sparkle and a bundle with a feed; otherwise `update` stays null.
    private func startUpdates(cli: BundledCLI, lifetime: Lifetime) {
        #if LOCALBOX_SPARKLE
        let info = Bundle.main.infoDictionary ?? [:]
        guard LaunchDecision.isRelease(info) else { return }
        let lock = LaunchLock(info: info)
        let coordinator = UpdateCoordinator(steps: UpdateSteps(
            facts: { try AppFacts.decode(try await cli.run(["app", "status"])) },
            stopChildren: { [weak self] hibernating in
                await withCheckedContinuation { (stopped: CheckedContinuation<Void, Never>) in
                    RunLoop.main.perform(inModes: [.common]) { MainActor.assumeIsolated {
                        guard let self, lifetime.state == .running else { stopped.resume(); return }
                        self.updateStopped = stopped
                        lifetime.stop(.update, running: hibernating)
                    } }
                }
            },
            restartChildren: { [weak self] in
                RunLoop.main.perform(inModes: [.common]) { MainActor.assumeIsolated {
                    // A quit that arrived meanwhile ends the app instead.
                    guard let self, !self.replyPending else { return }
                    if !lifetime.restart() { diagnostic("the update did not install, and the children could not be restarted (\(lifetime.state))") }
                } }
            },
            waitForCommands: { waiting in
                guard let lock else { throw LaunchLockError("this bundle names no launch lock") }
                let called = CancelFlag()
                try await withTaskCancellationHandler {
                    try await Task.detached { try lock.waitUntilFree(cancelled: { called.isSet }, waiting: waiting) }.value
                } onCancel: { called.set() }
            },
            exit: { [weak self] in
                MainActor.assumeIsolated {
                    diagnostic("exiting for the update")
                    self?.appSocket?.stop(); self?.appSocket = nil
                    NSApplication.shared.terminate(nil)
                }
            }))
        var said = ""
        coordinator.changed = { [weak coordinator] in
            guard let coordinator else { return }
            let line = "update \(coordinator.phase.rawValue)\(coordinator.message.map { ": \($0)" } ?? "")"
            if line != said { said = line; diagnostic(line) }
        }
        sparkle = SparkleDriver(owner: coordinator, lock: lock, failed: { diagnostic($0) })
        if sparkle != nil { updates = coordinator; diagnostic("updates from \(info["SUFeedURL"] as? String ?? "")") }
        #endif
    }

    /// The app socket's `update.*` (answered on the main thread, where the coordinator lives); nil without updates.
    private func updateHook() -> AppControl.Hook? {
        guard updates != nil else { return nil }
        return onMain { app, operation, params in app.updateOperation(operation, params) }
    }

    /// `app.info`'s `update`.
    private func updateSnapshot() -> @Sendable () -> [String: Any]? {
        guard updates != nil else { return { nil } }
        return { [weak self] in
            let snapshot: [String: Any]? = DispatchQueue.main.sync { MainActor.assumeIsolated { self?.updates?.snapshot } }
            return snapshot
        }
    }

    /// `update.status`, `update.check`, `update.install`, `update.set_automatic {enabled}`; each answers the snapshot.
    private func updateOperation(_ operation: String, _ params: [String: Any]) -> Result<[String: Any], AppSocketFailure> {
        guard let updates else { return .failure(AppSocketFailure(code: "unsupported", message: "this Localbox does not update itself")) }
        switch operation {
        case "update.status": break
        case "update.check": updates.check()
        case "update.install": updates.install()
        case "update.set_automatic":
            guard let enabled = params["enabled"] as? Bool else {
                return .failure(AppSocketFailure(code: "invalid_input", message: "update.set_automatic takes {\"enabled\": true|false}"))
            }
            updates.setAutomatic(enabled)
        default:
            return .failure(AppSocketFailure(code: "unsupported", message: "this Localbox app does not answer \(operation)"))
        }
        return .success(updates.snapshot)
    }

    // MARK: - Status item

    /// The status item needs a screen. A development build can stub "no screens" (`LOCALBOX_APP_SCREENS=0`) to
    /// check that supervision does not depend on one.
    private func showStatusItemOnceAScreenExists() {
        let stubbed = !isRelease && environment["LOCALBOX_APP_SCREENS"] == "0"
        if !stubbed && !NSScreen.screens.isEmpty { menuBar.attach(); return }
        diagnostic("no screen; the status item waits for one")
        guard !stubbed else { return }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if !NSScreen.screens.isEmpty { self?.menuBar.attach() } }
        }
    }

    // MARK: - Quitting

    /// The popover's Quit and SIGTERM.
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

/// Set when an update is called off while it waits for commands; the waiting thread polls it.
private final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock(); private var value = false
    var isSet: Bool { lock.withLock { value } }
    func set() { lock.withLock { value = true } }
}

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
