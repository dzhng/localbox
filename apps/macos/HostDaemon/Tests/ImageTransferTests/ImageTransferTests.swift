import CryptoKit
import Foundation
import XCTest
@testable import ImageTransfer

final class ImageTransferTests: XCTestCase {
    private static let MiB = 1 << 20
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("lb-transfer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: scratch) }

    // MARK: - Gates

    func testAnImageCrossesALossyReorderingNetworkIntactWithHolesPreserved() async throws {
        let source = try makeImage("source", diskSize: 64 * Self.MiB, extents: [(0, 3 * Self.MiB), (20 * Self.MiB, 2 * Self.MiB + 4096), (63 * Self.MiB, Self.MiB)])
        let network = MemoryNetwork(.init(loss: 0.03, reorder: 0.05))
        let pair = pair(on: network)
        let temp = scratch.appendingPathComponent("received")

        let (report, sent) = try await transfer(source, into: temp, pair)

        try assertSameImage(source, temp)
        XCTAssertTrue(sent.finished)
        XCTAssertEqual(report.path.kind, .local)
        XCTAssertEqual(report.path.flows, 2)
        XCTAssertEqual(report.bytes, try TransferManifest.build(directory: source).dataBytes)
        XCTAssertEqual(report.stats.receivedBytes, report.bytes)
        XCTAssertGreaterThan(report.stats.lostFragments, 0, "the network dropped 3% but the receiver saw no loss")
        XCTAssertFalse(FileManager.default.fileExists(atPath: ResumeBitmap.url(beside: temp).path), "the bitmap outlived a finished transfer")
    }

    func testLoopbackUDPMovesAnImage() async throws {
        let source = try makeImage("source", diskSize: 256 * Self.MiB, extents: [(0, 16 * Self.MiB), (128 * Self.MiB, 16 * Self.MiB)])
        let selector = PathSelector([LANTransport(addresses: ["127.0.0.1"])])
        let sender = TransferEndpoint(port: try UDPSocket(delivery: DispatchQueue(label: "test.send")), selector: selector)
        let receiver = TransferEndpoint(port: try UDPSocket(delivery: DispatchQueue(label: "test.receive")), selector: selector)
        defer { sender.close(); receiver.close() }
        let temp = scratch.appendingPathComponent("received")

        let (report, sent) = try await transfer(source, into: temp, (sender, receiver))

        try assertSameImage(source, temp)
        XCTAssertTrue(sent.finished)
        XCTAssertEqual(report.path.candidate, Candidate(kind: .local, address: "127.0.0.1", port: sender.port.localPort))
        XCTAssertEqual(report.bytes, UInt64(32 * Self.MiB + 64 * 1024 + 2))
    }

    func testAKilledReceiverResumesFromItsBitmapAndRefetchesAClaimedChunkThatNoLongerHashes() async throws {
        let source = try makeImage("source", diskSize: 32 * Self.MiB, extents: [(0, 24 * Self.MiB)], bootStore: false)
        let manifest = try TransferManifest.build(directory: source)
        let network = MemoryNetwork(.init(loss: 0.01))
        let pair = pair(on: network)
        let key = SymmetricKey(size: .bits256)
        var slow = Sender.Options(); slow.maxRate = 8_000  // about 11 MB/s, so the bitmap is saved before 40%
        let sending = Task { try await Sender.send(directory: source, manifest: manifest, key: key, over: pair.sender, options: slow) }
        let temp = scratch.appendingPathComponent("received")

        let reachedFortyPercent = expectation(description: "40%")
        var options = Receiver.Options()
        options.progress = { if $0.fraction >= 0.4 { reachedFortyPercent.fulfill() } }
        reachedFortyPercent.assertForOverFulfill = false
        let killed = Task { try await Receiver.receive(into: temp, key: key, offer: pair.sender.candidates, over: pair.receiver, options: options) }
        await fulfillment(of: [reachedFortyPercent], timeout: 30)
        killed.cancel()
        do { _ = try await killed.value; XCTFail("the cancelled receive finished") } catch is CancellationError {}

        let bitmapURL = ResumeBitmap.url(beside: temp)
        let saved = try XCTUnwrap(ResumeBitmap.load(bitmapURL, manifestDigest: sha256(manifest.encoded()), count: manifest.chunkCount), "no bitmap beside the temp directory after the kill")
        let claimed = (0..<saved.count).filter { saved[$0] }
        XCTAssertGreaterThan(claimed.count, 2)
        // A torn write the bitmap still claims: the resume must re-hash it and fetch it again.
        let disk = try FileHandle(forWritingTo: temp.appendingPathComponent("disk.img"))
        try disk.seek(toOffset: UInt64(claimed[1] * Self.MiB)); disk.write(Data(repeating: 0xEE, count: 4096)); try disk.close()

        let restarted = TransferEndpoint(port: network.port(host: "10.0.0.2"), selector: pair.receiver.selector)
        let report = try await Receiver.receive(into: temp, key: key, offer: pair.sender.candidates, over: restarted)
        let sent = try await sending.value

        try assertSameImage(source, temp)
        XCTAssertTrue(sent.finished)
        XCTAssertEqual(report.stats.resumeRejectedChunks, 1)
        XCTAssertEqual(report.stats.resumedChunks, claimed.count - 1)
        XCTAssertEqual(report.stats.resumedBytes + report.stats.receivedBytes, report.bytes)
        XCTAssertLessThan(report.stats.receivedBytes, report.bytes, "the resume fetched everything again")
    }

    func testATamperedDatagramAndACorruptedChunkAreRefusedAndFetchedAgain() async throws {
        let source = try makeImage("source", diskSize: 16 * Self.MiB, extents: [(0, 8 * Self.MiB)])
        let key = SymmetricKey(size: .bits256)
        let cipher = PacketCipher(key: key)
        let lock = NSLock()
        var dataDatagrams = 0, corrupted = false
        let network = MemoryNetwork(.init(tamper: { datagram in
            guard let header = PacketHeader(datagram), header.kind == .data else { return datagram }
            return lock.withLock {
                dataDatagrams += 1
                var out = datagram
                if dataDatagrams == 50 { out[out.startIndex + PacketHeader.size + 3] ^= 0x01 }  // fails AEAD
                if !corrupted, header.stream == 2, header.chunk == 3, let (_, plaintext) = cipher.open(datagram) {
                    // Authentic but wrong: only the chunk's sha256 can catch it.
                    var flipped = plaintext; flipped[flipped.startIndex] ^= 0xFF
                    out = cipher.seal(header, flipped); corrupted = true
                }
                return out
            }
        }))
        let temp = scratch.appendingPathComponent("received")

        let (report, _) = try await transfer(source, into: temp, pair(on: network), key: key)

        try assertSameImage(source, temp)
        XCTAssertTrue(corrupted)
        XCTAssertGreaterThanOrEqual(report.stats.rejectedDatagrams, 1)
        XCTAssertGreaterThanOrEqual(report.stats.rejectedChunks, 1)
    }

    func testAReceiverWithTheWrongKeyGetsNoReplyAndTheSenderAuthenticatesNothing() async throws {
        let source = try makeImage("source", diskSize: 4 * Self.MiB, extents: [(0, Self.MiB)])
        let pair = pair(on: MemoryNetwork())
        var patient = Sender.Options(); patient.idleTimeout = 2
        let sending = Task { try await Sender.send(directory: source, manifest: try TransferManifest.build(directory: source), key: SymmetricKey(size: .bits256), over: pair.sender, options: patient) }
        var options = Receiver.Options(); options.punchTimeout = 1
        let temp = scratch.appendingPathComponent("received")

        do {
            _ = try await Receiver.receive(into: temp, key: SymmetricKey(size: .bits256), offer: pair.sender.candidates, over: pair.receiver, options: options)
            XCTFail("a receiver with the wrong key finished")
        } catch let error as TransferError {
            XCTAssertTrue("\(error)".contains("no authenticated reply"), "\(error)")
        }
        let sent = try await sending.value
        XCTAssertFalse(sent.finished)
        XCTAssertGreaterThanOrEqual(sent.rejectedDatagrams, 1)
        XCTAssertTrue(sent.peers.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: temp.path), "the receiver wrote with nothing authenticated")
    }

