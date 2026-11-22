import Foundation

/// One thing a person can do from the popover. The sandbox actions are CLI invocations; Copy Name,
/// Settings and Quit are the app's own.
public enum PopoverAction: Hashable, Sendable, CustomStringConvertible {
    case copyName(String), sleep(String), wake(String), openLog(String), settings, quit

    /// `localbox <arguments>` for an action the CLI performs; nil for one the app does itself.
    public var arguments: [String]? {
        switch self {
        case .sleep(let name): return ["sandbox", "sleep", name]
        case .wake(let name): return ["sandbox", "start", name]
        case .openLog(let name): return ["sandbox", "logs", name]
        case .copyName, .settings, .quit: return nil
        }
    }

    /// The sandbox the action is about, if any; its failure is shown in that sandbox's row.
    public var sandbox: String? {
        switch self {
        case .copyName(let name), .sleep(let name), .wake(let name), .openLog(let name): return name
        case .settings, .quit: return nil
        }
    }

    public var description: String {
        switch self {
        case .copyName(let name): return "copy_name \(name)"
        case .sleep(let name): return "sleep \(name)"
        case .wake(let name): return "wake \(name)"
        case .openLog(let name): return "open_log \(name)"
        case .settings: return "settings"
        case .quit: return "quit"
        }
    }
}

/// Everything the popover draws, as words, fractions and actions. Views lay these out and never write copy of their
/// own, so every sentence the popover shows is here and is tested against the shared facts fixtures.
public struct PopoverRows: Equatable, Sendable {
    /// What a status dot or a line's colour says; the view picks the colour.
    public enum Tone: String, Equatable, Sendable { case good, neutral, busy, warning, failed }
    public enum StatusIcon: String, Equatable, Sendable { case normal, warning }

    public struct Item: Equatable, Sendable {
        public let title: String
        public let action: PopoverAction
        public let enabled: Bool
    }
    public struct Header: Equatable, Sendable {
        /// The account's email, or "Not signed in".
        public let title: String
        public let connection: String
        public let connectionTone: Tone
        /// Room left on this Mac; nil when the daemon cannot say.
        public let room: String?
        public let version: String
    }
    public struct Warning: Equatable, Sendable {
        public let message: String
        public let fix: String?
        /// "2 more warnings", when there are.
        public let more: String?
    }
    public struct Sandbox: Equatable, Sendable {
        public let id: String
        public let name: String
        public let os: String
        public let detail: String
        public let tone: Tone
        /// 0...1 while copying.
        public let progress: Double?
        /// Why the sandbox failed, or why the last action on it did.
        public let error: String?
        public let items: [Item]
    }
    public struct Image: Equatable, Sendable {
        public let name: String
        public let detail: String
        public let tone: Tone
        public let progress: Double?
        public let error: String?
    }
    public enum Body: Equatable, Sendable {
        /// `empty` stands in for the sandbox list when it has no rows; an empty `images` means no images section.
        case lists(sandboxes: [Sandbox], empty: String?, images: [Image])
        case stopping(title: String, pending: [String])
    }

    public let header: Header
    public let warning: Warning?
    public let sandboxesTitle: String
    public let imagesTitle: String
    public let body: Body
    /// Absent until there is a Settings window to open (once the app knows its paths).
    public let settings: Item?
    public let quit: Item
    public let statusIcon: StatusIcon
}

/// Turns `AppFacts` (and the little the app knows on its own) into `PopoverRows`. Pure.
public enum PopoverPresentation {
    /// What the app knows that the facts do not say.
    public struct Local: Equatable, Sendable {
        /// The sandboxes a quit in progress still waits for; set from `Lifetime` once the app stops reading facts.
        public var quitting: [String]?
        /// A failed action's message by sandbox name, shown in its row until the next facts arrive.
        public var failures: [String: String]
        /// Whether a Settings window exists to open.
        public var settingsAvailable: Bool
        /// The app could not learn its paths, so nothing is supervised.
        public var couldNotStart: Bool

        public init(quitting: [String]? = nil, failures: [String: String] = [:], settingsAvailable: Bool = false, couldNotStart: Bool = false) {
            self.quitting = quitting; self.failures = failures; self.settingsAvailable = settingsAvailable; self.couldNotStart = couldNotStart
        }
    }

    /// `facts` is nil until the first read answers.
    public static func rows(_ facts: AppFacts?, _ local: Local = .init()) -> PopoverRows {
        let pending = local.quitting ?? facts?.stopping?.pending
        let body: PopoverRows.Body
        if let pending {
            body = .stopping(title: stoppingTitle(pending.count), pending: pending)
        } else if let facts {
            body = .lists(sandboxes: facts.sandboxes.map { sandbox($0, failure: local.failures[$0.name]) },
                          empty: facts.sandboxes.isEmpty ? (facts.daemon == .running ? "No sandboxes on this Mac yet." : "Sandboxes show here once Localbox is running.") : nil,
                          images: facts.images.map(image))
        } else {
            body = .lists(sandboxes: [], empty: local.couldNotStart ? "Localbox couldn't start. Quit it and open it again." : "Loading…", images: [])
        }
        let warning = facts?.warnings.first.map { first -> PopoverRows.Warning in
            let more = (facts?.warnings.count ?? 1) - 1
            return .init(message: first.message, fix: first.fix, more: more == 0 ? nil : "\(more) more \(more == 1 ? "warning" : "warnings")")
        }
        return PopoverRows(
            header: header(facts, couldNotStart: local.couldNotStart, quitting: pending != nil),
            warning: pending == nil ? warning : nil,
            sandboxesTitle: "Sandboxes on this Mac",
            imagesTitle: "Images in progress",
            body: body,
            settings: local.settingsAvailable ? .init(title: "Settings…", action: .settings, enabled: pending == nil) : nil,
            quit: .init(title: "Quit", action: .quit, enabled: pending == nil),
            statusIcon: (facts?.warnings.isEmpty ?? !local.couldNotStart) ? .normal : .warning)
    }

