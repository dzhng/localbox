import Foundation

/// What an install does to the rest of the app, in the order `UpdateCoordinator.install` runs it: the app's in
/// production (`main.swift`), fakes in tests.
public struct UpdateSteps: Sendable {
    /// `localbox app status`, read fresh at every attempt: blockers are decided from the facts, never from a copy.
    public var facts: @Sendable () async throws -> AppFacts
    /// `Lifetime.stop(.update)`: the connector, the image check, then the daemon, which hibernates its sandboxes.
    /// Returns once all have exited, however long that takes (no deadline of Sparkle's runs yet).
    public var stopChildren: @Sendable (_ hibernating: [String]) async -> Void
    /// `Lifetime.restart()`, after an update that stopped the children did not install.
    public var restartChildren: @Sendable () -> Void
    /// Returns once no `localbox` command holds the shared launch lock; calls `waiting` first if one does. Throws when
    /// the lock cannot be checked.
    public var waitForCommands: @Sendable (_ waiting: @escaping @Sendable () -> Void) async throws -> Void
    /// Ends the app at once: Sparkle replaces the bundle as soon as this process is gone.
    public var exit: @Sendable () -> Void

    public init(facts: @escaping @Sendable () async throws -> AppFacts, stopChildren: @escaping @Sendable ([String]) async -> Void,
                restartChildren: @escaping @Sendable () -> Void, waitForCommands: @escaping @Sendable (@escaping @Sendable () -> Void) async throws -> Void,
                exit: @escaping @Sendable () -> Void) {
        self.facts = facts; self.stopChildren = stopChildren; self.restartChildren = restartChildren; self.waitForCommands = waitForCommands; self.exit = exit
    }
}

/// The only owner of update gating (specs/menu-bar-app, slice 15). Sparkle (`SparkleDriver`) owns the feed, the
/// schedule, the signed download and the replacement; this decides when the app lets it install. Everything slow
/// happens before Sparkle's permit: Sparkle's helper takes the launch lock when it is granted and cancels unless the
/// app exits within 20 s, so hibernation must already be over.
///
/// `install(automatic:)` runs, in order:
/// 1. blockers: the built-in image being swapped in; for an automatic install only, sandboxes running while this Mac
///    cannot hibernate them (A12: a manual install proceeds and they restart);
/// 2. and 3. stop the connector, then the daemon, through `Lifetime` (reason `update`), and wait for it, unbounded;
/// 4. wait until no `localbox` command holds the shared launch lock;
/// 5. grant Sparkle's permit, and exit as soon as Sparkle authorizes the replacement.
/// A failure before 5 restarts the children and says why. There is no rollback.
@MainActor
public final class UpdateCoordinator {
    public enum Phase: String, Sendable { case unavailable, idle, disabled, checking, downloading, waiting, installing, failed }

    public static let hibernationBlocked = "Waiting: installing now would restart sandboxes. Unlock this Mac, or use Check for Updates in Settings to install anyway."
    public static let commandsRunning = "Waiting for localbox commands to finish."
    public static let imageInstalling = "Waiting for the built-in Linux image to finish installing."
    public static let upToDate = "You’re up to date."

    private let steps: UpdateSteps
    /// Told after every change of phase or message (the app logs them).
    public var changed: () -> Void = {}
    public private(set) var phase = Phase.unavailable
    public private(set) var message: String?
    public private(set) var version: String?
    public private(set) var enabled = false
    public var available: Bool { phase != .unavailable }

    /// Sparkle's side, set by `SparkleDriver`: start a person's check, apply the automatic preference, and whether
    /// Sparkle could start a check now.
    public var startCheck: () -> Void = {}
    public var preferenceChanged: (Bool) -> Void = { _ in }
    public var sparkleCanCheck: () -> Bool = { true }

    private enum Stage { case none, stopping, granted, authorized }
    private var stage = Stage.none
    /// Sparkle's reply for a downloaded update: install, or cancel the cycle.
    private var pending: (install: () -> Void, cancel: () -> Void)?
    /// A person asked for this install (`localbox update install`, or Check for Updates while one waits).
    private var requested = false
    private var attempt: Task<Void, Never>?
    private var childrenStopped = false
    /// Why Sparkle ended the cycle while the children were stopping, reported once they are back.
    private var abandonedBecause: String?