    // MARK: - Paths

    func testTheLocalPathWinsWhenBothWorkAndThePunchedPathWhenOnlyItAnswers() async throws {
        let source = try makeImage("source", diskSize: 4 * Self.MiB, extents: [(0, 2 * Self.MiB)])
        let network = MemoryNetwork()
        network.addStunServer(host: "stun.test", publicHost: "203.0.113.7")
        let punched = PunchedUDPTransport(stunHost: "stun.test", budget: 1)

        let both = (sender: TransferEndpoint(port: network.port(host: "10.0.0.1"), selector: PathSelector([LANTransport(addresses: ["10.0.0.1"]), punched])),
                    receiver: TransferEndpoint(port: network.port(host: "10.0.0.2"), selector: PathSelector([LANTransport(addresses: ["10.0.0.2"]), punched])))
        XCTAssertEqual(both.sender.candidates.map(\.kind), [.local, .reflexive])
        XCTAssertEqual(both.sender.nat?.mapping, "endpoint-independent")
        let local = try await transfer(source, into: scratch.appendingPathComponent("local"), both).0
        XCTAssertEqual(local.path.kind, .local)

        // The sender's interface address is unreachable from here; its STUN mapping is not. The sender doesn't punch:
        // this network doesn't rewrite source addresses, so its probes would arrive from its real address.
        let across = (sender: TransferEndpoint(port: network.port(host: "10.0.0.1"), selector: PathSelector([LANTransport(addresses: ["192.168.50.9"]), punched])),
                      receiver: TransferEndpoint(port: network.port(host: "10.0.0.2"), selector: PathSelector([LANTransport(addresses: ["10.0.0.2"]), punched])))
        let internet = try await transfer(source, into: scratch.appendingPathComponent("punched"), across, punch: false).0
        XCTAssertEqual(internet.path.kind, .punched)
        XCTAssertEqual(internet.path.candidate.kind, .reflexive)
        XCTAssertEqual(internet.path.flows, 1)
        try assertSameImage(source, scratch.appendingPathComponent("punched"))
    }

