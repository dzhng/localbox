import AppKit
import LocalboxAppCore
import LocalboxMenu
import SwiftUI
import UniformTypeIdentifiers

/// The status item and its popover. It holds the latest facts and what only the app knows (a quit in progress, a
/// failed action's message), draws them through `PopoverPresentation` and `PopoverView`, and runs each action as one
/// `BundledCLI` invocation. Opening the popover sets the facts watching; it never activates this app or another.
@MainActor
final class MenuBar: NSObject, NSPopoverDelegate {
    /// Set once `app paths` has answered; until then the sandbox actions have nothing to run.
    var cli: BundledCLI?
    /// Told whether the popover is open, so the facts long-poll only while someone looks.
    var watching: (Bool) -> Void = { _ in }
    var quit: () -> Void = {}

    private var facts: AppFacts?
    private var local = PopoverPresentation.Local()
    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    private let controller = NSHostingController(rootView: PopoverView(rows: PopoverPresentation.rows(nil), perform: { _ in }))
    private var outsideClicks: Any?
    private var escapeKey: Any?
    private(set) var rows = PopoverPresentation.rows(nil)

    override init() {
        super.init()
        // Transient closes it on a click elsewhere while this app is active; the monitors in `open` cover the usual
        // case, a menu bar app that never becomes active.
        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self
        controller.sizingOptions = [.preferredContentSize]
        popover.contentViewController = controller
        render()
    }

    /// Puts the status item in the menu bar (once a screen exists).
    func attach() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.target = self
        item.button?.action = #selector(toggle)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        statusItem = item
        render()
    }

    var isShown: Bool { popover.isShown }

    func factsChanged(_ facts: AppFacts) {
        self.facts = facts
        // A failed action's message lasts until the next facts.
        local.failures = [:]
        render()
    }

    func quitting(_ pending: [String]) { local.quitting = pending; render() }

    func couldNotStart() { local.couldNotStart = true; render() }

    @objc private func toggle() { if popover.isShown { popover.performClose(nil) } else { open() } }

    func open() {
        guard let button = statusItem?.button, !popover.isShown else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        outsideClicks = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated { self?.popover.performClose(nil) }
        }
        escapeKey = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return event }
            MainActor.assumeIsolated { self?.popover.performClose(nil) }
            return nil
        }
    }

    func popoverWillShow(_ notification: Notification) { watching(true) }

    func popoverDidClose(_ notification: Notification) {
        for monitor in [outsideClicks, escapeKey].compactMap({ $0 }) { NSEvent.removeMonitor(monitor) }
        outsideClicks = nil; escapeKey = nil
        watching(false)
    }

    private func render() {
        rows = PopoverPresentation.rows(facts, local)
        controller.rootView = PopoverView(rows: rows) { [weak self] action in self?.perform(action) }
        statusItem?.button?.image = StatusIcon.image(rows.statusIcon)
    }

    // MARK: - Actions

    func perform(_ action: PopoverAction) {
        switch action {
        case .copyName(let name):
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(name, forType: .string)
        case .quit:
            popover.performClose(nil)
            quit()
        case .settings:
            break  // slice 14's window
        case .sleep, .wake, .openLog:
            guard let cli, let arguments = action.arguments, let name = action.sandbox else { return }
            Task { [weak self] in
                do {
                    let output = try await cli.run(arguments)
                    if case .openLog = action { try Self.showLog(output, name: name) }
                } catch {
                    self?.failed(name, error)
                }
            }
        }
    }

    private func failed(_ name: String, _ error: Error) {
        local.failures[name] = (error as? CLIFailure)?.message ?? error.localizedDescription
        render()
    }

    /// `sandbox logs`' lines in a text file, opened by whatever opens plain text here.
    private static func showLog(_ output: Data, name: String) throws {
        let envelope = try JSONSerialization.jsonObject(with: output) as? [String: Any]
        let lines = (envelope?["result"] as? [String: Any])?["lines"] as? [String]
        let text = lines.map { $0.joined(separator: "\n") + "\n" } ?? String(decoding: output, as: UTF8.self)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Localbox Logs", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("\(name).log.txt")
        try Data(text.utf8).write(to: file, options: .atomic)
        if let viewer = NSWorkspace.shared.urlForApplication(toOpen: UTType.plainText) {
            NSWorkspace.shared.open([file], withApplicationAt: viewer, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(file)
        }
    }

    // MARK: - Test hooks

    /// `popover.open`, `popover.close` and `popover.perform` on the app socket, for probes; a development build with
    /// `LOCALBOX_APP_TEST_HOOKS=1` only. `perform` takes `{action: sleep|wake|copy_name|open_log, name}` and runs it
    /// only if the popover offers it for that sandbox now.
    func testHook(_ operation: String, _ params: [String: Any]) -> Result<[String: Any], AppSocketFailure> {
        switch operation {
        case "popover.open": open()
        case "popover.close": popover.performClose(nil)
        case "popover.perform":
            guard let kind = params["action"] as? String, let name = params["name"] as? String else {
                return .failure(AppSocketFailure(code: "invalid_input", message: "popover.perform takes {\"action\", \"name\"}"))
            }
            guard case .lists(let sandboxes, _, _) = rows.body,
                  let item = sandboxes.first(where: { $0.name == name })?.items.first(where: { $0.action.description == "\(kind) \(name)" && $0.enabled }) else {
                return .failure(AppSocketFailure(code: "conflict", message: "the popover offers no \(kind) for \(name)"))
            }
            perform(item.action)
        default:
            return .failure(AppSocketFailure(code: "unsupported", message: "no test hook \(operation)"))
        }
        var sandboxes: [String] = []
        if case .lists(let rows, _, _) = rows.body { sandboxes = rows.map { "\($0.name) \($0.detail)" } }
        return .success(["shown": popover.isShown, "title": rows.header.title, "sandboxes": sandboxes,
                         "failures": local.failures, "status_icon": rows.statusIcon.rawValue])
    }
}
