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

/// One frame from a running `SCStream`. `SCScreenshotManager` answers nil while a menu is open (spike 18); a stream
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
    default:
        throw Failure("usage: localbox-desktop geometry | capture png | capture jpeg <q> <scale> | move | click | scroll | key | type")
    }
} catch {
    FileHandle.standardError.write(Data("localbox-desktop: \(error)\n".utf8))
    exit(1)
}
