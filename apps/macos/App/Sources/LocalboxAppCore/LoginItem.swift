import Foundation
import ServiceManagement

/// Whether the app opens at login, as `login_item.get` reports it.
public enum LoginItemState: String, Sendable {
    case enabled, disabled
    /// Registered, but the user must allow it in System Settings › General › Login Items (spike 01, fallback 2). A
    /// state the CLI shows, not an error.
    case requiresApproval = "requires_approval"
    /// macOS cannot find the app to register (a bundle it does not know).
    case notFound = "not_found"
}

/// What `LoginItem` registers through: `SMAppService.mainApp` in the app, a fake in tests and probes, so nothing but
/// the app itself ever touches this account's login items.
public protocol LoginItemDriver: Sendable {
    var state: LoginItemState { get }
    func register() throws
    func unregister() throws
}

/// The real login item: this bundle, matched by its bundle id (spike 01), so a release and a dev build are separate
/// items and a replaced bundle keeps its registration.
public struct MainAppLoginItem: LoginItemDriver {
    public init() {}
    public var state: LoginItemState {
        switch SMAppService.mainApp.status {
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notFound: return .notFound
        case .notRegistered: return .disabled
        @unknown default: return .disabled
        }
    }
    public func register() throws { try SMAppService.mainApp.register() }
    public func unregister() throws { try SMAppService.mainApp.unregister() }
}

/// A login item that lives only in memory, starting disabled: what a development build uses when asked to
/// (`LOCALBOX_APP_LOGIN_ITEM=fake`), and what the tests drive. `approval` makes a register land in
/// `requires_approval`, as a Mac that wants the user's say does.
public final class FakeLoginItem: LoginItemDriver, @unchecked Sendable {
    private let lock = NSLock()
    private var current: LoginItemState
    private let approval: Bool
    public init(state: LoginItemState = .disabled, approval: Bool = false) { current = state; self.approval = approval }
    public var state: LoginItemState { lock.withLock { current } }
    public func register() throws { lock.withLock { current = approval ? .requiresApproval : .enabled } }
    public func unregister() throws { lock.withLock { current = .disabled } }
}

private final class MemoryFlag: @unchecked Sendable { var value = false }

/// Open at login, on by default (brief, decision 5): the first launch of a release build in an Applications folder
/// registers once and remembers that it did, so a user who turns it off (here, in Settings or in System Settings) is
/// never turned back on. A development build, or a copy outside an Applications folder, registers only when asked.
public final class LoginItem: @unchecked Sendable {
    /// The defaults key that remembers the one automatic registration (or an explicit choice, which ends it too).
    public static let initializedKey = "loginItemInitialized"

    private let driver: LoginItemDriver
    private let remembered: () -> Bool
    private let remember: () -> Void
    private let lock = NSLock()

    /// `remembered` and `remember` read and set the initialized flag; the app keeps it in its defaults.
    public init(driver: LoginItemDriver, remembered: @escaping () -> Bool, remember: @escaping () -> Void) {
        self.driver = driver; self.remembered = remembered; self.remember = remember
    }

    /// The app's own: `SMAppService.mainApp`, its flag in `defaults` under `initializedKey`.
    public convenience init(driver: LoginItemDriver = MainAppLoginItem(), defaults: UserDefaults) {
        self.init(driver: driver, remembered: { defaults.bool(forKey: Self.initializedKey) }, remember: { defaults.set(true, forKey: Self.initializedKey) })
    }

    /// A `FakeLoginItem` with its flag in memory: a development build's stand-in for probes, gone when the app quits.
    public static func fake() -> LoginItem {
        let flag = MemoryFlag()
        return LoginItem(driver: FakeLoginItem(), remembered: { flag.value }, remember: { flag.value = true })
    }

    public var state: LoginItemState { driver.state }

    /// At launch. Returns what it did, for the app's log. A failed registration is not remembered, so the next
    /// launch tries again.
    @discardableResult
    public func launched(isRelease: Bool, inApplications: Bool) -> String {
        lock.withLock {
            guard isRelease else { return "a development build registers no login item unless asked" }
            guard inApplications else { return "not in an Applications folder, so no login item yet" }
            guard !remembered() else { return "login item \(driver.state.rawValue)" }
            // An item already enabled or awaiting approval (a reinstall) is only remembered.
            do {
                if driver.state == .disabled || driver.state == .notFound { try driver.register() }
                remember()
                return "first launch: login item \(driver.state.rawValue)"
            } catch {
                return "first launch: the login item could not be registered (\(error.localizedDescription)); trying again next launch"
            }
        }
    }

    /// `login_item.set`: an explicit choice, remembered so no later launch overrides it.
    public func set(enabled: Bool) throws -> LoginItemState {
        try lock.withLock {
            let now = driver.state
            if enabled && now != .enabled && now != .requiresApproval { try driver.register() }
            if !enabled && (now == .enabled || now == .requiresApproval) { try driver.unregister() }
            remember()
            return driver.state
        }
    }
}
