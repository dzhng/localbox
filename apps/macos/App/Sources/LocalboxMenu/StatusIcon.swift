import AppKit
import LocalboxAppCore

/// The status item's template image, and its warning variant (a badge cut into the corner) while the facts carry
/// warnings. Placeholder art: a bundle that carries `Contents/Resources/StatusItem.pdf` and `StatusItemWarning.pdf`
/// (the assembler copies them from `apps/macos/App/art/`) uses those instead.
public enum StatusIcon {
    @MainActor public static func image(_ icon: PopoverRows.StatusIcon, bundle: Bundle = .main) -> NSImage {
        let warning = icon == .warning
        if let art = bundle.image(forResource: warning ? "StatusItemWarning" : "StatusItem") {
            art.isTemplate = true
            art.accessibilityDescription = warning ? "Localbox needs attention" : "Localbox"
            return art
        }
        let base = NSImage(systemSymbolName: "shippingbox", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 14, weight: .regular)) ?? NSImage(size: NSSize(width: 16, height: 16))
        let size = NSSize(width: ceil(base.size.width) + 2, height: ceil(base.size.height) + 1)
        let image = NSImage(size: size, flipped: false) { rect in
            base.draw(in: NSRect(x: 0, y: 0, width: base.size.width, height: base.size.height))
            guard warning else { return true }
            let badge = NSRect(x: rect.maxX - 8, y: rect.maxY - 8, width: 8, height: 8)
            // Cut a ring around the badge so it reads apart from the box in a one-colour template.
            NSGraphicsContext.current?.compositingOperation = .clear
            NSBezierPath(ovalIn: badge.insetBy(dx: -1.5, dy: -1.5)).fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            NSColor.black.setFill()
            NSBezierPath(ovalIn: badge).fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = warning ? "Localbox needs attention" : "Localbox"
        return image
    }
}
