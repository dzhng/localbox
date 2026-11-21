import Foundation

/// Which chunks are verified and written, persisted beside the receiver's temp directory. It is keyed by the
/// manifest digest: a restart against a different manifest starts over instead of trusting stale bits. The
/// receiver re-hashes what it claims before trusting it, so it is saved without fsyncing the data.
public struct ResumeBitmap: Equatable, Sendable {
    private static let magic = Data("LBRB".utf8)

    /// Where the bitmap for a transfer into `temp` lives: `<temp>.resume`, a sibling, so the directory holds only
    /// the manifest's files. Whoever keeps `temp` across a restart keeps this too.
    public static func url(beside temp: URL) -> URL {
        let directory = temp.standardizedFileURL
        return directory.deletingLastPathComponent().appendingPathComponent(directory.lastPathComponent + ".resume")
    }

    public let manifestDigest: Data
    private(set) var bits: [UInt8]
    public let count: Int

    init(manifestDigest: Data, count: Int) {
        self.manifestDigest = manifestDigest; self.count = count
        bits = [UInt8](repeating: 0, count: (count + 7) / 8)
    }

    public subscript(index: Int) -> Bool { bits[index >> 3] & (1 << UInt8(index & 7)) != 0 }
    mutating func set(_ index: Int) { bits[index >> 3] |= 1 << UInt8(index & 7) }
    mutating func clear(_ index: Int) { bits[index >> 3] &= ~(1 << UInt8(index & 7)) }

    var encoded: Data {
        var out = Self.magic
        out.append(manifestDigest)
        out.appendBE(UInt32(count))
        out.append(contentsOf: bits)
        return out
    }

    /// nil when the file is missing, malformed, or belongs to another manifest.
    public static func load(_ url: URL, manifestDigest: Data, count: Int) -> ResumeBitmap? {
        guard let data = try? Data(contentsOf: url), data.count == 4 + 32 + 4 + (count + 7) / 8,
              data.prefix(4) == magic, data.subdata(in: 4..<36) == manifestDigest,
              Int(data.readBE(UInt32.self, at: 36)) == count else { return nil }
        var bitmap = ResumeBitmap(manifestDigest: manifestDigest, count: count)
        bitmap.bits = [UInt8](data.suffix(from: 40))
        return bitmap
    }

    /// Atomic replace, so a kill mid-write leaves the previous bitmap rather than a torn one.
    func save(_ url: URL) throws { try encoded.write(to: url, options: .atomic) }
}