    static func stoppingTitle(_ count: Int) -> String {
        count == 0 ? "Quitting…" : "Putting \(count) \(count == 1 ? "sandbox" : "sandboxes") to sleep…"
    }

    static func header(_ facts: AppFacts?, couldNotStart: Bool, quitting: Bool) -> PopoverRows.Header {
        guard let facts else {
            return .init(title: "Localbox", connection: couldNotStart ? "Couldn't start" : "Starting…", connectionTone: couldNotStart ? .failed : .busy, room: nil, version: "")
        }
        let title = facts.account.map { $0.email ?? "Signed in" } ?? "Not signed in"
        // While quitting, the connector is the first thing stopped; its last state would be stale.
        let connection: (String, PopoverRows.Tone) = quitting ? ("Quitting…", .busy) : connectionState(facts.connector.state)
        let room = facts.capacity.map { capacity in
            (["Free: \(capacity.cpusFree) of \(capacity.cpusTotal) CPUs",
              "\(memory(capacity.memoryFreeBytes, rounding: .down)) of \(memory(capacity.memoryTotalBytes, rounding: .toNearestOrAwayFromZero)) GB"]
             + (capacity.diskFreeBytes.map { ["\(disk($0)) disk"] } ?? [])).joined(separator: " · ")
        }
        return .init(title: title, connection: connection.0, connectionTone: connection.1, room: room,
                     version: facts.build == .dev ? "Version \(facts.version) (dev)" : "Version \(facts.version)")
    }

    static func connectionState(_ state: AppFacts.Connector.State) -> (String, PopoverRows.Tone) {
        switch state {
        case .connected: return ("Connected", .good)
        case .connecting: return ("Connecting…", .busy)
        case .signedOut: return ("Offline", .neutral)
        case .down: return ("Disconnected", .warning)
        }
    }

    /// Memory in whole GB (powers of 1024, as About This Mac counts it).
    static func memory(_ bytes: UInt64, rounding: FloatingPointRoundingRule) -> String {
        String(Int((Double(bytes) / 1_073_741_824).rounded(rounding)))
    }

    /// Disk in GB or TB (powers of 1000, as Finder counts it).
    static func disk(_ bytes: UInt64) -> String {
        let gigabytes = Double(bytes) / 1_000_000_000
        if gigabytes >= 1000 { return String(format: "%.1f TB", gigabytes / 1000) }
        return "\(Int(gigabytes.rounded(.down))) GB"
    }

    static func percent(_ progress: AppFacts.Progress?) -> Double? {
        guard let progress, progress.totalBytes > 0 else { return nil }
        return min(1, Double(progress.doneBytes) / Double(progress.totalBytes))
    }

    /// The nearest whole percent, except that unfinished work never reads 100%.
    static func percentText(_ fraction: Double) -> String {
        let percent = Int((fraction * 100).rounded())
        return "\(fraction < 1 ? min(percent, 99) : percent)%"
    }

    static func osName(_ os: String) -> String {
        switch os.lowercased() {
        case "linux": return "Linux"
        case "macos", "darwin": return "macOS"
        default: return os
        }
    }

    static func sandbox(_ sandbox: AppFacts.Sandbox, failure: String?) -> PopoverRows.Sandbox {
        let progress = sandbox.state == .copying ? percent(sandbox.progress) : nil
        let (state, tone): (String, PopoverRows.Tone) = switch sandbox.state {
        case .running: ("Running", .good)
        case .asleep: ("Asleep", .neutral)
        case .paused: ("Paused", .neutral)
        case .stopped: ("Stopped", .neutral)
        case .starting: ("Starting…", .busy)
        case .copying: (progress.map { "Copying \(percentText($0))" } ?? "Copying…", .busy)
        case .failed: ("Failed", .failed)
        }
        var items: [PopoverRows.Item] = [.init(title: "Copy Name", action: .copyName(sandbox.name), enabled: true)]
        switch sandbox.state {
        case .running: items.append(.init(title: "Sleep", action: .sleep(sandbox.name), enabled: true))
        case .asleep, .paused, .stopped: items.append(.init(title: "Wake", action: .wake(sandbox.name), enabled: true))
        case .starting, .copying, .failed: break
        }
        items.append(.init(title: "Open Log", action: .openLog(sandbox.name), enabled: true))
        return .init(id: sandbox.sandboxId, name: sandbox.name, os: sandbox.os, detail: "\(state) · \(osName(sandbox.os))", tone: tone,
                     progress: progress, error: failure ?? sandbox.error, items: items)
    }

    static func image(_ image: AppFacts.Image) -> PopoverRows.Image {
        let progress = percent(image.progress)
        let state: String
        switch image.state {
        case .building: state = "Building"
        case .copying: state = "Copying"
        case .downloading: state = "Downloading"
        case .failed: state = "Failed"
        }
        // "Copying 43%", as a sandbox's row says it; the phase follows unless it only repeats the state.
        let phase = image.phase.flatMap { $0.lowercased() == state.lowercased() ? nil : $0 }
        let detail = ([state + (progress.map { " \(percentText($0))" } ?? "")] + (phase.map { [$0] } ?? [])).joined(separator: " · ")
        return .init(name: image.name, detail: detail, tone: image.state == .failed ? .failed : .busy, progress: progress, error: image.error)
    }
}