    public init(steps: UpdateSteps) {
        self.steps = steps
    }

    // MARK: - What the app socket and Settings read

    /// Settings' "Check for Updates" works while nothing is under way; while an update waits it installs it.
    public var canCheck: Bool {
        guard available, attempt == nil, stage == .none else { return false }
        if pending != nil { return true }
        return [.idle, .disabled, .failed].contains(phase) && sparkleCanCheck()
    }

    /// `AppFacts.update` (the CLI passes it on as it is) plus `state`, which `localbox update status` shows.
    public var snapshot: [String: Any] {
        ["available": true, "enabled": enabled, "can_check": canCheck, "state": phase.rawValue,
         "status": message as Any? ?? NSNull(), "version": version as Any? ?? NSNull()]
    }

    // MARK: - Requests

    /// `update.check`: installs the update that waits, else asks Sparkle to look now.
    public func check() {
        if pending != nil { requested = true; progress(); return }
        guard canCheck else { return }
        beginCheck()
    }

    /// `update.install`: installs the update that waits, else looks for one and installs what it finds.
    public func install() {
        requested = true
        if pending != nil { progress(); return }
        guard canCheck else { return }
        beginCheck()
    }

    /// Reports the check as started before Sparkle, which answers asynchronously, has said so: whoever asked reads
    /// `checking` at once, never the last cycle's answer. Sparkle ends every check it starts with a result.
    private func beginCheck() {
        checking()
        startCheck()
    }

    /// `update.set_automatic`. Turning it off withdraws an update that waits for automatic installation.
    public func setAutomatic(_ value: Bool) {
        guard available else { return }
        enabled = value
        preferenceChanged(value)
        if !value, !requested, stage == .none, let pending {
            self.pending = nil
            pending.cancel()
        }
        // An automatic install still waiting for commands is called off; one already stopping the children notices after.
        if !value, !requested, stage == .stopping { attempt?.cancel() }
        if phase == .idle || phase == .disabled { phase = value ? .idle : .disabled }
        publish()
    }

    /// Facts changed (a sandbox slept, the Mac unlocked): an update that waits on a blocker may go now.
    public func factsChanged() { progress() }

    // MARK: - Sparkle's cycle (SparkleDriver)

    public func setAvailability(enabled: Bool) {
        self.enabled = enabled
        phase = enabled ? .idle : .disabled
        publish()
    }

    public func checking() {
        guard stage == .none, pending == nil else { return }
        phase = .checking; message = "Checking for updates…"; version = nil
        publish()
    }

    public func downloading(version: String) {
        self.version = version
        guard stage == .none, pending == nil else { publish(); return }
        phase = .downloading; message = "Downloading Localbox \(version)…"
        publish()
    }

    /// The update is downloaded and checked; Sparkle waits for `install` or `cancel`.
    public func ready(install: @escaping () -> Void, cancel: @escaping () -> Void) {
        pending = (install, cancel)
        phase = .waiting; message = enabled || requested ? nil : "Localbox \(version ?? "") is ready. Check for Updates to install it."
        publish()
        progress()
    }

    /// Sparkle's helper holds the launch lock and asks for the last word: everything slow is already over, so grant it.
    public func installing(authorize: @escaping () -> Void) {
        guard stage == .granted else { return }
        stage = .authorized
        authorize()
    }

    /// Sparkle authorized the replacement: leave now, inside its 20 s window.
    public func willRelaunch() {
        guard stage == .authorized else { return }
        steps.exit()
    }

    /// The cycle ended without this app exiting for it: nothing to install, an error, or the helper refused.
    public func cycleFinished(error: String?, upToDate: Bool) {
        pending = nil; requested = false
        // An attempt still stopping the children restarts them itself once they are down (`abandon`); one waiting for
        // commands stops waiting.
        if stage == .stopping { abandonedBecause = error ?? "the installation stopped"; attempt?.cancel(); return }
        let wasInstalling = stage != .none
        stage = .none
        if wasInstalling { restartChildren() }
        if let error {
            fail(error)
        } else if wasInstalling {
            fail("the installation stopped")
        } else if phase != .failed {
            phase = enabled ? .idle : .disabled
            message = upToDate ? Self.upToDate : nil
            publish()
        }
    }

