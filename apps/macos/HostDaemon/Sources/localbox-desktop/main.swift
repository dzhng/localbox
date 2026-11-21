import ApplicationServices
import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// The darwin guest agent's hands on the desktop (`packages/desktop/src/macos.ts` drives it). The agent's `--desktop`
/// role spawns it in the auto-login session, so TCC holds the agent responsible and the agent's rows grant it. One
/// subcommand per call; it decides nothing (key names, scroll direction and encodings are the agent's):
///   localbox-desktop geometry                         "<width> <height>" in event coordinates (points)
///   localbox-desktop capture png                      the main display as PNG on stdout
///   localbox-desktop capture jpeg <quality> <scale>   as JPEG, quality 1-100, scale (0, 1]
///   localbox-desktop move <x> <y>
///   localbox-desktop click <x> <y> left|middle|right
///   localbox-desktop scroll <x> <y> <wheelY> <wheelX>  CGEvent wheel lines: positive scrolls up and left
///   localbox-desktop key <keyCode> [command,control,option,shift]
///   localbox-desktop type <text>
///   localbox-desktop guard-capture-prompt              runs until killed; presses Allow on macOS's window-picker
///                                                      bypass prompt whenever it appears, printing one line per press
///   localbox-desktop settle-capture-prompt             brings the prompt up with a throwaway capture, presses Allow

struct Failure: Error, CustomStringConvertible { let description: String; init(_ description: String) { self.description = description } }

let arguments = Array(CommandLine.arguments.dropFirst())
let source = CGEventSource(stateID: .hidSystemState)

func number(_ index: Int) throws -> Double {
    guard index < arguments.count, let value = Double(arguments[index]), value.isFinite else { throw Failure("argument \(index + 1) must be a number") }
    return value
}

func post(_ event: CGEvent?) throws {
    guard let event else { throw Failure("could not create the event") }
    event.post(tap: .cghidEventTap)
}

/// A pause between posted events: WindowServer drops a down/up pair that arrives in the same instant as the move.
func settle() { usleep(30_000) }

func move(to point: CGPoint) throws {
    try post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    settle()
}

func click(at point: CGPoint, button: String) throws {
    let (down, up, which): (CGEventType, CGEventType, CGMouseButton) = switch button {
    case "left": (.leftMouseDown, .leftMouseUp, .left)
    case "right": (.rightMouseDown, .rightMouseUp, .right)
    case "middle": (.otherMouseDown, .otherMouseUp, .center)
    default: throw Failure("unknown button \(button)")
    }
    try move(to: point)
    try post(CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: point, mouseButton: which))
    settle()
    try post(CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: point, mouseButton: which))
}

func key(_ code: CGKeyCode, modifiers: [String]) throws {
    var flags: CGEventFlags = []
    for modifier in modifiers {
        switch modifier {
        case "command": flags.insert(.maskCommand)
        case "control": flags.insert(.maskControl)
        case "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: throw Failure("unknown modifier \(modifier)")
        }
    }
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { throw Failure("could not create the key event") }
        event.flags = flags
        event.post(tap: .cghidEventTap)
        settle()
    }
}

/// Text goes in as Unicode strings on key events, so any character types regardless of the keyboard layout.
func type(_ text: String) throws {
    var units = Array(text.utf16)[...]
    while !units.isEmpty {
        // Keep surrogate pairs together; a key event carries at most 20 UTF-16 units, one character at a time is safest.
        var count = 1
        if UTF16.isLeadSurrogate(units[units.startIndex]), units.count > 1 { count = 2 }
        let chunk = Array(units.prefix(count)); units = units.dropFirst(count)
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { throw Failure("could not create the key event") }
            event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            event.post(tap: .cghidEventTap)
        }
        usleep(8_000)
    }
}

/// One frame from a running `SCStream`. `SCScreenshotManager` answers nil while a menu is open; a stream
/// keeps delivering frames then. `@unchecked Sendable`: the continuation is only touched under the lock.
final class OneFrame: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<CGImage, Error>?

    func wait(on stream: SCStream, timeout: TimeInterval) async throws -> CGImage {
        try await withCheckedThrowingContinuation { continuation in
            lock.withLock { self.continuation = continuation }
            stream.startCapture { error in if let error { self.finish(.failure(error)) } }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { self.finish(.failure(Failure("no frame within \(Int(timeout)) s"))) }
        }
    }

    private func finish(_ result: Result<CGImage, Error>) {
        let waiting = lock.withLock { () -> CheckedContinuation<CGImage, Error>? in defer { continuation = nil }; return continuation }
        waiting?.resume(with: result)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: status) == .complete,
              let pixels = sampleBuffer.imageBuffer else { return }
        let image = CIImage(cvPixelBuffer: pixels)
        guard let frame = CIContext().createCGImage(image, from: image.extent) else { return finish(.failure(Failure("could not read the frame"))) }
        finish(.success(frame))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { finish(.failure(error)) }
}

func capture(scale: Double) async throws -> CGImage {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { throw Failure("no display") }
    let configuration = SCStreamConfiguration()
    configuration.width = max(1, Int((Double(display.width) * scale).rounded()))
    configuration.height = max(1, Int((Double(display.height) * scale).rounded()))
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.queueDepth = 3
    let frame = OneFrame()
    let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration, delegate: frame)
    try stream.addStreamOutput(frame, type: .screen, sampleHandlerQueue: DispatchQueue(label: "localbox-desktop.frames"))
    defer { stream.stopCapture { _ in } }
    return try await frame.wait(on: stream, timeout: 10)
}

// MARK: - The window-picker bypass prompt

