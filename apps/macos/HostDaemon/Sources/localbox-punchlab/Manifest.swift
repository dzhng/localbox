import CryptoKit
import Foundation

/// What the receiver needs to rebuild a directory: per file, its size and one sha256 per chunk. Chunks that
/// read as all zeros (holes, or allocated zeros) are listed in `zeroChunks`, carry an empty hash, and are
/// never sent: the receiver's file is created at full size, so they stay holes there.
struct TransferManifest: Codable, Equatable {
    struct File: Codable, Equatable {
        var path: String
        var size: UInt64
        var chunkSize: UInt32
        var chunkHashes: [Data]
        var zeroChunks: [UInt32]

        var chunkCount: Int { chunkHashes.count }
        func length(ofChunk index: Int) -> Int { Int(min(UInt64(chunkSize), size - UInt64(index) * UInt64(chunkSize))) }
    }

    var files: [File]

    /// Canonical bytes: the digest of these is what the offer side announces and a resume is checked against.
    func encoded() -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try! encoder.encode(self)
    }

    static func decode(_ data: Data) throws -> TransferManifest { try JSONDecoder().decode(TransferManifest.self, from: data) }

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

    var dataBytes: UInt64 { chunks.filter { !$0.isZero }.reduce(0) { $0 + UInt64($1.length) } }

    /// Builds the manifest for `paths` (relative to `root`), reading only allocated regions: holes are found
    /// with SEEK_DATA, so an 8 GiB disk that is mostly holes costs only its data to hash.
    static func build(root: URL, paths: [String], chunkSize: UInt32) throws -> TransferManifest {
        TransferManifest(files: try paths.map { path in
            let url = root.appendingPathComponent(path)
            let fd = open(url.path, O_RDONLY)
            guard fd >= 0 else { throw PunchError("cannot open \(url.path): \(String(cString: strerror(errno)))") }
            defer { close(fd) }
            var info = stat()
            guard fstat(fd, &info) == 0 else { throw PunchError("cannot stat \(url.path)") }
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
            guard count > 0 else { throw PunchError("short read at \(offset + UInt64(done)): \(String(cString: strerror(errno)))") }
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

struct PunchError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
