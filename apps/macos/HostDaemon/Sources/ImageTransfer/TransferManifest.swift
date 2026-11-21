import CryptoKit
import Foundation

/// What the receiver needs to rebuild a directory: per file, its size and one sha256 per chunk. Chunks that
/// read as all zeros (holes, or allocated zeros) are listed in `zeroChunks`, carry an empty hash, and are
/// never sent: the receiver's file is created at full size, so they stay holes there.
public struct TransferManifest: Codable, Equatable, Sendable {
    public struct File: Codable, Equatable, Sendable {
        public var path: String
        public var size: UInt64
        public var chunkSize: UInt32
        public var chunkHashes: [Data]
        public var zeroChunks: [UInt32]

        public init(path: String, size: UInt64, chunkSize: UInt32, chunkHashes: [Data], zeroChunks: [UInt32]) {
            self.path = path; self.size = size; self.chunkSize = chunkSize; self.chunkHashes = chunkHashes; self.zeroChunks = zeroChunks
        }

        public var chunkCount: Int { chunkHashes.count }
        func length(ofChunk index: Int) -> Int { Int(min(UInt64(chunkSize), size - UInt64(index) * UInt64(chunkSize))) }
    }

    public static let defaultChunkSize: UInt32 = 1 << 20

    public var files: [File]

    public init(files: [File]) { self.files = files }

    /// Canonical bytes: the digest of these is what the sender announces and a resume is checked against.
    public func encoded() -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try! encoder.encode(self)
    }

    /// Decodes and checks a manifest that arrived from a peer: every path must stay inside the receiving
    /// directory, and every file's chunk list must match its size.
    public static func decode(_ data: Data) throws -> TransferManifest {
        let manifest = try JSONDecoder().decode(TransferManifest.self, from: data)
        var seen = Set<String>()
        for file in manifest.files {
            let parts = file.path.split(separator: "/", omittingEmptySubsequences: false)
            guard !file.path.isEmpty, !file.path.hasPrefix("/"), !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
                  seen.insert(file.path).inserted else { throw TransferError.failed("manifest path \(file.path.debugDescription) is not a plain relative path") }
            guard file.chunkSize > 0, UInt64(file.chunkCount) == (file.size + UInt64(file.chunkSize) - 1) / UInt64(file.chunkSize),
                  file.zeroChunks.allSatisfy({ Int($0) < file.chunkCount }) else { throw TransferError.failed("manifest entry for \(file.path) is inconsistent") }
        }
        return manifest
    }

    /// Every chunk of every file in one numbering; the resume bitmap is indexed by it.
    var chunks: [ChunkRef] {
        var out: [ChunkRef] = []
        for (fileIndex, file) in files.enumerated() {
            let zeros = Set(file.zeroChunks)
            for chunk in 0..<file.chunkCount {
                out.append(ChunkRef(global: out.count, file: fileIndex, chunk: chunk, offset: UInt64(chunk) * UInt64(file.chunkSize), length: file.length(ofChunk: chunk), hash: file.chunkHashes[chunk], isZero: zeros.contains(UInt32(chunk))))
            }
        }
        return out
    }

    /// Bytes outside zero chunks: what a transfer actually moves, and about what the files occupy on disk.
    public var dataBytes: UInt64 { chunks.filter { !$0.isZero }.reduce(0) { $0 + UInt64($1.length) } }
    public var chunkCount: Int { files.reduce(0) { $0 + $1.chunkCount } }
    public var zeroChunkCount: Int { files.reduce(0) { $0 + $1.zeroChunks.count } }

    /// An image directory (disk, boot store, image manifest): every regular file under `directory`, sorted by
    /// relative path.
    public static func build(directory: URL, chunkSize: UInt32 = defaultChunkSize) throws -> TransferManifest {
        let root = directory.standardizedFileURL
        let files = (FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey])?.compactMap { $0 as? URL } ?? [])
            .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
            .map { String($0.standardizedFileURL.path.dropFirst(root.path.count + 1)) }
            .sorted()
        return try build(root: root, paths: files, chunkSize: chunkSize)
    }

    /// Builds the manifest for `paths` (relative to `root`), reading only allocated regions: holes are found
    /// with SEEK_DATA, so an 8 GiB disk that is mostly holes costs only its data to hash.
    public static func build(root: URL, paths: [String], chunkSize: UInt32 = defaultChunkSize) throws -> TransferManifest {
        TransferManifest(files: try paths.map { path in
            let url = root.appendingPathComponent(path)
            let fd = open(url.path, O_RDONLY)
            guard fd >= 0 else { throw TransferError.failed("cannot open \(url.path): \(String(cString: strerror(errno)))") }
            defer { close(fd) }
            var info = stat()
            guard fstat(fd, &info) == 0 else { throw TransferError.failed("cannot stat \(url.path)") }
            let size = UInt64(info.st_size)
            let count = Int((size + UInt64(chunkSize) - 1) / UInt64(chunkSize))
            var hashes: [Data] = []; var zeros: [UInt32] = []
            var buffer = Data(count: Int(chunkSize))
            for chunk in 0..<count {
                let offset = UInt64(chunk) * UInt64(chunkSize)
                let length = Int(min(UInt64(chunkSize), size - offset))
                let nextData = lseek(fd, off_t(offset), SEEK_DATA)
                if nextData < 0 || UInt64(nextData) >= offset + UInt64(length) { hashes.append(Data()); zeros.append(UInt32(chunk)); continue }
                try readExactly(fd, into: &buffer, length: length, offset: offset)
                let hash = buffer.withUnsafeBytes { raw -> Data? in
                    let bytes = UnsafeRawBufferPointer(rebasing: raw[0..<length])
                    return isAllZero(bytes) ? nil : Data(SHA256.hash(data: bytes))
                }
                if let hash { hashes.append(hash) } else { hashes.append(Data()); zeros.append(UInt32(chunk)) }
            }
            return File(path: path, size: size, chunkSize: chunkSize, chunkHashes: hashes, zeroChunks: zeros)
        })
    }
}

