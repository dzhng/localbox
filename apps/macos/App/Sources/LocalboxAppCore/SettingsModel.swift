import Combine
import Foundation

/// Everything Settings changes, one CLI invocation each. `CLISettingsActions` is
/// the app's; tests pass a fake CLI to it, or a fake of this protocol.
public protocol SettingsActions: Sendable {
    /// `localbox app status`: the facts Settings shows, read when the window opens and after every change.
    func facts() async throws -> AppFacts
    /// `localbox login --email E`: emails a sign-in code; the CLI answers `code_sent`.
    func sendCode(email: String) async throws -> LoginStep
    /// `localbox login --email E --code C`: signs this Mac in; the CLI answers `signed_in`.
    func signIn(email: String, code: String) async throws -> LoginStep
    /// `localbox logout`: signs this Mac out and removes it from the account.
    func signOut() async throws
    /// `localbox agents setup on|off`.
    func setAgentSetup(_ enabled: Bool) async throws
    /// `localbox app login-item on|off`.
    func setOpenAtLogin(_ enabled: Bool) async throws
    /// `localbox update automatic on|off` (the row shows only once `AppFacts.update` says so).
    func setAutomaticUpdates(_ enabled: Bool) async throws
    /// `localbox update check`: installs an update that waits, else checks now.
    func checkForUpdates() async throws
}

/// What `localbox login --json` answers for each step (`apps/cli/src/index.ts`): `{state: "code_sent", email}` or
/// `{state: "signed_in", email, account_name, machine_name, machine_count}`. Refusals are the CLI's failure envelope,
/// which `BundledCLI` turns into a `CLIFailure`.
public enum LoginStep: Equatable, Sendable {
    case codeSent(email: String)
    case signedIn(email: String, machineName: String)

    public static func decode(_ data: Data) throws -> LoginStep {
        struct Answer: Decodable { let state: String; let email: String; let machineName: String? }
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        if let answer = try? decoder.decode(Answer.self, from: data) {
            if answer.state == "code_sent" { return .codeSent(email: answer.email) }
            if answer.state == "signed_in", let machine = answer.machineName { return .signedIn(email: answer.email, machineName: machine) }
        }
        throw CLIFailure(code: "cli_failed", message: "localbox login gave an answer Settings does not know: \(String(decoding: data.prefix(200), as: UTF8.self))")
    }
}

/// The production `SettingsActions`: each one is `localbox <arguments> --json` through `BundledCLI`.
public struct CLISettingsActions: SettingsActions {
    public typealias Run = @Sendable (_ arguments: [String]) async throws -> Data
    private let run: Run

    public init(run: @escaping Run) { self.run = run }
    public init(cli: BundledCLI) { self.init(run: { try await cli.run($0) }) }

    public func facts() async throws -> AppFacts { try AppFacts.decode(try await run(["app", "status"])) }
    public func sendCode(email: String) async throws -> LoginStep { try LoginStep.decode(try await run(["login", "--email", email])) }
    public func signIn(email: String, code: String) async throws -> LoginStep { try LoginStep.decode(try await run(["login", "--email", email, "--code", code])) }
    public func signOut() async throws { _ = try await run(["logout"]) }
    public func setAgentSetup(_ enabled: Bool) async throws { _ = try await run(["agents", "setup", enabled ? "on" : "off"]) }
    public func setOpenAtLogin(_ enabled: Bool) async throws { _ = try await run(["app", "login-item", enabled ? "on" : "off"]) }
    public func setAutomaticUpdates(_ enabled: Bool) async throws { _ = try await run(["update", "automatic", enabled ? "on" : "off"]) }
    public func checkForUpdates() async throws { _ = try await run(["update", "check"]) }
}

/// The Settings window's state: the facts the CLI reports plus what is being typed or asked for, and the intents
/// its controls call. It reads when the window opens and again after every
/// change, and a change that fails shows the CLI's message without losing what was typed. The one setting that is
/// not CLI state is the app's own "Show this window when Localbox starts" (default off).
@MainActor
public final class SettingsModel: ObservableObject {
    /// The defaults key for "Show this window when Localbox starts".
    public static let showAtLaunchKey = "showSettingsAtLaunch"

