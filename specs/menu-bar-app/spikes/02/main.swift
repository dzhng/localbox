// Throwaway supervisor for spike 02 (specs/menu-bar-app/slices/02-vm-child-spike.md). Nothing here ships.
//
// An LSUIElement app that spawns one child (the host daemon) with a pipe on its stdin and its output appended to a
// log. On SIGTERM or an AppKit quit it sends SIGTERM to the child and waits for it with no deadline, then exits.
// Its configuration is a JSON file named by LOCALBOX_SPIKE_CONFIG (`open --env`), else /tmp/localbox-spike-02/config.json:
//   { "executable": "/path/localbox-hostd", "env": { "LOCALBOX_…": "…" }, "cwd": "/…", "log": "/…/hostd.log",
//     "state": "/…/state.json", "events": "/…/events.jsonl" }
// The child's environment is this app's own (what LaunchServices gave it) plus `env`.
import AppKit
import Darwin

struct Config: Decodable { let executable: String; let env: [String: String]; let cwd: String?; let log: String; let state: String; let events: String }

final class Supervisor: NSObject, NSApplicationDelegate {
    private let config: Config
    private let child = Process()
    private let stdinPipe = Pipe()
    private var shuttingDown: (reason: String, at: Date)?
    private var childExited = false
    private var signalSources: [DispatchSourceSignal] = []
    private var repliesToAppKit = false

    init(config: Config) { self.config = config }

    private func event(_ name: String, _ fields: [String: Any] = [:]) {
        var row = fields; row["event"] = name; row["at_ms"] = Int(Date().timeIntervalSince1970 * 1000); row["app_pid"] = Int(getpid())
        guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { return }
        if !FileManager.default.fileExists(atPath: config.events) { FileManager.default.createFile(atPath: config.events, contents: nil) }
        guard let handle = FileHandle(forWritingAtPath: config.events) else { return }
        handle.seekToEndOfFile(); handle.write(data); handle.write(Data("\n".utf8)); try? handle.close()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.beginShutdown(reason: number == SIGTERM ? "sigterm" : "sigint") }
            source.resume(); signalSources.append(source)
        }
        if !FileManager.default.fileExists(atPath: config.log) { FileManager.default.createFile(atPath: config.log, contents: nil) }
        guard let log = FileHandle(forWritingAtPath: config.log) else { event("spawn_failed", ["error": "cannot open \(config.log)"]); exit(70) }
        log.seekToEndOfFile()
        child.executableURL = URL(fileURLWithPath: config.executable)
        child.environment = ProcessInfo.processInfo.environment.merging(config.env) { _, given in given }
        if let cwd = config.cwd { child.currentDirectoryURL = URL(fileURLWithPath: cwd, isDirectory: true) }
        child.standardInput = stdinPipe; child.standardOutput = log; child.standardError = log
        child.terminationHandler = { [weak self] process in DispatchQueue.main.async { self?.childDidExit(process) } }
        do { try child.run() } catch { event("spawn_failed", ["error": "\(error)"]); exit(70) }
        let environment = ProcessInfo.processInfo.environment
        let state: [String: Any] = [
            "app_pid": Int(getpid()), "app_ppid": Int(getppid()), "child_pid": Int(child.processIdentifier), "executable": config.executable,
            "bundle_id": Bundle.main.bundleIdentifier ?? "", "bundle_path": Bundle.main.bundlePath,
            "ls_ui_element": Bundle.main.object(forInfoDictionaryKey: "LSUIElement") as? Bool ?? false,
            "activation_policy": NSApp.activationPolicy() == .accessory ? "accessory" : "other",
            "xpc_service_name": environment["XPC_SERVICE_NAME"] ?? "", "launched_at_ms": Int(Date().timeIntervalSince1970 * 1000),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys, .prettyPrinted]) {
            try? data.write(to: URL(fileURLWithPath: config.state), options: .atomic)
        }
        event("spawned", ["child_pid": Int(child.processIdentifier), "executable": config.executable])
    }

    /// An AppKit quit (Quit Apple event, logout): the same path as SIGTERM, and AppKit is told to wait.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if childExited { return .terminateNow }
        repliesToAppKit = true
        beginShutdown(reason: "appkit_quit")
        return .terminateLater
    }

    private func beginShutdown(reason: String) {
        guard shuttingDown == nil else { return }
        shuttingDown = (reason, Date())
        if childExited { event("shutdown", ["reason": reason, "child": "already_exited"]); exit(0) }
        event("sigterm_sent", ["reason": reason, "child_pid": Int(child.processIdentifier)])
        kill(child.processIdentifier, SIGTERM)
        // No deadline: the app exits when the child does (childDidExit).
    }

    private func childDidExit(_ process: Process) {
        childExited = true
        var fields: [String: Any] = ["child_pid": Int(process.processIdentifier), "status": Int(process.terminationStatus),
                                     "how": process.terminationReason == .exit ? "exit" : "signal"]
        if let shuttingDown {
            fields["reason"] = shuttingDown.reason; fields["waited_ms"] = Int(Date().timeIntervalSince(shuttingDown.at) * 1000)
            event("child_exited", fields)
            if repliesToAppKit { NSApp.reply(toApplicationShouldTerminate: true) } else { exit(0) }
        } else {
            // The child went away on its own: recorded, and the app stays up (this spike never restarts it).
            event("child_exited_unasked", fields)
        }
    }
}

let path = ProcessInfo.processInfo.environment["LOCALBOX_SPIKE_CONFIG"] ?? "/tmp/localbox-spike-02/config.json"
guard let data = FileManager.default.contents(atPath: path), let config = try? JSONDecoder().decode(Config.self, from: data) else {
    FileHandle.standardError.write(Data("LocalboxSpikeChild: no readable config at \(path)\n".utf8)); exit(78)
}
let app = NSApplication.shared
let supervisor = Supervisor(config: config)
app.delegate = supervisor
app.setActivationPolicy(.accessory)
app.run()