    func testAnUnreachableSenderReportsEveryPathTriedAndWhy() async throws {
        let network = MemoryNetwork()  // no STUN server: this side's punched transport has nothing to offer
        let receiver = TransferEndpoint(port: network.port(host: "10.0.0.2"), selector: PathSelector([LANTransport(addresses: ["10.0.0.2"]), PunchedUDPTransport(stunHost: "stun.test", budget: 0.5)]))
        XCTAssertEqual(receiver.unavailable.map(\.path), [.punched])
        var options = Receiver.Options(); options.punchTimeout = 1
        let offer = [Candidate(kind: .local, address: "192.168.50.9", port: 41_000)]

        do {
            _ = try await Receiver.receive(into: scratch.appendingPathComponent("received"), key: SymmetricKey(size: .bits256), offer: offer, over: receiver, options: options)
            XCTFail("reached a sender that isn't there")
        } catch let TransferError.unreachable(timeout, attempts) {
            XCTAssertEqual(timeout, 1)
            XCTAssertEqual(attempts.map(\.path), [.local, .punched, .punched])
            XCTAssertEqual(attempts[0].candidate, offer[0])
            XCTAssertTrue(attempts[0].reason.contains("no authenticated reply"), attempts[0].reason)
            XCTAssertEqual(attempts[1].reason, "the sender offered no punched candidate")
            XCTAssertTrue(attempts[2].reason.contains("no STUN response"), attempts[2].reason)
        }
    }

    // MARK: - Manifest

    func testTheManifestCoversTheImageDirectoryAndListsHolesAndZerosAsZeroChunks() throws {
        let source = try makeImage("source", diskSize: 8 * Self.MiB, extents: [(Self.MiB, Self.MiB)])
        let disk = try FileHandle(forWritingTo: source.appendingPathComponent("disk.img"))
        try disk.seek(toOffset: UInt64(4 * Self.MiB)); disk.write(Data(count: Self.MiB)); try disk.close()  // allocated, all zeros

        let manifest = try TransferManifest.build(directory: source)

        XCTAssertEqual(manifest.files.map(\.path), ["boot/efi-vars", "disk.img", "image.json"])
        let diskEntry = manifest.files[1]
        XCTAssertEqual(diskEntry.zeroChunks, [0, 2, 3, 4, 5, 6, 7])
        XCTAssertEqual(diskEntry.chunkHashes[1].count, 32)
        XCTAssertTrue(diskEntry.chunkHashes[4].isEmpty)
        XCTAssertEqual(try TransferManifest.decode(manifest.encoded()), manifest)
    }

    func testAManifestNamingAPathOutsideTheDirectoryIsRefused() throws {
        for path in ["../escape", "/etc/hosts", "boot/../../escape", "", "a//b", "./disk.img"] {
            let manifest = TransferManifest(files: [.init(path: path, size: 0, chunkSize: 1 << 20, chunkHashes: [], zeroChunks: [])])
            XCTAssertThrowsError(try TransferManifest.decode(manifest.encoded()), path)
        }
        let duplicate = TransferManifest(files: [.init(path: "disk.img", size: 0, chunkSize: 1 << 20, chunkHashes: [], zeroChunks: []),
                                                 .init(path: "disk.img", size: 0, chunkSize: 1 << 20, chunkHashes: [], zeroChunks: [])])
        XCTAssertThrowsError(try TransferManifest.decode(duplicate.encoded()))
    }