    public enum Account: Equatable, Sendable {
        /// No facts yet.
        case loading
        case signedOut
        /// A code was emailed to this address; the person types it next.
        case codeSent(email: String)
        /// `email` is nil for a credential written before the CLI recorded it.
        case signedIn(email: String?, machineName: String)
    }

    /// What the Account section is waiting on.
    public enum Busy: Equatable, Sendable { case sendingCode, signingIn, signingOut }

    @Published public private(set) var facts: AppFacts?
    @Published public var email = ""
    @Published public var code = ""
    @Published public private(set) var codeSentTo: String?
    @Published public private(set) var busy: Busy?
    @Published public private(set) var accountFailure: String?
    /// A switch's requested value while its command runs, so it moves at once.
    @Published public private(set) var agentSetupPending: Bool?
    @Published public private(set) var agentSetupFailure: String?
    @Published public private(set) var openAtLoginPending: Bool?
    @Published public private(set) var loginFailure: String?
    @Published public private(set) var updateFailure: String?
    @Published public var showAtLaunch: Bool { didSet { if showAtLaunch != oldValue { remember(showAtLaunch) } } }

    private let actions: SettingsActions
    private let remember: (Bool) -> Void

    /// `showAtLaunch` and `remember` are the app's own preference.
    public init(actions: SettingsActions, facts: AppFacts? = nil, showAtLaunch: Bool, remember: @escaping (Bool) -> Void) {
        self.actions = actions; self.facts = facts; self.showAtLaunch = showAtLaunch; self.remember = remember
    }

    /// The app's: the preference kept in `defaults`, off until a person turns it on.
    public convenience init(actions: SettingsActions, defaults: UserDefaults) {
        self.init(actions: actions, showAtLaunch: defaults.bool(forKey: Self.showAtLaunchKey),
                  remember: { defaults.set($0, forKey: Self.showAtLaunchKey) })
    }

    // MARK: - State

    public var account: Account {
        guard let facts else { return .loading }
        if let account = facts.account { return .signedIn(email: account.email, machineName: account.machineName) }
        if let codeSentTo { return .codeSent(email: codeSentTo) }
        return .signedOut
    }

    public var canSendCode: Bool { busy == nil && !trimmedEmail.isEmpty }
    public var canSignIn: Bool { busy == nil && !code.trimmingCharacters(in: .whitespaces).isEmpty }

    public var setUpAgents: Bool { agentSetupPending ?? facts?.agentSetup.enabled ?? false }
    public var agentSummary: String { facts.map { Self.agentSummary($0.agentSetup) } ?? "" }

    public var loginItem: AppFacts.OpenAtLogin { facts?.openAtLogin ?? .disabled }
    /// On while registered, including while macOS waits for the person's approval.
    public var openAtLogin: Bool { openAtLoginPending ?? [.enabled, .requiresApproval].contains(loginItem) }
    public var loginItemDescription: String { Self.loginItemDescription(loginItem) }
    /// Only when macOS keeps the decision for a person, or does not know this copy, is the Login Items pane needed.
    public var needsLoginItemsSettings: Bool { [.requiresApproval, .notFound].contains(loginItem) }

    public var updates: AppFacts.Update? { facts?.update.flatMap { $0.available ? $0 : nil } }

    // MARK: - Reading

    /// New facts from the app's long poll, while the window is open.
    public func factsChanged(_ facts: AppFacts) { apply(facts) }

    /// Reads the facts now: when the window opens, and after every change.
    public func refresh() async {
        do { apply(try await actions.facts()) } catch {}
    }

    private func apply(_ facts: AppFacts) {
        self.facts = facts
        // Signed in (here or from the terminal): the code flow is over.
        if facts.account != nil, codeSentTo != nil { codeSentTo = nil; code = "" }
    }

    // MARK: - Account

    public func sendCode() async {
        guard canSendCode else { return }
        let email = trimmedEmail
        await account(.sendingCode) { self.follow(try await self.actions.sendCode(email: email)) }
    }