    /// Sparkle's own failure (a feed that does not verify, a download that fails), shown until the next cycle.
    public func fail(_ why: String) {
        phase = .failed
        message = "Update failed: \(why). Your current version is unchanged."
        publish()
    }

    // MARK: - The gate

    private func progress() {
        guard pending != nil, attempt == nil, stage == .none, enabled || requested else { return }
        let automatic = !requested
        attempt = Task { [weak self] in
            await self?.run(automatic: automatic)
            self?.attempt = nil
            self?.publish()
        }
    }

    /// Still wanted: Sparkle has not ended the cycle, and automatic installs were not turned off for an automatic one.
    private var wanted: Bool { pending != nil && (enabled || requested) }

    private func run(automatic: Bool) async {
        // 1. Blockers, from facts read now.
        let facts: AppFacts
        do { facts = try await steps.facts() } catch {
            wait("Waiting: Localbox could not read this Mac's state (\(Self.describe(error))).")
            return
        }
        guard wanted, !Task.isCancelled else { return }
        if facts.images.contains(where: { $0.name == "linux" && $0.phase == "installing" }) { wait(Self.imageInstalling); return }
        let hibernating = facts.hibernating
        let restarting = facts.hibernate != .available && !hibernating.isEmpty
        if automatic && restarting { wait(Self.hibernationBlocked); return }

        // 2 and 3. The connector, then the daemon, which saves every sandbox before it exits.
        stage = .stopping; childrenStopped = true
        phase = .installing
        let target = version.map { "Localbox \($0)" } ?? "the update"
        message = restarting ? "Installing \(target); sandboxes will restart, since this Mac can't hibernate them while it is locked."
            : hibernating.isEmpty ? "Getting ready to install \(target)…" : "Putting \(Self.count(hibernating.count)) to sleep to install \(target)…"
        publish()
        await steps.stopChildren(hibernating)
        guard wanted, !Task.isCancelled else { abandon(); return }

        // 4. No `localbox` command may run from the bundle Sparkle is about to replace.
        do {
            try await steps.waitForCommands { [weak self] in
                Task { @MainActor in
                    guard let self, self.stage == .stopping else { return }
                    self.message = Self.commandsRunning; self.publish()
                }
            }
        } catch {
            if !wanted || Task.isCancelled { abandon() } else { failBeforeGrant("the launch lock could not be checked (\(Self.describe(error)))") }
            return
        }
        guard wanted, !Task.isCancelled else { abandon(); return }

        // 5. The permit. Sparkle's helper now takes the launch lock and asks `installing(authorize:)`.
        stage = .granted
        message = "Installing \(target)…"
        publish()
        pending?.install()
    }

    private func wait(_ why: String) {
        phase = .waiting; message = why
        publish()
    }

    /// The install stopped being wanted while the children stopped: Sparkle ended the cycle, or automatic installs were
    /// turned off. The children come back; an update still waiting is withdrawn.
    private func abandon() {
        stage = .none
        restartChildren()
        let cancel = pending?.cancel
        pending = nil; requested = false
        if let why = abandonedBecause { abandonedBecause = nil; fail(why) } else { phase = enabled ? .idle : .disabled; message = nil; publish() }
        cancel?()
    }

    /// A step failed before the permit: the children come back and Sparkle's cycle ends; its next check tries again.
    private func failBeforeGrant(_ why: String) {
        stage = .none
        restartChildren()
        let cancel = pending?.cancel
        pending = nil; requested = false
        fail(why)
        cancel?()
    }

    private func restartChildren() {
        guard childrenStopped else { return }
        childrenStopped = false
        steps.restartChildren()
    }

    private func publish() { changed() }

    private static func count(_ n: Int) -> String { n == 1 ? "1 sandbox" : "\(n) sandboxes" }
    private static func describe(_ error: Error) -> String { (error as? CLIFailure)?.message ?? error.localizedDescription }
}
