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

/// ScreenCaptureKit sometimes answers a capture with neither an image nor an error (Swift's `nilError`) right after
/// input events, so a capture is retried.
func capture() async throws -> CGImage {
    var failure: Error?
    for _ in 0..<5 {
        do { return try await captureOnce() } catch { failure = error; try await Task.sleep(nanoseconds: 700_000_000) }
    }
    throw failure!
}

func captureOnce() async throws -> CGImage {
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
        // With the menu open: does a capture work? The host also reads the open menu over VNC meanwhile.
        do {
            let open = try await captureOnce()
            save(open, "/tmp/tccprobe-after.png")
            result["capture_with_menu_open"] = true
            result["after_text"] = String(try text(in: open).prefix(400))
        } catch { result["capture_with_menu_open"] = false; result["capture_with_menu_open_error"] = String(describing: error) }
        try await Task.sleep(nanoseconds: 6_000_000_000)
        CGEvent(keyboardEventSource: nil, virtualKey: 0x35, keyDown: true)?.post(tap: .cghidEventTap) // Escape closes it
        CGEvent(keyboardEventSource: nil, virtualKey: 0x35, keyDown: false)?.post(tap: .cghidEventTap)
        try await Task.sleep(nanoseconds: 1_000_000_000)
        result["capture_after_close"] = (try? await capture()) != nil
    } catch { result["error"] = String(describing: error) }
    done.signal()
}
done.wait()
try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]).write(to: output)
