#if os(macOS)
import CommonCrypto
import CoreGraphics
import Foundation
import ImageIO
import Network
import UniformTypeIdentifiers
import Vision

/// A minimal RFB 3.8 client for driving a macOS guest's screen during an unattended build: raw 32-bit frames to read
/// the screen, key and pointer events to act on it. Only what scripted setup needs; never a viewer. Every read has a
/// deadline, and a wait on the screen (`waitForText`) bounds every read under it by its own: a server that goes quiet
/// cancels the connection, so the wait ends on time instead of hanging.
public final class VNCClient: @unchecked Sendable {
    /// The longest one frame read may wait. Virtualization's server answers an update request only once the screen
    /// changes, so a static screen may say nothing until something on it moves (the menu bar clock's next minute).
    static let frameTimeout: TimeInterval = 120
    /// The longest the handshake may wait: the server says nothing until the guest's display is up, which a booting guest
    /// (Recovery included) can take minutes to bring.
    static let handshakeTimeout: TimeInterval = 300
    /// What one read may wait: the handshake's limit while connecting, a frame's after.
    private var readTimeout = VNCClient.handshakeTimeout
    /// A wait's own deadline, which no read under it outlasts.
    private var waitDeadline: Date?
    private let connection: NWConnection
    private let queue = DispatchQueue(label: "sh.localbox.vnc")
    public private(set) var width = 0
    public private(set) var height = 0
    private var framebuffer = Data()

    private let password: String?
    public init(port: UInt16, password: String? = nil) {
        self.password = password
        connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    }

