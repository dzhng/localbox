import Foundation
@testable import HostDaemonCore

/// The unit tests' transport: both ends in one process, so the receiver reads the sender's files straight from its image
/// store. It exercises everything around the bytes (the rendezvous both ways, progress, resume from what the temporary
/// already holds, the sender learning the receiver is done); daemons use `ImageTransferCopyTransport`. The sender publishes
/// its directory and files; the receiver copies them `chunkBytes` at a time, pausing `pauseMs` between chunks so a
/// proof can stop it midway, and publishes `loopback-done` when it has everything.
struct LoopbackImageCopyTransport: ImageCopyTransport {
    static let root = "loopback-root", file = "loopback-file", ready = "loopback-ready", done = "loopback-done"
    let chunkBytes: Int
    let pauseMs: Int
    init(chunkBytes: Int = 1 << 20, pauseMs: Int = 0) { self.chunkBytes = chunkBytes; self.pauseMs = pauseMs }

    func send(_ image: ImageCopySource, key: Data, rendezvous: any ImageCopyRendezvous) async throws -> ImageCopyReport {
        let started = Date()
        try await rendezvous.publish([ImageCopyCandidate(kind: Self.root, address: image.directory.path, port: 0)] + image.files.enumerated().map { ImageCopyCandidate(kind: Self.file, address: $1, port: $0) })
        var seen: [ImageCopyCandidate]? = nil
        while true {
            let peer = try await rendezvous.peerCandidates(after: seen)
            if peer.contains(where: { $0.kind == Self.done }) { break }
            seen = peer
        }
        let bytes = image.files.reduce(UInt64(0)) { $0 + fileSize(image.directory.appendingPathComponent($1)) }
        return ImageCopyReport(bytes: bytes, durationMs: Int(Date().timeIntervalSince(started) * 1000), path: .localNetwork)
    }

    func receive(into temp: URL, key: Data, rendezvous: any ImageCopyRendezvous, progress: @escaping ImageCopyProgress) async throws -> ImageCopyReport {
        let started = Date()
        try await rendezvous.publish([ImageCopyCandidate(kind: Self.ready, address: "", port: 0)])
        let peer = try await rendezvous.peerCandidates(after: nil)
        guard let root = peer.first(where: { $0.kind == Self.root }) else {
            throw ImageCopyUnreachable(tried: [ImageCopyAttempt(path: .localNetwork, candidate: "loopback", reason: "the sender published no loopback directory")])
        }
        let source = URL(fileURLWithPath: root.address, isDirectory: true)
        let files = peer.filter { $0.kind == Self.file }.sorted { $0.port < $1.port }.map(\.address)
        let total = files.reduce(UInt64(0)) { $0 + fileSize(source.appendingPathComponent($1)) }
        var done: UInt64 = 0, moved: UInt64 = 0
        for relative in files {
            let from = source.appendingPathComponent(relative), to = temp.appendingPathComponent(relative)
            try FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
            let size = fileSize(from)
            // Resume: keep the whole chunks an earlier run wrote.
            var offset = min(fileSize(to), size) / UInt64(chunkBytes) * UInt64(chunkBytes)
            if !FileManager.default.fileExists(atPath: to.path) { FileManager.default.createFile(atPath: to.path, contents: nil) }
            let reader = try FileHandle(forReadingFrom: from), writer = try FileHandle(forWritingTo: to)
            defer { try? reader.close(); try? writer.close() }
            try writer.truncate(atOffset: offset)
            done += offset
            while offset < size {
                try reader.seek(toOffset: offset)
                let chunk = try reader.read(upToCount: chunkBytes) ?? Data()
                guard !chunk.isEmpty else { break }
                try writer.seek(toOffset: offset)
                try writer.write(contentsOf: chunk)
                offset += UInt64(chunk.count); done += UInt64(chunk.count); moved += UInt64(chunk.count)
                try await progress(done, total)
                if pauseMs > 0 { try await Task.sleep(nanoseconds: UInt64(pauseMs) * 1_000_000) }
            }
        }
        try await rendezvous.publish([ImageCopyCandidate(kind: Self.done, address: "", port: 0)])
        return ImageCopyReport(bytes: moved, durationMs: Int(Date().timeIntervalSince(started) * 1000), path: .localNetwork)
    }
}

private func fileSize(_ url: URL) -> UInt64 { ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.uint64Value ?? 0 }
