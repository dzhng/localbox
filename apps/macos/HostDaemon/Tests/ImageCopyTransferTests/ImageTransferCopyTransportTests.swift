import Foundation
import HostDaemonCore
import ImageTransfer
import XCTest
@testable import ImageCopyTransfer

/// The daemon's transport over real UDP on loopback, the two sides meeting through an in-memory rendezvous the way the
/// copy's Convex row joins them.
final class ImageTransferCopyTransportTests: XCTestCase {
    private static let MiB = 1 << 20
    private static let key = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("lb-copy-transport-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: scratch) }

    func testAnImageCrossesAndBothSidesReportTheLocalNetwork() async throws {
        let source = try image(diskBytes: 8 * Self.MiB)
        let board = Board()
        let temp = try received()
        async let sent = transport().send(source, key: Self.key, rendezvous: board.side(.sender))
        let report = try await transport().receive(into: temp, key: Self.key, rendezvous: board.side(.receiver), progress: { _, _ in })
        let sender = try await sent

        try assertSame(source, temp)
        XCTAssertEqual([report.path, sender.path], [.localNetwork, .localNetwork])
        XCTAssertEqual(report.bytes, UInt64(8 * Self.MiB + 3 + 2), "every data byte, nothing resumed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: ResumeBitmap.url(beside: temp).path))
    }

    func testAStoppedReceiverResumesFromItsBitmapAndARestartedSenderIsFollowed() async throws {
        let source = try image(diskBytes: 16 * Self.MiB)
        let board = Board()
        let temp = try received()
        // About 2.7 MB/s: the bitmap is saved before the stop, and the sender restarts long before the receiver could finish.
        let slow = { var options = Sender.Options(); options.maxRate = 2_000; return options }()
        let firstSender = Task { try await transport(sender: slow).send(source, key: Self.key, rendezvous: board.side(.sender)) }

        // The receiver's daemon exits at 40%: its work is cancelled, the temporary and its bitmap stay.
        let midway = Gate()
        let stopped = Task { try await transport().receive(into: temp, key: Self.key, rendezvous: board.side(.receiver), progress: { done, total in if done * 10 >= total * 4 { await midway.open() } }) }
        try await midway.wait()
        stopped.cancel()
        do { _ = try await stopped.value; XCTFail("the stopped receive finished") } catch is CancellationError {}
        XCTAssertTrue(FileManager.default.fileExists(atPath: ResumeBitmap.url(beside: temp).path), "no bitmap beside the temporary")

        // The restarted receiver publishes anew and reaches the sender still serving; then the sender's daemon restarts
        // too, publishing a new port, and the receiver follows it.
        let senderMidway = Gate()
        let resumed = Task { try await transport().receive(into: temp, key: Self.key, rendezvous: board.side(.receiver), progress: { done, total in if done * 10 >= total * 7 { await senderMidway.open() } }) }
        try await senderMidway.wait()
        firstSender.cancel()
        _ = try? await firstSender.value
        async let secondSender = transport().send(source, key: Self.key, rendezvous: board.side(.sender))
        let report = try await resumed.value
        await board.finish()
        do { _ = try await secondSender } catch is Board.Finished {}

        try assertSame(source, temp)
        XCTAssertLessThan(report.bytes, UInt64(16 * Self.MiB), "the resumed receive fetched everything again")
        XCTAssertEqual(report.path, .localNetwork)
    }

    func testNoAnsweringSenderIsUnreachableNamingEveryPathTried() async throws {
        let board = Board()
        try await board.side(.sender).publish([ImageCopyCandidate(kind: "local", address: "127.0.0.1", port: 9), ImageCopyCandidate(kind: "reflexive", address: "203.0.113.9", port: 61000)])
        var quick = transport(); quick.punchTimeout = 1
        do {
            _ = try await quick.receive(into: try received(), key: Self.key, rendezvous: board.side(.receiver), progress: { _, _ in })
            XCTFail("a copy with no sender finished")
        } catch let unreachable as ImageCopyUnreachable {
            XCTAssertEqual(unreachable.tried, [
                ImageCopyAttempt(path: .localNetwork, candidate: "127.0.0.1:9", reason: "no authenticated reply within 1s"),
                ImageCopyAttempt(path: .internet, candidate: "203.0.113.9:61000", reason: "no authenticated reply within 1s"),
                ImageCopyAttempt(path: .internet, candidate: "", reason: "this side: no STUN response from 127.0.0.1:9 within 0.1s"),
            ])
        }
    }

    // MARK: - Harness

    /// Loopback only: the local path on 127.0.0.1, and a punched transport whose STUN server never answers (no internet
    /// in tests), so it gathers nothing but still tries a reflexive candidate it is offered.
    private func transport(sender: Sender.Options? = nil) -> ImageTransferCopyTransport {
        ImageTransferCopyTransport(selector: PathSelector([LANTransport(addresses: ["127.0.0.1"]), PunchedUDPTransport(stunHost: "127.0.0.1", stunPorts: [9], budget: 0.1)]), sender: sender)
    }

    private func image(diskBytes: Int) throws -> ImageCopySource {
        let directory = scratch.appendingPathComponent("source", isDirectory: true)
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("boot"), withIntermediateDirectories: true)
        try Data((0..<diskBytes).map { _ in UInt8.random(in: 0...255) }).write(to: directory.appendingPathComponent("disk.img"))
        try Data("efi".utf8).write(to: directory.appendingPathComponent("boot/efi-vars"))
        try Data("{}".utf8).write(to: directory.appendingPathComponent("image.json"))
        return ImageCopySource(directory: directory, files: ["image.json", "disk.img", "boot/efi-vars"])
    }

    private func received() throws -> URL {
        let temp = scratch.appendingPathComponent(".received", isDirectory: true)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        return temp
    }

    private func assertSame(_ source: ImageCopySource, _ temp: URL, file: StaticString = #filePath, line: UInt = #line) throws {
        for path in source.files {
            XCTAssertEqual(try Data(contentsOf: temp.appendingPathComponent(path)), try Data(contentsOf: source.directory.appendingPathComponent(path)), path, file: file, line: line)
        }
    }
}

/// The copy's row: each side's latest candidates, and whether the receiver committed (a sender still waiting then stops,
/// as `ImageCopy` ends it on a copied row).
private actor Board {
    enum Role { case sender, receiver }
    struct Finished: Error {}
    private var candidates: [Role: [ImageCopyCandidate]] = [:]
    private(set) var finished = false

    func finish() { finished = true }

    nonisolated func side(_ role: Role) -> Side { Side(board: self, role: role) }
    func publish(_ role: Role, _ published: [ImageCopyCandidate]) { candidates[role] = published }
    func peer(of role: Role) -> [ImageCopyCandidate]? { candidates[role == .sender ? .receiver : .sender] }

    struct Side: ImageCopyRendezvous {
        let board: Board, role: Role
        func publish(_ candidates: [ImageCopyCandidate]) async throws { await board.publish(role, candidates) }
        func peerCandidates(after previous: [ImageCopyCandidate]?) async throws -> [ImageCopyCandidate] {
            while true {
                if await board.finished { throw Finished() }
                if let peer = await board.peer(of: role), peer != previous { return peer }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
        }
    }
}

/// Opens once; waiters return as soon as it is open, and throw if it stays shut for 30 s.
private actor Gate {
    struct Shut: Error {}
    private var isOpen = false
    func open() { isOpen = true }
    func wait() async throws {
        for _ in 0..<3_000 where !isOpen { try await Task.sleep(nanoseconds: 10_000_000) }
        if !isOpen { throw Shut() }
    }
}