    public func connect() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let answered = Locked(false)
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: if answered.claim() { continuation.resume() }
                case .failed(let error), .waiting(let error): if answered.claim() { continuation.resume(throwing: error) }
                default: break
                }
            }
            connection.start(queue: queue)
        }
        let version = try await read(12)
        guard String(decoding: version, as: UTF8.self).hasPrefix("RFB ") else { throw HostDaemonError.unsupported("not an RFB server") }
        try await write(Data("RFB 003.008\n".utf8))
        let count = Int(try await read(1)[0])
        guard count > 0 else { throw HostDaemonError.unsupported("VNC server refused: \(try await readReason())") }
        let types = try await read(count)
        if let password, types.contains(2) {
            try await write(Data([2]))
            try await write(Self.vncAuthResponse(challenge: try await read(16), password: password))
        } else if password == nil, types.contains(1) {
            try await write(Data([1]))
        } else { throw HostDaemonError.unsupported("VNC server offers security types \(Array(types)), none usable") }
        guard try await readU32() == 0 else { throw HostDaemonError.unsupported("VNC security handshake failed: \(try await readReason())") }
        try await write(Data([1])) // shared
        width = Int(try await readU16()); height = Int(try await readU16())
        _ = try await read(16) // server pixel format; replaced below
        _ = try await read(Int(try await readU32())) // desktop name
        // 32 bpp, depth 24, little-endian true colour, BGRA in memory.
        try await write(Data([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]))
        // SetEncodings: Raw, plus the DesktopSize pseudo-encoding (-223), without which Virtualization's server traps.
        try await write(Data([2, 0, 0, 2, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x21]))
        framebuffer = Data(count: width * height * 4)
        readTimeout = Self.frameTimeout
    }

    public func close() { connection.cancel() }

    /// RFB "VNC authentication": the challenge DES-encrypted with the password as key, each key byte bit-reversed.
    static func vncAuthResponse(challenge: Data, password: String) throws -> Data {
        var key = [UInt8](password.utf8.prefix(8)) + [UInt8](repeating: 0, count: max(0, 8 - password.utf8.count))
        key = key.map { byte in (0..<8).reduce(UInt8(0)) { $0 | (((byte >> $1) & 1) << (7 - $1)) } }
        var response = [UInt8](repeating: 0, count: 16), moved = 0
        let status = challenge.withUnsafeBytes { input in
            CCCrypt(CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmDES), CCOptions(kCCOptionECBMode), key, 8, nil, input.baseAddress, 16, &response, 16, &moved)
        }
        guard status == kCCSuccess, moved == 16 else { throw HostDaemonError.unsupported("VNC authentication: DES failed (\(status))") }
        return Data(response)
    }

    /// A full frame of the screen, as it is now.
    public func capture() async throws -> CGImage {
        try await requestFrame()
        while true {
            let type = try await read(1)[0]
            switch type {
            case 0:
                _ = try await read(1)
                let rectangles = Int(try await readU16())
                var resized = false
                for _ in 0..<rectangles {
                    let x = Int(try await readU16()), y = Int(try await readU16()), w = Int(try await readU16()), h = Int(try await readU16())
                    let encoding = try await readU32()
                    if encoding == 0xffff_ff21 { width = w; height = h; framebuffer = Data(count: w * h * 4); resized = true; continue } // DesktopSize
                    guard encoding == 0 else { throw HostDaemonError.unsupported("VNC server sent encoding \(encoding), not raw") }
                    let pixels = try await read(w * h * 4)
                    pixels.withUnsafeBytes { source in
                        framebuffer.withUnsafeMutableBytes { target in
                            for row in 0..<h where y + row < height {
                                let count = min(w, width - x) * 4
                                guard count > 0 else { continue }
                                target.baseAddress!.advanced(by: ((y + row) * width + x) * 4).copyMemory(from: source.baseAddress!.advanced(by: row * w * 4), byteCount: count)
                            }
                        }
                    }
                }
                if resized { try await requestFrame(); continue }
                return try image()
            case 1: _ = try await read(3); let colours = Int(try await readU16()); _ = try await read(colours * 6)
            case 2: continue
            case 3: _ = try await read(3); _ = try await read(Int(try await readU32()))
            default: throw HostDaemonError.unsupported("unknown VNC server message \(type)")
            }
        }
    }

    private func requestFrame() async throws {
        var request = Data([3, 0]); request.append(be16(0)); request.append(be16(0)); request.append(be16(UInt16(width))); request.append(be16(UInt16(height)))
        try await write(request)
    }

    /// The frame the last capture read, without asking for another: the server answers a request only once the screen
    /// changes, so a screen just read (by `waitForText`) is saved from what it sent.
    public func lastFrame() throws -> CGImage { try image() }

    /// The screen's text, top to bottom, from Vision's text recognition.
    public func screenText() async throws -> String {
        let frame = try await capture()
        let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: frame, options: [:]).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    /// Polls the screen until `predicate` holds for its text, or throws with the last text seen.
    @discardableResult
    public func waitForText(timeout: TimeInterval, _ what: String, _ predicate: (String) -> Bool) async throws -> String {
        let deadline = Date().addingTimeInterval(timeout)
        waitDeadline = deadline; defer { waitDeadline = nil }
        var last = ""
        while Date() < deadline {
            last = (try? await screenText()) ?? last
            if predicate(last) { return last }
            try await Task.sleep(nanoseconds: 2_000_000_000)
        }
        throw HostDaemonError.unsupported("screen never showed \(what) within \(Int(timeout)) s; last text: \(last.replacingOccurrences(of: "\n", with: " | ").prefix(600))")
    }

    public func savePNG(_ image: CGImage, to url: URL) throws {
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw HostDaemonError.unsupported("cannot write \(url.path)") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw HostDaemonError.unsupported("cannot write \(url.path)") }
    }

    // MARK: input

    public enum Key: UInt32 { case returnKey = 0xff0d, tab = 0xff09, escape = 0xff1b, backspace = 0xff08, left = 0xff51, up = 0xff52, right = 0xff53, down = 0xff54, shift = 0xffe1, control = 0xffe3, option = 0xffe7, command = 0xffe9 }

    public func press(_ key: Key, with modifiers: [Key] = []) async throws {
        for modifier in modifiers { try await keyEvent(modifier.rawValue, down: true) }
        try await keyEvent(key.rawValue, down: true); try await keyEvent(key.rawValue, down: false)
        for modifier in modifiers.reversed() { try await keyEvent(modifier.rawValue, down: false) }
        try await Task.sleep(nanoseconds: 150_000_000)
    }

    /// A character with modifiers held (Command-Shift-T and the like).
    public func chord(_ character: Character, with modifiers: [Key]) async throws {
        let (keysym, shifted) = Self.keysym(for: character)
        let held = modifiers + (shifted && !modifiers.contains(.shift) ? [.shift] : [])
        for modifier in held { try await keyEvent(modifier.rawValue, down: true) }
        try await keyEvent(keysym, down: true); try await keyEvent(keysym, down: false)
        for modifier in held.reversed() { try await keyEvent(modifier.rawValue, down: false) }
        try await Task.sleep(nanoseconds: 150_000_000)
    }

    /// Types text on a US layout, holding Shift for capitals and shifted symbols.
    public func type(_ text: String) async throws {
        for character in text {
            if character == "\n" { try await press(.returnKey); continue }
            let (keysym, shifted) = Self.keysym(for: character)
            if shifted { try await keyEvent(Key.shift.rawValue, down: true) }
            try await keyEvent(keysym, down: true); try await keyEvent(keysym, down: false)
            if shifted { try await keyEvent(Key.shift.rawValue, down: false) }
            try await Task.sleep(nanoseconds: 40_000_000)
        }
    }

    public func click(x: Int, y: Int) async throws {
        try await pointer(x: x, y: y, buttons: 0); try await pointer(x: x, y: y, buttons: 1); try await pointer(x: x, y: y, buttons: 0)
    }

    private static let shiftedSymbols: [Character: Character] = ["~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/"]
    static func keysym(for character: Character) -> (UInt32, Bool) {
        if let base = shiftedSymbols[character] { return (UInt32(base.unicodeScalars.first!.value), true) }
        if character.isUppercase, let lower = character.lowercased().unicodeScalars.first { return (lower.value, true) }
        return (character.unicodeScalars.first!.value, false)
    }

    private func keyEvent(_ keysym: UInt32, down: Bool) async throws {
        var message = Data([4, down ? 1 : 0, 0, 0]); message.append(be32(keysym)); try await write(message)
    }
    private func pointer(x: Int, y: Int, buttons: UInt8) async throws {
        var message = Data([5, buttons]); message.append(be16(UInt16(x))); message.append(be16(UInt16(y))); try await write(message)
    }

    // MARK: wire

    private func read(_ count: Int) async throws -> Data {
        guard count > 0 else { return Data() }
        let connection = connection, timeout = min(readTimeout, waitDeadline.map { max(0, $0.timeIntervalSinceNow) } ?? readTimeout)
        return try await withCheckedThrowingContinuation { continuation in
            let answered = Locked(false)
            let finish: @Sendable (Result<Data, Error>) -> Void = { result in if answered.claim() { continuation.resume(with: result) } }
            queue.asyncAfter(deadline: .now() + timeout) {
                guard answered.claim() else { return }
                continuation.resume(throwing: HostDaemonError.unsupported("the VNC server sent nothing for \(spoken(timeout))"))
                connection.cancel()
            }
            connection.receive(minimumIncompleteLength: count, maximumLength: count) { data, _, complete, error in
                if let error { finish(.failure(error)) }
                else if let data, data.count == count { finish(.success(data)) }
                else { finish(.failure(HostDaemonError.unsupported(complete ? "VNC connection closed" : "short VNC read"))) }
            }
        }
    }
    private func write(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in if let error { continuation.resume(throwing: error) } else { continuation.resume() } })
        }
    }
    private func readU16() async throws -> UInt16 { let d = try await read(2); return UInt16(d[d.startIndex]) << 8 | UInt16(d[d.startIndex + 1]) }
    private func readU32() async throws -> UInt32 { let d = try await read(4); return d.reduce(0) { $0 << 8 | UInt32($1) } }
    private func readReason() async throws -> String { String(decoding: try await read(Int(try await readU32())), as: UTF8.self) }
    private func be16(_ value: UInt16) -> Data { Data([UInt8(value >> 8), UInt8(value & 0xff)]) }
    private func be32(_ value: UInt32) -> Data { Data([UInt8(value >> 24), UInt8((value >> 16) & 0xff), UInt8((value >> 8) & 0xff), UInt8(value & 0xff)]) }

    private func image() throws -> CGImage {
        let provider = CGDataProvider(data: framebuffer as CFData)!
        guard let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { throw HostDaemonError.unsupported("cannot make an image from the VNC frame") }
        return image
    }
}
#endif