    public func signIn() async {
        guard canSignIn, let email = codeSentTo else { return }
        let code = self.code.trimmingCharacters(in: .whitespaces)
        await account(.signingIn) { self.follow(try await self.actions.signIn(email: email, code: code)) }
    }

    /// The code flow follows the CLI's answer: a code sent waits for it to be typed; signed in ends the flow (the
    /// account itself comes from the facts read next).
    private func follow(_ step: LoginStep) {
        code = ""
        switch step {
        case .codeSent(let email): codeSentTo = email
        case .signedIn: codeSentTo = nil
        }
    }

    /// Back to the email field, keeping what was typed there.
    public func useDifferentEmail() {
        guard busy == nil else { return }
        codeSentTo = nil; code = ""; accountFailure = nil
    }

    /// After the window's confirmation.
    public func signOut() async {
        await account(.signingOut) { try await self.actions.signOut() }
    }

    private func account(_ what: Busy, _ body: () async throws -> Void) async {
        guard busy == nil else { return }
        busy = what; accountFailure = nil
        defer { busy = nil }
        do { try await body() } catch { accountFailure = Self.message(error) }
        await refresh()
    }

    // MARK: - General

    public func setAgentSetup(_ enabled: Bool) async {
        guard agentSetupPending == nil, enabled != setUpAgents else { return }
        agentSetupPending = enabled; agentSetupFailure = nil
        do { try await actions.setAgentSetup(enabled) } catch { agentSetupFailure = Self.message(error) }
        await refresh()
        agentSetupPending = nil
    }

    /// Registration is the app's (through `localbox app login-item`); this asks for a change and reads back the answer.
    public func setOpenAtLogin(_ enabled: Bool) async {
        guard openAtLoginPending == nil, enabled != openAtLogin else { return }
        openAtLoginPending = enabled; loginFailure = nil
        do { try await actions.setOpenAtLogin(enabled) } catch { loginFailure = Self.message(error) }
        await refresh()
        openAtLoginPending = nil
    }

    public func setAutomaticUpdates(_ enabled: Bool) async {
        guard let updates, enabled != updates.enabled else { return }
        updateFailure = nil
        do { try await actions.setAutomaticUpdates(enabled) } catch { updateFailure = Self.message(error) }
        await refresh()
    }

    public func checkForUpdates() async {
        guard let updates, updates.canCheck else { return }
        updateFailure = nil
        do { try await actions.checkForUpdates() } catch { updateFailure = Self.message(error) }
        await refresh()
    }

    // MARK: - Words

    /// The "Set up my agents" row's line, from the command's and the skill's states.
    public static func agentSummary(_ setup: AppFacts.AgentSetup) -> String {
        if setup.command == "installed" && setup.skill == "installed" { return "localbox command + skill, kept current. All good ✓" }
        let command: String
        switch setup.command {
        case "installed": command = "Command installed"
        case "missing": command = "Command not installed"
        case "different": command = "A different command is at ~/.local/bin/localbox"
        case "not_in_applications": command = "Command waits for Localbox to be in Applications"
        case "not_app_managed": command = "Command unavailable in this build"
        default: command = "Command needs attention"
        }
        let skill: String
        switch setup.skill {
        case "installed": skill = "skill installed"
        case "updating": skill = "skill updating"
        case "needs_attention": skill = "skill needs attention"
        default: skill = "skill not installed"
        }
        return "\(command); \(skill)."
    }

    /// The "Open at login" row's line.
    public static func loginItemDescription(_ state: AppFacts.OpenAtLogin) -> String {
        switch state {
        case .enabled: return "Localbox opens when you log in."
        case .requiresApproval: return "Waiting for your approval in Login Items settings."
        case .disabled: return "Localbox does not open when you log in."
        case .notFound: return "macOS does not recognise this copy of Localbox as a login item."
        }
    }

    private var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The CLI's own message, as a sentence.
    static func message(_ error: Error) -> String {
        let text = (error as? CLIFailure)?.message ?? error.localizedDescription
        guard let first = text.first else { return text }
        let sentence = first.uppercased() + text.dropFirst()
        return sentence.hasSuffix(".") ? sentence : sentence + "."
    }
}
