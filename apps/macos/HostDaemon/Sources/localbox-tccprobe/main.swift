import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

/// Spike 18's stand-in for the darwin agent's desktop role (slice 33 replaces it): run as a LaunchAgent in the
/// auto-login session, it reports the three TCC preflights, captures the screen, clicks the Apple menu and reads the
/// opened menu back from a second capture.
///   localbox-tccprobe <result.json>

let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "/tmp/tccprobe.json")
var result: [String: Any] = [
    "screen_capture": CGPreflightScreenCaptureAccess(),
    "accessibility": AXIsProcessTrusted(),
    "post_event": CGPreflightPostEventAccess(),
]

func capture() async throws -> CGImage {
    let content = try await SCShareableContent.current
    guard let display = content.displays.first else { throw NSError(domain: "tccprobe", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"]) }
    let configuration = SCStreamConfiguration(); configuration.width = display.width; configuration.height = display.height
    return try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration)
}

func text(in image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " | ")
}

func save(_ image: CGImage, _ path: String) {
    guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(destination, image, nil); CGImageDestinationFinalize(destination)
}

func click(_ point: CGPoint) {
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(120_000)
    }
}

let done = DispatchSemaphore(value: 0)
Task {
    do {
        let before = try await capture()
        save(before, "/tmp/tccprobe-before.png")
        result["captured_pixels"] = before.width * before.height
        click(CGPoint(x: 18, y: 10)) // the Apple menu
        try await Task.sleep(nanoseconds: 1_500_000_000)
        let after = try await capture()
        save(after, "/tmp/tccprobe-after.png")
        let seen = try text(in: after)
        result["menu_opened"] = seen.contains("About This Mac") || seen.contains("System Settings")
        result["after_text"] = String(seen.prefix(400))
        CGEvent(keyboardEventSource: nil, virtualKey: 0x35, keyDown: true)?.post(tap: .cghidEventTap) // Escape closes it
        CGEvent(keyboardEventSource: nil, virtualKey: 0x35, keyDown: false)?.post(tap: .cghidEventTap)
    } catch { result["error"] = String(describing: error) }
    done.signal()
}
done.wait()
try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]).write(to: output)