    // MARK: - Helpers

    private func pair(on network: MemoryNetwork) -> (sender: TransferEndpoint, receiver: TransferEndpoint) {
        (TransferEndpoint(port: network.port(host: "10.0.0.1"), selector: PathSelector([LANTransport(addresses: ["10.0.0.1"])])),
         TransferEndpoint(port: network.port(host: "10.0.0.2"), selector: PathSelector([LANTransport(addresses: ["10.0.0.2"])])))
    }

    private func transfer(_ source: URL, into temp: URL, _ pair: (sender: TransferEndpoint, receiver: TransferEndpoint), key: SymmetricKey = SymmetricKey(size: .bits256), punch: Bool = true) async throws -> (TransferReport, SenderReport) {
        let manifest = try TransferManifest.build(directory: source)
        let (answers, answer) = AsyncStream<[Candidate]>.makeStream()
        if punch { answer.yield(pair.receiver.candidates) }
        let sending = Task { try await Sender.send(directory: source, manifest: manifest, key: key, over: pair.sender, answers: answers) }
        do {
            let report = try await Receiver.receive(into: temp, key: key, offer: pair.sender.candidates, over: pair.receiver)
            return (report, try await sending.value)
        } catch {
            sending.cancel()
            throw error
        }
    }

    /// An image directory: a sparse disk with random data in `extents`, a boot store, and its manifest file.
    private func makeImage(_ name: String, diskSize: Int, extents: [(offset: Int, length: Int)], bootStore: Bool = true) throws -> URL {
        let directory = scratch.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let diskURL = directory.appendingPathComponent("disk.img")
        FileManager.default.createFile(atPath: diskURL.path, contents: nil)
        let disk = try FileHandle(forWritingTo: diskURL)
        try disk.truncate(atOffset: UInt64(diskSize))
        var random = SplitMix(seed: UInt64(diskSize))
        for (offset, length) in extents {
            try disk.seek(toOffset: UInt64(offset))
            var bytes = [UInt8](repeating: 0, count: length)
            bytes.withUnsafeMutableBytes { raw in
                let words = raw.bindMemory(to: UInt64.self)
                for index in words.indices { words[index] = random.next() | 1 }
            }
            disk.write(Data(bytes))
        }
        try disk.close()
        guard bootStore else { return directory }
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("boot"), withIntermediateDirectories: true)
        try Data((0..<(64 * 1024)).map { UInt8(truncatingIfNeeded: $0 * 7 + 1) }).write(to: directory.appendingPathComponent("boot/efi-vars"))
        try Data("{}".utf8).write(to: directory.appendingPathComponent("image.json"))
        return directory
    }

    /// Same files, same bytes, and the received disk's holes still holes.
    private func assertSameImage(_ source: URL, _ received: URL, file: StaticString = #filePath, line: UInt = #line) throws {
        let names = try FileManager.default.subpathsOfDirectory(atPath: source.path).filter { !$0.hasSuffix("boot") }.sorted()
        XCTAssertEqual(try FileManager.default.subpathsOfDirectory(atPath: received.path).filter { !$0.hasSuffix("boot") }.sorted(), names, file: file, line: line)
        for name in names {
            let a = try Data(contentsOf: source.appendingPathComponent(name)), b = try Data(contentsOf: received.appendingPathComponent(name))
            XCTAssertTrue(a == b, "\(name) differs", file: file, line: line)
        }
        let sourceAllocated = try allocated(source.appendingPathComponent("disk.img")), receivedAllocated = try allocated(received.appendingPathComponent("disk.img"))
        XCTAssertLessThanOrEqual(Double(receivedAllocated), Double(sourceAllocated) * 1.1 + Double(Self.MiB), "holes not preserved: \(receivedAllocated) allocated vs \(sourceAllocated)", file: file, line: line)
    }

    private func allocated(_ url: URL) throws -> Int {
        var info = stat()
        guard stat(url.path, &info) == 0 else { throw TransferError.failed("cannot stat \(url.path)") }
        return Int(info.st_blocks) * 512
    }
}