/// macOS 27 asks "… is requesting to bypass the system private window picker" over a granted screen capture, and the
/// managed restriction against it does not survive a reboot of an unmanaged Mac. The desktop role holds Accessibility,
/// so this finds the prompt among on-screen windows through the Accessibility API and presses its Allow button.
enum CapturePrompt {
    static let marker = "bypass the system private window picker"

    static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: AnyObject?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    /// The window's texts and buttons, to `depth` levels.
    static func walk(_ element: AXUIElement, depth: Int, texts: inout [String], buttons: inout [(String, AXUIElement)]) {
        let role = attribute(element, kAXRoleAttribute) as? String
        for name in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] { if let text = attribute(element, name) as? String, !text.isEmpty { texts.append(text) } }
        if role == kAXButtonRole as String, let title = (attribute(element, kAXTitleAttribute) as? String) ?? (attribute(element, kAXDescriptionAttribute) as? String) { buttons.append((title, element)) }
        guard depth > 0, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return }
        for child in children { walk(child, depth: depth - 1, texts: &texts, buttons: &buttons) }
    }

    /// Presses Allow on every prompt on screen now; returns the owners of those pressed.
    static func allowShown() -> [String] {
        let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        var owners: [pid_t: String] = [:]
        for window in windows { if let pid = window[kCGWindowOwnerPID as String] as? pid_t { owners[pid] = window[kCGWindowOwnerName as String] as? String ?? "pid \(pid)" } }
        var pressed: [String] = []
        for (pid, owner) in owners {
            let application = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(application, 0.5)
            for window in (attribute(application, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
                var texts: [String] = [], buttons: [(String, AXUIElement)] = []
                walk(window, depth: 8, texts: &texts, buttons: &buttons)
                guard texts.contains(where: { $0.contains(marker) }), let allow = buttons.first(where: { $0.0 == "Allow" })?.1 else { continue }
                if AXUIElementPerformAction(allow, kAXPressAction as CFString) == .success { pressed.append(owner) }
            }
        }
        return pressed
    }

    /// macOS shows the prompt on a session's first capture, over the captured frame. This makes that first capture a
    /// throwaway one (retried for 15 s while the session comes up), then waits up to 5 s for the prompt and presses its
    /// Allow, returning half a second later so it has left the screen. The guard may press it first; then this waits out
    /// the 5 s.
    static func settle() async {
        let started = Date()
        while (try? await capture(scale: 0.05)) == nil, Date().timeIntervalSince(started) < 15 { try? await Task.sleep(nanoseconds: 500_000_000) }
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            let pressed = allowShown()
            for owner in pressed { print("allowed the window-picker bypass prompt shown by \(owner) before the first capture"); fflush(stdout) }
            if !pressed.isEmpty { try? await Task.sleep(nanoseconds: 500_000_000); return }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    static func guardForever() -> Never {
        guard AXIsProcessTrusted() else { FileHandle.standardError.write(Data("localbox-desktop: no Accessibility grant; the capture prompt can't be answered\n".utf8)); exit(1) }
        while true {
            for owner in allowShown() { print("allowed the window-picker bypass prompt shown by \(owner)"); fflush(stdout) }
            usleep(1_000_000)
        }
    }
}

func encode(_ image: CGImage, as type: UTType, quality: Double?) throws -> Data {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else { throw Failure("cannot encode \(type.identifier)") }
    CGImageDestinationAddImage(destination, image, quality.map { [kCGImageDestinationLossyCompressionQuality: $0 / 100] as CFDictionary })
    guard CGImageDestinationFinalize(destination) else { throw Failure("encoding failed") }
    return data as Data
}

do {
    switch arguments.first {
    case "geometry":
        let bounds = CGDisplayBounds(CGMainDisplayID())
        print("\(Int(bounds.width)) \(Int(bounds.height))")
    case "capture":
        switch arguments.dropFirst().first {
        case "png": FileHandle.standardOutput.write(try encode(try await capture(scale: 1), as: .png, quality: nil))
        case "jpeg":
            let quality = try number(2), scale = try number(3)
            guard (1...100).contains(quality), scale > 0, scale <= 1 else { throw Failure("jpeg needs quality 1-100 and scale (0, 1]") }
            FileHandle.standardOutput.write(try encode(try await capture(scale: scale), as: .jpeg, quality: quality))
        default: throw Failure("capture png | capture jpeg <quality> <scale>")
        }
    case "move": try move(to: CGPoint(x: try number(1), y: try number(2)))
    case "click":
        guard arguments.count == 4 else { throw Failure("click <x> <y> left|middle|right") }
        try click(at: CGPoint(x: try number(1), y: try number(2)), button: arguments[3])
    case "scroll":
        try move(to: CGPoint(x: try number(1), y: try number(2)))
        try post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: Int32(try number(3)), wheel2: Int32(try number(4)), wheel3: 0))
    case "key":
        guard let code = UInt16(arguments.count > 1 ? arguments[1] : "") else { throw Failure("key <keyCode> [modifiers]") }
        try key(CGKeyCode(code), modifiers: arguments.count > 2 ? arguments[2].split(separator: ",").map(String.init) : [])
    case "type":
        guard arguments.count == 2 else { throw Failure("type <text>") }
        try type(arguments[1])
    case "guard-capture-prompt": CapturePrompt.guardForever()
    case "settle-capture-prompt":
        guard AXIsProcessTrusted() else { throw Failure("no Accessibility grant; the capture prompt can't be answered") }
        await CapturePrompt.settle()
    default:
        throw Failure("usage: localbox-desktop geometry | capture png | capture jpeg <q> <scale> | move | click | scroll | key | type | guard-capture-prompt | settle-capture-prompt")
    }
} catch {
    FileHandle.standardError.write(Data("localbox-desktop: \(error)\n".utf8))
    exit(1)
}
