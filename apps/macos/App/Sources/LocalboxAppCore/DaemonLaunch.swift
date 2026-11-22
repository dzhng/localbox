import Foundation

/// This Mac's Localbox paths as `localbox app paths --json` prints them (`machinePaths()` in packages/config, the one
/// definition). The app never derives a path itself (specs/menu-bar-app, invariant 4).
public struct AppPaths: Decodable, Equatable, Sendable {
    public let root: String, credentials: String, ipcToken: String, socket: String, hostdLock: String, appSocket: String
    public let sandboxes: String, operations: String, images: String, logs: String, binDir: String

    /// Asks the bundled CLI, which also creates the machine directories and the IPC token.
    public static func load(_ cli: BundledCLI) async throws -> AppPaths {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(AppPaths.self, from: try await cli.run(["app", "paths"]))
    }

    public func log(_ name: String) -> URL { URL(fileURLWithPath: logs).appendingPathComponent(name) }
}

/// The one place the daemon's arguments and environment are built.
public enum DaemonLaunch {
    /// `<bundle>/Contents/MacOS/localbox-hostd --supervised` with the app's environment plus every path it serves.
    /// The daemon runs this bundle's CLI for agent setup and pushes this bundle's guest agent into sandboxes.
    public static func make(bundle: URL, paths: AppPaths, environment: [String: String]) -> ChildLaunch {
        let resources = bundle.appendingPathComponent("Contents/Resources")
        var env = environment
        // The token is the file `app paths` made; an inherited literal would give the daemon a different one.
        env["LOCALBOX_IPC_TOKEN"] = nil
        env["LOCALBOX_SOCKET"] = paths.socket
        env["LOCALBOX_IPC_TOKEN_PATH"] = paths.ipcToken
        env["LOCALBOX_HOSTD_LOCK"] = paths.hostdLock
        env["LOCALBOX_SANDBOXES"] = paths.sandboxes
        env["LOCALBOX_OPERATIONS"] = paths.operations
        env["LOCALBOX_IMAGES"] = paths.images
        env["LOCALBOX_BIN_DIR"] = paths.binDir
        env["LOCALBOX_CLI"] = resources.appendingPathComponent("cli/localbox").path
        // A development bundle built without the guest agent has none; the daemon then leaves sandboxes' agents alone.
        let guestAgent = resources.appendingPathComponent("guest-agent")
        env["LOCALBOX_GUEST_AGENT"] = FileManager.default.fileExists(atPath: guestAgent.path) ? guestAgent.path : nil
        return ChildLaunch(executable: bundle.appendingPathComponent("Contents/MacOS/localbox-hostd"), arguments: ["--supervised"],
                           environment: env, log: paths.log("hostd.log"))
    }
}
