import CryptoKit
import Foundation

/// Every datagram is `header (12 bytes) || ciphertext || tag (16 bytes)`, which is exactly CryptoKit's
/// ChaChaPoly combined representation: the clear header *is* the nonce, so it is authenticated without
/// being sent twice. Header layout:
///
///     0..3   session   random per process, so two processes sharing one key never reuse a nonce
///     4      kind
///     5..11  data:     stream u8, chunk u32, fragment u16
///            control:  sequence u56 (per process, per direction)
///
/// A retransmitted data fragment reuses its nonce with byte-identical plaintext, which is safe; kinds are
/// direction-specific, so sender and receiver never collide even if their sessions match.
enum PacketKind: UInt8 {
    case hello = 0x01         // receiver → sender: punch packet and "send me the manifest info"
    case probe = 0x02         // sender → receiver: punch packet toward the answer's candidates
    case manifestInfo = 0x03  // sender → receiver: manifest length and digest
    case request = 0x04       // receiver → sender: fragment ranges to send, plus loss feedback
    case done = 0x05          // receiver → sender: everything verified and written
    case data = 0x10          // sender → receiver: one fragment of one chunk
}

struct PacketHeader: Equatable {
    static let size = 12
    static let tagSize = 16

    var session: UInt32
    var kind: PacketKind
    var stream: UInt8 = 0
    var chunk: UInt32 = 0
    var fragment: UInt16 = 0
    var sequence: UInt64 = 0

    var bytes: Data {
        var out = Data(capacity: Self.size)
        out.appendBE(session)
        out.append(kind.rawValue)
        if kind == .data {
            out.append(stream)
            out.appendBE(chunk)
            out.appendBE(fragment)
        } else {
            for shift in stride(from: 48, through: 0, by: -8) { out.append(UInt8(truncatingIfNeeded: sequence >> UInt64(shift))) }
        }
        return out
    }

    init(session: UInt32, kind: PacketKind, stream: UInt8 = 0, chunk: UInt32 = 0, fragment: UInt16 = 0, sequence: UInt64 = 0) {
        self.session = session; self.kind = kind; self.stream = stream; self.chunk = chunk; self.fragment = fragment; self.sequence = sequence
    }

    init?(_ datagram: Data) {
        guard datagram.count >= Self.size + Self.tagSize, let kind = PacketKind(rawValue: datagram.byte(4)) else { return nil }
        self.session = datagram.readBE(UInt32.self, at: 0)
        self.kind = kind
        if kind == .data {
            stream = datagram.byte(5)
            chunk = datagram.readBE(UInt32.self, at: 6)
            fragment = datagram.readBE(UInt16.self, at: 10)
        } else {
            var value: UInt64 = 0
            for index in 5..<12 { value = value << 8 | UInt64(datagram.byte(index)) }
            sequence = value
        }
    }
}

/// Seals and opens datagrams with the one-time key from the offer.
struct PacketCipher {
    let key: SymmetricKey

    func seal(_ header: PacketHeader, _ plaintext: Data) -> Data {
        // The header is a valid 12-byte nonce by construction, so neither call can throw.
        let nonce = try! ChaChaPoly.Nonce(data: header.bytes)
        return try! ChaChaPoly.seal(plaintext, using: key, nonce: nonce).combined
    }

    /// nil when the datagram is malformed or fails authentication (wrong key, tampered, or not ours).
    func open(_ datagram: Data) -> (PacketHeader, Data)? {
        guard let header = PacketHeader(datagram),
              let box = try? ChaChaPoly.SealedBox(combined: datagram),
              let plaintext = try? ChaChaPoly.open(box, using: key) else { return nil }
        return (header, plaintext)
    }

    /// AEAD is most of the per-datagram cost, so large batches are spread across cores.
    func seal(_ batch: [(PacketHeader, Data)]) -> [Data] { parallelMap(batch) { seal($0.0, $0.1) } }
}

func parallelMap<In, Out>(_ input: [In], _ transform: (In) -> Out) -> [Out] {
    let stripe = 16
    guard input.count > stripe else { return input.map(transform) }
    return [Out](unsafeUninitializedCapacity: input.count) { buffer, count in
        let base = buffer.baseAddress!
        DispatchQueue.concurrentPerform(iterations: (input.count + stripe - 1) / stripe) { part in
            for index in part * stripe..<min(input.count, (part + 1) * stripe) { (base + index).initialize(to: transform(input[index])) }
        }
        count = input.count
    }
}

/// One contiguous run of fragments of one chunk the receiver wants sent.
struct FragmentRange: Equatable {
    static let encodedSize = 9
    var stream: UInt8
    var chunk: UInt32
    var first: UInt16
    var count: UInt16
}

/// A request also carries the receiver's cumulative delivery counters; the sender paces from their deltas.
struct RequestMessage: Equatable {
    var received: UInt64
    var lost: UInt64
    var ranges: [FragmentRange]

    static func maxRanges(payload: Int) -> Int { (payload - 16) / FragmentRange.encodedSize }

    var bytes: Data {
        var out = Data(capacity: 16 + ranges.count * FragmentRange.encodedSize)
        out.appendBE(received); out.appendBE(lost)
        for range in ranges { out.append(range.stream); out.appendBE(range.chunk); out.appendBE(range.first); out.appendBE(range.count) }
        return out
    }

    init(received: UInt64, lost: UInt64, ranges: [FragmentRange]) { self.received = received; self.lost = lost; self.ranges = ranges }

    init?(_ data: Data) {
        guard data.count >= 16, (data.count - 16) % FragmentRange.encodedSize == 0 else { return nil }
        received = data.readBE(UInt64.self, at: 0); lost = data.readBE(UInt64.self, at: 8)
        ranges = stride(from: 16, to: data.count, by: FragmentRange.encodedSize).map { at in
            FragmentRange(stream: data.byte(at), chunk: data.readBE(UInt32.self, at: at + 1), first: data.readBE(UInt16.self, at: at + 5), count: data.readBE(UInt16.self, at: at + 7))
        }
    }
}

struct ManifestInfo: Equatable {
    var length: UInt32
    var digest: Data

    var bytes: Data { var out = Data(); out.appendBE(length); out.append(digest); return out }
    init(length: UInt32, digest: Data) { self.length = length; self.digest = digest }
    init?(_ data: Data) {
        guard data.count == 36 else { return nil }
        length = data.readBE(UInt32.self, at: 0); digest = data.subdata(in: data.startIndex + 4..<data.startIndex + 36)
    }
}

extension Data {
    mutating func appendBE<T: FixedWidthInteger>(_ value: T) { Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) } }
    func byte(_ offset: Int) -> UInt8 { self[startIndex + offset] }
    func readBE<T: FixedWidthInteger>(_: T.Type, at offset: Int) -> T {
        var value: T = 0
        for index in 0..<MemoryLayout<T>.size { value = value << 8 | T(self[startIndex + offset + index]) }
        return value
    }
}

/// `PUNCHLAB_DEBUG=1`: sender and receiver print their rate, window and loss on stderr as they adapt.
let debug = ProcessInfo.processInfo.environment["PUNCHLAB_DEBUG"] != nil
