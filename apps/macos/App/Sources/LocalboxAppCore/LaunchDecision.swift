import Darwin
import Foundation

/// Whether this launch runs. One ordered rule decided from values only (ported from Bento's `LaunchDecision`); the
/// caller gathers the inputs and carries out the result. There is no move-to-Applications prompt
/// (specs/menu-bar-app, A10): a copy elsewhere runs, and `isInApplicationsFolder` feeds the warning that says so.
public enum LaunchDecision: Equatable, Sendable {
    case proceed
    /// Another release copy is running: this one activates nothing and exits.
    case handOff(pid_t)
    /// Sparkle relaunched this copy after installing it; the exiting copy may still be visible.
    case updateRelaunch

    public static let updateRelaunchArgument = "--localbox-update-relaunch"

    /// A release build carries a Sparkle feed; a development build has none.
    public static func isRelease(_ info: [String: Any]) -> Bool {
        (info["SUFeedURL"] as? String).map { !$0.isEmpty } ?? false
    }

    /// `running`: pids of other running release copies, this process excluded.
    public static func decide(isRelease: Bool, arguments: [String], running: [pid_t]) -> LaunchDecision {
        if arguments.contains(updateRelaunchArgument) { return .updateRelaunch }
        // A development build has its own bundle id and machine root, so it runs beside a release and beside another
        // dev copy (their daemons settle it: one per root).
        guard isRelease else { return .proceed }
        if let other = running.first { return .handOff(other) }
        return .proceed
    }

    /// The bundle's folder is `/Applications` or `<home>/Applications`, after symlinks: where the `localbox`
    /// command's launcher looks for the app.
    public static func isInApplicationsFolder(_ bundle: URL, home: URL) -> Bool {
        let folder = canonical(bundle.deletingLastPathComponent())
        return folder == canonical(URL(fileURLWithPath: "/Applications")) || folder == canonical(home.appendingPathComponent("Applications"))
    }

    private static func canonical(_ url: URL) -> String { url.standardizedFileURL.resolvingSymlinksInPath().path }
}
