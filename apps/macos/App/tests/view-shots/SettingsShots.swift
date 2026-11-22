import AppKit
import LocalboxAppCore
import LocalboxMenu
import SwiftUI

/// Draws the production SettingsView as Bento's `settings-view-shots.mjs` draws its own: a borderless 560 × 780
/// window far off screen, ordered behind everything, never activated, captured with `cacheDisplay`. The facts are the
/// shared fixtures, adjusted per state; form state (a code sent, a refusal) is reached through the model's own
/// intents over fake actions, so each shot is a state a person can get to.
enum SettingsShots {
    /// Fake actions: `facts()` answers the state's facts; `signIn` refuses as the relay does for a wrong code.
    struct Actions: SettingsActions {
        let current: AppFacts
        func facts() async throws -> AppFacts { current }
        func sendCode(email: String) async throws {}
        func signIn(email: String, code: String) async throws {
            throw CLIFailure(code: "cli_failed", message: "verification code is invalid or expired")
        }
        func signOut() async throws {}
        func setAgentSetup(_ enabled: Bool) async throws {}
        func setOpenAtLogin(_ enabled: Bool) async throws {}
        func setAutomaticUpdates(_ enabled: Bool) async throws {}
        func checkForUpdates() async throws {}
    }

    struct State {
        let name: String
        let fixture: String
        var showAtLaunch = false
        var change: (inout [String: Any]) -> Void = { _ in }
        var form: @MainActor (SettingsModel) async -> Void = { _ in }
    }

    static let states: [State] = [
        State(name: "signed-out", fixture: "signed-out"),
        State(name: "code-sent", fixture: "signed-out", form: { model in
            model.email = "dev@example.com"
            await model.sendCode()
        }),
        State(name: "code-refused", fixture: "signed-out", form: { model in
            model.email = "dev@example.com"
            await model.sendCode()
            model.code = "123465"
            await model.signIn()
        }),
        State(name: "signed-in", fixture: "idle"),
        State(name: "login-item-approval", fixture: "idle", change: { facts in
            facts["open_at_login"] = "requires_approval"
        }),
        State(name: "agent-setup-attention", fixture: "idle", change: { facts in
            facts["agent_setup"] = ["enabled": true, "command": "missing", "skill": "installed"]
        }),
        // The same switches as Bento's `manual` reference shot (its window shown at launch, no login item), so the
        // compare's only variable is the product's name.
        State(name: "manual-updates", fixture: "idle", showAtLaunch: true, change: { facts in
            facts["open_at_login"] = "disabled"
        }),
        // What slice 15 turns on: the rows fed by `AppFacts.update`.
        State(name: "updates", fixture: "idle", change: { facts in
            facts["update"] = ["available": true, "enabled": true, "can_check": true, "status": "You’re up to date."]
        }),
    ]

    /// Slice 15's update rows, named and switched as Bento's `settings-view-shots.mjs` states are (Bento's `failure` is
    /// `failed` here), with the same window-at-launch and login-item switches as `manual-updates`, so a compare against
    /// Bento's same-named shot changes only the product's name, the first footer sentence and Localbox's own status
    /// lines. "Waiting" is the A12 blocker, where Check for Updates installs anyway (so it stays enabled).
    static let updateStates: [State] = [
        update("enabled", ["enabled": true, "can_check": true]),
        update("disabled", ["enabled": false, "can_check": true]),
        update("checking", ["enabled": false, "can_check": false, "status": "Checking for updates…"]),
        update("up-to-date", ["enabled": false, "can_check": true, "status": UpdateCoordinator.upToDate]),
        update("waiting", ["enabled": true, "can_check": true, "status": UpdateCoordinator.hibernationBlocked, "version": "0.2.1"]),
        update("failed", ["enabled": true, "can_check": true, "status": "Update failed: the update feed is improperly signed and could not be validated. Your current version is unchanged."]),
    ]

    private static func update(_ name: String, _ update: [String: Any]) -> State {
        State(name: name, fixture: "idle", showAtLaunch: true, change: { facts in
            facts["open_at_login"] = "disabled"
            facts["update"] = update.merging(["available": true]) { current, _ in current }
        })
    }

    /// Runs the main run loop until `work` has finished (the model's intents are async; the views need the loop).
    @MainActor static func settle(_ work: @escaping @MainActor () async -> Void) {
        var done = false
        Task { @MainActor in await work(); done = true }
        while !done { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    }

    @MainActor static func render(fixtures: URL, output: URL, states: [State]) throws {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        var report: [[String: Any]] = []
        for (theme, appearanceName) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            for state in states {
                var object = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("\(state.fixture).json"))) as! [String: Any]
                state.change(&object)
                let facts = try AppFacts.decode(try JSONSerialization.data(withJSONObject: object))
                let model = SettingsModel(actions: Actions(current: facts), showAtLaunch: state.showAtLaunch, remember: { _ in })
                settle { await model.refresh(); await state.form(model) }
                let content = NSHostingView(rootView: SettingsView(model: model, openLoginItems: {}))
                content.sizingOptions = []
                content.appearance = NSAppearance(named: appearanceName)
                let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 560, height: 780),
                                      styleMask: .borderless, backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = content
                window.appearance = content.appearance
                window.orderBack(nil)
                RunLoop.current.run(until: Date().addingTimeInterval(0.6))
                content.layoutSubtreeIfNeeded()
                let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds)!
                content.cacheDisplay(in: content.bounds, to: bitmap)
                try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("\(theme)-\(state.name).png"))
                window.orderOut(nil)
                window.close()
                report.append(["state": state.name, "appearance": theme, "width": bitmap.pixelsWide, "height": bitmap.pixelsHigh,
                               "account": "\(model.account)", "failure": model.accountFailure ?? NSNull()])
            }
        }
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: output.appendingPathComponent("shots.json"))
    }
}
