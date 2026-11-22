import AppKit
import LocalboxAppCore
import LocalboxMenu
import ServiceManagement
import SwiftUI

/// The Settings window: an ordinary window hosting `SettingsView`, built as Bento's `makeWindow` builds its own
/// (560 pt wide, as tall as the screen allows up to 780, its frame restored only if still on a screen). Opening it
/// reads the facts and tells the app it is open, so they are long-polled while it shows.
@MainActor
final class SettingsWindow: NSObject, NSWindowDelegate {
    static let title = "Localbox Settings"
    /// Where the window was left, as `NSWindow.frameDescriptor`.
    static let frameKey = "settingsFrame"

    let model: SettingsModel
    /// Told when the window opens and closes.
    var watching: (Bool) -> Void = { _ in }
    private let defaults: UserDefaults
    /// A probe's launch orders the window in behind everything instead of activating the app.
    private let quiet: Bool
    private var window: NSWindow?

    init(cli: BundledCLI, defaults: UserDefaults = .standard, quiet: Bool) {
        self.defaults = defaults; self.quiet = quiet
        model = SettingsModel(actions: CLISettingsActions(cli: cli), defaults: defaults)
    }

    var isShown: Bool { window?.isVisible ?? false }

    /// A menu bar app is never frontmost on its own, so a person opening the window activates it.
    func show() {
        let window = self.window ?? makeWindow()
        if !window.isVisible { watching(true) }
        Task { await model.refresh() }
        if quiet { window.orderBack(nil); return }
        NSApplication.shared.activate()
        // A window put in the Dock earlier has to come out of it, or choosing Settings looks like nothing happened.
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
    }

    func close() { window?.performClose(nil) }

    func windowDidBecomeKey(_ notification: Notification) {
        Task { await model.refresh() }
    }

    func windowWillClose(_ notification: Notification) {
        if let window { defaults.set(window.frameDescriptor, forKey: Self.frameKey) }
        watching(false)
    }

    private func makeWindow() -> NSWindow {
        let content = NSHostingView(rootView: SettingsView(model: model, openLoginItems: { SMAppService.openSystemSettingsLoginItems() }))
        // The form scrolls, so the window decides its height: all of it where the screen has room.
        content.sizingOptions = []
        let available = (NSScreen.main?.visibleFrame.height ?? 900) - 60
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: min(780, available)),
            styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = Self.title
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.contentView = content
        window.delegate = self
        // Where it was left, if that is still somewhere this Mac can show it: a window saved on a
        // display that has since been unplugged would otherwise open where nobody can reach it.
        if let frame = defaults.string(forKey: Self.frameKey) {
            window.setFrame(from: frame)
            if !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(window.frame) }) {
                window.center()
            }
        } else {
            window.center()
        }
        WindowMenu.install()
        self.window = window
        return window
    }
}

/// Key equivalents for the app's one ordinary window (Bento's `WindowMenu`, plus Edit so the email and code fields
/// take ⌘V). A menu bar app shows no menu bar, but its key equivalents still route through the main menu.
@MainActor
enum WindowMenu {
    static func install() {
        guard NSApplication.shared.mainMenu == nil else { return }
        let application = NSMenu(title: "Localbox")
        application.addItem(NSMenuItem(title: "Quit Localbox", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        let edit = NSMenu(title: "Edit")
        edit.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        edit.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
        edit.addItem(.separator())
        edit.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        let window = NSMenu(title: "Window")
        window.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        let main = NSMenu()
        for menu in [application, edit, window] {
            let item = NSMenuItem()
            item.submenu = menu
            main.addItem(item)
        }
        NSApplication.shared.mainMenu = main
    }
}
