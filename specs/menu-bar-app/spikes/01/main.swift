// Spike 01: throwaway LSUIElement app. On launch it registers itself as a
// login item, writes what happened as JSON, shows a status item and stays up.
// `Spike --unregister` and `Spike --status` run headless and exit.
import AppKit
import ServiceManagement

let outDir = ProcessInfo.processInfo.environment["SPIKE_OUT_DIR"] ?? "/tmp/localbox-spike-01"

func name(_ s: SMAppService.Status) -> String {
    switch s {
    case .notRegistered: return "notRegistered"
    case .enabled: return "enabled"
    case .requiresApproval: return "requiresApproval"
    case .notFound: return "notFound"
    @unknown default: return "unknown(\(s.rawValue))"
    }
}

/// Owners of every on-screen window that is not ours, as "owner@layer", unique.
func foreignWindows() -> [String] {
    let me = ProcessInfo.processInfo.processIdentifier
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    var seen = Set<String>()
    for w in list {
        guard let pid = w[kCGWindowOwnerPID as String] as? Int32, pid != me else { continue }
        let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
        let layer = w[kCGWindowLayer as String] as? Int ?? -1
        seen.insert("\(owner)@\(layer)")
    }
    return seen.sorted()
}

func write(_ object: [String: Any], _ file: String) {
    try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    try! data.write(to: URL(fileURLWithPath: "\(outDir)/\(file)"), options: .atomic)
}

let service = SMAppService.mainApp
let args = CommandLine.arguments

if args.contains("--status") {
    print(name(service.status))
    exit(0)
}
if args.contains("--unregister") {
    let before = name(service.status)
    var error: String? = nil
    do { try service.unregister() } catch let e { error = "\(e)" }
    print("{\"status_before\":\"\(before)\",\"status_after\":\"\(name(service.status))\",\"unregister_error\":\(error.map { "\"\($0)\"" } ?? "null")}")
    exit(0)
}

final class Delegate: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    func applicationDidFinishLaunching(_ note: Notification) {
        let env = ProcessInfo.processInfo.environment
        var record: [String: Any] = [
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "ppid": Int(getppid()),
            "bundle_path": Bundle.main.bundlePath,
            "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?",
            "env_keys": env.keys.sorted(),
            "foreign_windows_before": foreignWindows(),
            "status_before": name(service.status),
        ]
        var error: Any = NSNull()
        do { try service.register() } catch let e { error = "\(e)" }
        record["register_error"] = error
        record["status_after"] = name(service.status)
        record["screens"] = NSScreen.screens.count
        record["foreign_windows"] = foreignWindows()
        record["sampled_after_s"] = 0
        write(record, "launch.json")

        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "Spk"

        // A modal or banner can lag register(); sample again and overwrite.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            record["status_after_4s"] = name(service.status)
            record["foreign_windows"] = foreignWindows()
            record["sampled_after_s"] = 4
            record["status_item_visible"] = self.item.isVisible
            write(record, "launch.json")
        }
    }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