struct ChunkRef: Equatable {
    var global: Int
    var file: Int
    var chunk: Int
    var offset: UInt64
    var length: Int
    var hash: Data
    var isZero: Bool
}

func readExactly(_ fd: Int32, into buffer: inout Data, length: Int, offset: UInt64) throws {
    try buffer.withUnsafeMutableBytes { raw in
        var done = 0
        while done < length {
            let count = pread(fd, raw.baseAddress! + done, length - done, off_t(offset) + off_t(done))
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw TransferError.failed("short read at \(offset + UInt64(done)): \(String(cString: strerror(errno)))") }
            done += count
        }
    }
}

func isAllZero(_ bytes: UnsafeRawBufferPointer) -> Bool {
    // Word-at-a-time; chunk buffers are allocated aligned and the tail is checked bytewise.
    let words = bytes.count / 8
    let wordPointer = bytes.baseAddress!.assumingMemoryBound(to: UInt64.self)
    for index in 0..<words where wordPointer[index] != 0 { return false }
    for index in (words * 8)..<bytes.count where bytes[index] != 0 { return false }
    return true
}

func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

public enum TransferError: Error, CustomStringConvertible, Equatable {
    case failed(String)
    /// No candidate answered with the key within the punch timeout: every path tried, and why each failed.
    case unreachable(timeout: TimeInterval, attempts: [PathAttempt])

    public var description: String {
        switch self {
        case .failed(let message): message
        case let .unreachable(timeout, attempts):
            "no authenticated reply within \(Int(timeout))s (wrong key, or no path); tried: "
                + (attempts.isEmpty ? "no candidates" : attempts.map(\.description).joined(separator: "; "))
        }
    }
}
