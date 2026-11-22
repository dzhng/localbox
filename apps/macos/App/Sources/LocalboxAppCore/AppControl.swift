import Foundation

/// The operations the app socket answers (specs/menu-bar-app, slice 09): `app.info`, `login_item.get` and
/// `login_item.set`. `update.*` is slice 15's. A development build launched with test hooks also answers `popover.*`
/// and `settings.*` (probes open the popover and Settings and use their controls through them). Anything else is `unsupported`, so a CLI newer than
/// the running app says so instead of guessing.
public final class AppControl: Sendable {
    /// What `app.info` reports about this copy, fixed at launch.
    public struct Identity: Sendable {
        public let version: String, isRelease: Bool, inApplications: Bool
        public init(version: String, isRelease: Bool, inApplications: Bool) { self.version = version; self.isRelease = isRelease; self.inApplications = inApplications }
    }

    private let identity: Identity
    private let children: @Sendable () -> (daemon: ChildState, connector: ChildState)
    private let lifetime: @Sendable () -> Lifetime.State
    private let loginItem: LoginItem
    public typealias Hook = @Sendable (_ operation: String, _ params: [String: Any]) -> Result<[String: Any], AppSocketFailure>
    private let testHooks: Hook?

    public init(identity: Identity, children: @escaping @Sendable () -> (daemon: ChildState, connector: ChildState),
                lifetime: @escaping @Sendable () -> Lifetime.State, loginItem: LoginItem, testHooks: Hook? = nil) {
        self.identity = identity; self.children = children; self.lifetime = lifetime; self.loginItem = loginItem; self.testHooks = testHooks
    }

    public func handle(_ operation: String, _ params: [String: Any]) -> Result<[String: Any], AppSocketFailure> {
        if operation.hasPrefix("popover.") || operation.hasPrefix("settings."), let testHooks { return testHooks(operation, params) }
        switch operation {
        case "app.info": return .success(info())
        case "login_item.get": return .success(["state": loginItem.state.rawValue])
        case "login_item.set":
            guard let enabled = params["enabled"] as? Bool else { return .failure(AppSocketFailure(code: "invalid_input", message: "login_item.set takes {\"enabled\": true|false}")) }
            do { return .success(["state": try loginItem.set(enabled: enabled).rawValue]) }
            catch { return .failure(AppSocketFailure(code: "internal", message: "the login item could not be \(enabled ? "registered" : "removed"): \(error.localizedDescription)")) }
        default:
            return .failure(AppSocketFailure(code: "unsupported", message: "this Localbox app (\(identity.version)) does not answer \(operation)"))
        }
    }

    private func info() -> [String: Any] {
        let (daemon, connector) = children()
        var stopping: Any = NSNull()
        if case .stopping(let reason, let pending) = lifetime() { stopping = ["reason": reason.rawValue, "pending": pending] }
        return [
            "version": identity.version, "build": identity.isRelease ? "release" : "dev", "in_applications": identity.inApplications,
            "children": ["daemon": daemon.rawValue, "connector": connector.rawValue], "stopping": stopping,
        ]
    }
}
