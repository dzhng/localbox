import AppKit
import LocalboxAppCore
import LocalboxMenu
import SwiftUI

// Draws the production PopoverView offscreen: synthetic facts (the shared fixtures), an NSHostingView that is never
// put in a window, no app activation. Arguments: fixtures directory, output directory, scale (2 for evidence), and
// optionally the Settings shots' directory and the update states' (SettingsShots.swift).
@main struct Shots {
    @MainActor static func main() throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let arguments = CommandLine.arguments
        let fixtures = URL(fileURLWithPath: arguments[1]), output = URL(fileURLWithPath: arguments[2])
        let scale = CGFloat(Double(arguments[3]) ?? 2)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let facts = { (name: String) in try AppFacts.decode(Data(contentsOf: fixtures.appendingPathComponent("\(name).json"))) }
        var states: [(String, PopoverRows)] = []
        for name in try FileManager.default.contentsOfDirectory(atPath: fixtures.path).sorted() where name.hasSuffix(".json") {
            let base = String(name.dropLast(5))
            states.append((base, PopoverPresentation.rows(try facts(base))))
        }
        // States the facts alone do not reach: a failed action in a row, the first read pending, a quit in progress.
        states.append(("action-failed", PopoverPresentation.rows(try facts("three-sandboxes"),
            .init(failures: ["quiet-otter": "This sandbox is busy finishing a command. Try again in a moment."]))))
        states.append(("loading", PopoverPresentation.rows(nil)))
        states.append(("quitting", PopoverPresentation.rows(try facts("three-sandboxes"), .init(quitting: ["quiet-otter"]))))

        var heights: [String: CGFloat] = [:]
        var report: [[String: Any]] = []
        for (theme, appearanceName) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            let appearance = NSAppearance(named: appearanceName)!
            for (name, rows) in states {
                let content = NSHostingView(rootView: PopoverView(rows: rows, perform: { _ in }))
                content.appearance = appearance
                // Two layout passes: the list measures its content, then caps its own height.
                var size = content.fittingSize
                for _ in 0..<4 {
                    content.frame = NSRect(origin: .zero, size: size)
                    content.layoutSubtreeIfNeeded()
                    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
                    let next = content.fittingSize
                    if next == size { break }
                    size = next
                }
                content.frame = NSRect(x: 20, y: 20, width: size.width, height: size.height)
                let stage = Stage(frame: NSRect(x: 0, y: 0, width: size.width + 40, height: size.height + 40), dark: theme == "dark")
                stage.appearance = appearance
                stage.addSubview(content)
                let caption = NSTextField(labelWithString: "Synthetic facts · presentation fixture")
                caption.font = .systemFont(ofSize: 9)
                caption.textColor = .secondaryLabelColor
                caption.frame = NSRect(x: 20, y: 3, width: size.width, height: 14)
                stage.addSubview(caption)
                stage.layoutSubtreeIfNeeded()
                try save(stage, scale: scale, to: output.appendingPathComponent("\(theme)-\(name).png"))
                heights[name] = size.height
                report.append(["state": name, "appearance": theme, "width": size.width, "height": size.height, "scale": scale])
            }
            try save(statusItems(appearance, dark: theme == "dark"), scale: scale, to: output.appendingPathComponent("\(theme)-status-item.png"))
        }
        precondition(heights.values.allSatisfy { $0 > 100 }, "every state draws: \(heights)")
        let listCap = PopoverView.listLimit
        // Twelve rows are about 600 pt; the idle popover's list (a label and one line) is far below the cap.
        precondition(heights["twelve-sandboxes"]! <= heights["idle"]! + listCap, "twelve sandboxes scroll inside a capped list: \(heights)")
        precondition(heights["twelve-sandboxes"]! > heights["three-sandboxes"]!, "the capped list is still taller than three rows: \(heights)")
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: output.appendingPathComponent("shots.json"))
        if arguments.count > 4 { try SettingsShots.render(fixtures: fixtures, output: URL(fileURLWithPath: arguments[4]), states: SettingsShots.states) }
        if arguments.count > 5 { try SettingsShots.render(fixtures: fixtures, output: URL(fileURLWithPath: arguments[5]), states: SettingsShots.updateStates) }
    }

    /// The status item's two images as the menu bar tints them, on a menu-bar-coloured strip.
    @MainActor static func statusItems(_ appearance: NSAppearance, dark: Bool) -> NSView {
        let strip = Stage(frame: NSRect(x: 0, y: 0, width: 96, height: 24), dark: dark)
        strip.appearance = appearance
        for (index, icon) in [PopoverRows.StatusIcon.normal, .warning].enumerated() {
            let view = NSImageView(frame: NSRect(x: 16 + index * 40, y: 3, width: 24, height: 18))
            view.image = StatusIcon.image(icon)
            view.contentTintColor = .labelColor
            view.imageScaling = .scaleNone
            strip.addSubview(view)
        }
        return strip
    }

    @MainActor static func save(_ view: NSView, scale: CGFloat, to url: URL) throws {
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(view.bounds.width * scale), pixelsHigh: Int(view.bounds.height * scale),
                                      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        bitmap.size = view.bounds.size
        view.appearance!.performAsCurrentDrawingAppearance { view.cacheDisplay(in: view.bounds, to: bitmap) }
        try bitmap.representation(using: .png, properties: [:])!.write(to: url)
    }
}

/// A flat backing in place of the popover's material, which an offscreen view cannot composite (Bento's shots do the
/// same: they check layout and type, not native glass).
final class Stage: NSView {
    let dark: Bool
    init(frame: NSRect, dark: Bool) { self.dark = dark; super.init(frame: frame) }
    required init?(coder: NSCoder) { nil }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(white: dark ? 0.10 : 0.95, alpha: 1).setFill()
        bounds.fill()
    }
}
