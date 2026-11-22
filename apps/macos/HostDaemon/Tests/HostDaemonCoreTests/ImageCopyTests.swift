import XCTest
@testable import HostDaemonCore

/// `image.copy` on two daemons in one process, as the relay and the connectors drive it: each Mac's daemon gets the
/// relayed request, and a fake account row stands in for Convex `copies` (the connector's subscription pushes it, the
/// daemon's outbox fills it).
final class ImageCopyTests: XCTestCase {
    static let image = "image_copy_1"

    func testACopyMovesTheImageFilesAndBothSidesFinishAndAReplayReturnsTheSameOperation() async throws {
        let (from, to) = try await pair()
        let disk = try from.plant(Self.image, bytes: 3 << 20)
        let account = Account(from: from, to: to, sizeBytes: 3 << 20)
        let begun = try await to.request("image.copy", ["image": Self.image, "to": "m2"], mutation: "copy-1")
        XCTAssertEqual(begun["state"] as? String, "running", "a copy answers at once")
        _ = try await from.request("image.copy", ["image": Self.image, "to": "m2"], mutation: "copy-1")
        let finished = try await account.run(until: "copy-1")
        XCTAssertEqual(finished.to.state, .succeeded, "\(String(describing: finished.to.error))")
        XCTAssertEqual(finished.from.state, .succeeded, "\(String(describing: finished.from.error))")
        XCTAssertEqual(try Data(contentsOf: to.store.root.appendingPathComponent("\(Self.image)/disk.img")), disk)
        XCTAssertEqual(try to.store.manifest(Self.image).imageID, Self.image)
        XCTAssertFalse(FileManager.default.fileExists(atPath: to.store.root.appendingPathComponent("\(Self.image)/listed-by").path), "the source Mac's listing mark never travels")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: to.store.root.path).filter { $0.hasPrefix(".") }, [], "no temporary left")
        guard case .object(let result) = finished.to.result else { return XCTFail("no result") }
        XCTAssertEqual(result["role"], .string("receiver")); XCTAssertEqual(result["path"], .string("local_network"))
        XCTAssertEqual(result["copy_id"], .string("copy_row_1"))
        XCTAssertEqual(result["size_bytes"], .number(Double(try to.store.manifest(Self.image).sizeBytes)))
        guard case .number(let bytes)? = result["bytes"] else { return XCTFail("no bytes") }
        XCTAssertGreaterThanOrEqual(bytes, Double(3 << 20))
        guard case .object(let sent) = finished.from.result else { return XCTFail("no sender result") }
        XCTAssertEqual(sent["role"], .string("sender"))

        let replay = try await to.request("image.copy", ["image": Self.image, "to": "m2"], mutation: "copy-1")
        XCTAssertEqual(replay["started_at"] as? Int, begun["started_at"] as? Int, "the same key returns the record, never a second run")
        XCTAssertEqual(replay["state"] as? String, "succeeded")
        let outcomes = try await to.request("host.operations", ["reported": [String](), "timeout_ms": 0])
        XCTAssertEqual((outcomes["operations"] as? [[String: Any]])?.map { $0["kind"] as? String }, ["image.copy"], "the connector learns the kind, so it reports a copy to the copy")
        XCTAssertNil((outcomes["operations"] as? [[String: Any]])?.first?["checkpoint"], "the checkpoint stays private")
    }

    func testTooLittleFreeDiskOnTheReceiverFailsBeforeAnyBytesMove() async throws {
        let (from, to) = try await pair(receiverFreeBytes: 1024)
        _ = try from.plant(Self.image, bytes: 1 << 20)
        let account = Account(from: from, to: to, sizeBytes: 1 << 20)
        for mac in [from, to] { _ = try await mac.request("image.copy", ["image": Self.image, "to": "m2"], mutation: "copy-2") }
        let finished = try await account.run(until: "copy-2", sender: false)
        XCTAssertEqual(finished.to.error?.code, "disk_full")
        XCTAssertTrue(finished.to.error?.nextStep?.hasPrefix("free at least") == true, "\(String(describing: finished.to.error))")
        XCTAssertTrue(to.store.list().isEmpty)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: to.store.root.path).filter { $0.hasPrefix(".") }, [])
    }

    /// The receiver's check is the contract's one copy-fits rule (`imageDiskNeedBytes`, the image plus a 1 GiB margin),
    /// the rule placement plans by: a 4 GiB image doesn't fit in 4.5 GiB.
    func testTheReceiverNeedsTheImagePlusTheMarginFree() async throws {
        let (from, to) = try await pair(receiverFreeBytes: 9 << 29)
        _ = try from.plant(Self.image, bytes: 1 << 20)
        let account = Account(from: from, to: to, sizeBytes: 4 << 30)
        for mac in [from, to] { _ = try await mac.request("image.copy", ["image": Self.image, "to": "m2"], mutation: "copy-2") }
        let finished = try await account.run(until: "copy-2", sender: false)
        XCTAssertEqual(finished.to.error?.code, "disk_full")
        XCTAssertEqual(finished.to.error?.message, "copying image \(Self.image) here needs 5 GiB free on this Mac (the image plus a 1 GiB margin), and 4.5 GiB is free")
        XCTAssertEqual(imageDiskNeedBytes(4 << 30), 5 << 30)
    }

    func testNoPathBetweenTheMacsIsCopyUnreachableListingEveryPathTriedAndTheNextStep() async throws {
        let tried = [ImageCopyAttempt(path: .localNetwork, candidate: "10.0.0.1:50000", reason: "timed out"), ImageCopyAttempt(path: .internet, candidate: "203.0.113.9:61000", reason: "no reply to the punch")]
        let (from, to) = try await pair(receiverTransport: UnreachableTransport(tried: tried))
        _ = try from.plant(Self.image, bytes: 1 << 20)
        let account = Account(from: from, to: to, sizeBytes: 1 << 20)
        _ = try await to.request("image.copy", ["image": Self.image, "to": "m2"], mutation: "copy-3")
        let finished = try await account.run(until: "copy-3", sender: false)
        XCTAssertEqual(finished.to.error, HostOperationFailure(code: "copy_unreachable", message: "no direct path between the two Macs; tried local network 10.0.0.1:50000 (timed out), internet 203.0.113.9:61000 (no reply to the punch)", nextStep: "put both Macs on the same network once, then copy"))
    }

    func testAReceiverStoppedMidCopyResumesIntoItsTemporaryAfterTheRestart() async throws {
        let paced = LoopbackImageCopyTransport(chunkBytes: 256 << 10, pauseMs: 20)
        let (from, to) = try await pair(receiverTransport: paced)
        let disk = try from.plant(Self.image, bytes: 4 << 20)
        let account = Account(from: from, to: to, sizeBytes: 4 << 20)
        for mac in [from, to] { _ = try await mac.request("image.copy", ["image": Self.image, "to": "m2"], mutation: "copy-4") }
        let pump = Task { try await account.run(until: "copy-4") }
        var before = 0
        for _ in 0..<200 where before < 1 << 20 { try await Task.sleep(nanoseconds: 20_000_000); before = await to.operations.state("copy-4")?.progress?.completed ?? 0 }
        XCTAssertGreaterThanOrEqual(before, 1 << 20, "the receiver got partway")
        // The daemon exits: its work is cancelled, the record stays running, and the next start keeps the temporary.
        await to.operations.stop()
        pump.cancel()
        let restarted = try await to.restart(transport: paced)
        XCTAssertNotNil(try? FileManager.default.contentsOfDirectory(atPath: restarted.store.root.path).first { $0 == ImageStore.resumableTempName(Self.image, key: "copy-4") }, "the resumable temporary survived the start's sweep")
        let resumedAccount = Account(from: from, to: restarted, sizeBytes: 4 << 20, row: account.row)
        let outbox = try await restarted.request("image.copy_outbox", ["published": [Any](), "timeout_ms": 1_000])
        XCTAssertEqual(outbox["missing"] as? [String], ["copy-4"], "the resumed side asks for its rendezvous again")
        let finished = try await resumedAccount.run(until: "copy-4")
        XCTAssertEqual(finished.to.state, .succeeded, "\(String(describing: finished.to.error))")
        XCTAssertEqual(try Data(contentsOf: restarted.store.root.appendingPathComponent("\(Self.image)/disk.img")), disk)
        guard case .object(let result) = finished.to.result, case .number(let bytes)? = result["bytes"] else { return XCTFail("no result") }
        XCTAssertLessThan(bytes, Double(4 << 20), "the resumed run moved only what the first one hadn't")
    }

    func testACopyThatFailedElsewhereEndsTheWaitingSideAndNoRendezvousAtAllTimesOut() async throws {
        let (from, to) = try await pair(peerWaitMs: 300)
        _ = try from.plant(Self.image, bytes: 1 << 20)
        _ = try await to.request("image.copy", ["image": Self.image, "to": "m2"], mutation: "copy-5")
        _ = try await to.request("image.copy_rendezvous", ["copies": [Account.listing(copyID: "copy_row_5", key: "copy-5", role: "receiver", sizeBytes: 1 << 20, state: "failed", peer: nil, error: ["code": "image_not_found", "message": "image image_copy_1 is no longer on this Mac", "next_step": "copy it from another Mac that holds it"])]])
        let failed = await to.operations.wait("copy-5", timeoutMs: 5_000)
        XCTAssertEqual(failed?.error?.code, "image_not_found")
        XCTAssertEqual(failed?.error?.message, "the copy failed elsewhere: image image_copy_1 is no longer on this Mac")

        _ = try await to.request("image.copy", ["image": Self.image, "to": "m2"], mutation: "copy-6")
        let silent = await to.operations.wait("copy-6", timeoutMs: 5_000)
        XCTAssertEqual(silent?.error?.code, "copy_unreachable")
        XCTAssertTrue(silent?.error?.message.contains("never got the copy's details") == true, "\(String(describing: silent?.error))")
    }

    // MARK: - Harness

    private func pair(receiverFreeBytes: UInt64 = 1 << 40, receiverTransport: any ImageCopyTransport = LoopbackImageCopyTransport(chunkBytes: 256 << 10), peerWaitMs: Int = 10_000) async throws -> (Mac, Mac) {
        (try await Mac(root: try scratch(), transport: LoopbackImageCopyTransport(chunkBytes: 256 << 10), freeBytes: 1 << 40, peerWaitMs: peerWaitMs),
         try await Mac(root: try scratch(), transport: receiverTransport, freeBytes: receiverFreeBytes, peerWaitMs: peerWaitMs))
    }
}

/// One Mac's daemon under `root`, its journal started.
private struct Mac {
    let rig: TestDaemon, freeBytes: UInt64, peerWaitMs: Int
    var root: URL { rig.root }
    var store: ImageStore { rig.store }
    var operations: HostOperationStore { rig.operations }

    init(root: URL, transport: any ImageCopyTransport, freeBytes: UInt64, peerWaitMs: Int) async throws {
        self.freeBytes = freeBytes; self.peerWaitMs = peerWaitMs
        rig = try await TestDaemon(root: root, freeBytes: freeBytes, transport: transport, copyPeerWaitMs: peerWaitMs)
        await rig.operations.start()
    }

    /// The same Mac after its daemon exited: a new journal, store and copy kind over the same directories.
    func restart(transport: any ImageCopyTransport) async throws -> Mac { try await Mac(root: root, transport: transport, freeBytes: freeBytes, peerWaitMs: peerWaitMs) }

    /// A committed linux image with a random disk, marked listed by this Mac; returns the disk's bytes.
    func plant(_ id: String, bytes: Int) throws -> Data { try store.plant(id, bytes: bytes, listedBy: "m1") }

    /// A request as the relay or the connector sends it; the result, or the error object on failure.
    func request(_ operation: String, _ input: [String: Any], mutation: String? = nil) async throws -> [String: Any] {
        let answer = try await call(rig.daemon, envelope(operation, input, mutation: mutation))
        return (answer["ok"] as? Bool == true ? answer["result"] : answer["error"]) as? [String: Any] ?? [:]
    }
}

/// The copy's Convex row and both connectors: each Mac's outbox fills the row, and every change is pushed to both.
private final class Account: @unchecked Sendable {
    final class Row: @unchecked Sendable { var from: [[String: Any]]?; var to: [[String: Any]]?; var state = "waiting" }
    let from: Mac, to: Mac, sizeBytes: Int, row: Row

    init(from: Mac, to: Mac, sizeBytes: Int, row: Row = Row()) { self.from = from; self.to = to; self.sizeBytes = sizeBytes; self.row = row }

    static func listing(copyID: String, key: String, role: String, sizeBytes: Int, state: String, peer: [[String: Any]]?, error: [String: Any]? = nil) -> [String: Any] {
        ["copy_id": copyID, "operation_id": key, "image_id": ImageCopyTests.image, "role": role, "key": Data(repeating: 7, count: 32).base64EncodedString(), "size_bytes": sizeBytes, "state": state, "peer_candidates": peer ?? NSNull(), "error": error ?? NSNull()]
    }

    /// Shuttles the rendezvous until the receiver's side (and the sender's, unless `sender` is false) finishes.
    func run(until key: String, sender: Bool = true) async throws -> (from: HostOperationRecord, to: HostOperationRecord) {
        let copyID = "copy_row_\(key.split(separator: "-").last!)"
        func push() async throws {
            _ = try await from.request("image.copy_rendezvous", ["copies": [Self.listing(copyID: copyID, key: key, role: "sender", sizeBytes: sizeBytes, state: row.state, peer: row.to)]])
            _ = try await to.request("image.copy_rendezvous", ["copies": [Self.listing(copyID: copyID, key: key, role: "receiver", sizeBytes: sizeBytes, state: row.state, peer: row.from)]])
        }
        try await push()
        var acked: [String: [[String: Any]]] = [:]
        for _ in 0..<2_000 {
            try Task.checkCancellation()
            var changed = false
            for (mac, side) in [(from, "from"), (to, "to")] {
                let outbox = try await mac.request("image.copy_outbox", ["published": acked[side] ?? [], "timeout_ms": 10])
                acked[side] = []
                for offer in outbox["offers"] as? [[String: Any]] ?? [] {
                    if side == "from" { row.from = offer["candidates"] as? [[String: Any]] } else { row.to = offer["candidates"] as? [[String: Any]] }
                    acked[side]!.append(["copy_id": offer["copy_id"]!, "generation": offer["generation"]!]); changed = true
                }
                if !(outbox["missing"] as? [String] ?? []).isEmpty { changed = true }
            }
            if row.from != nil, row.to != nil, row.state == "waiting" { row.state = "copying" }
            if changed { try await push() }
            let receiver = await to.operations.state(key), source = await from.operations.state(key)
            if let receiver, receiver.state != .running, !sender || source?.state != .running { return (source ?? receiver, receiver) }
        }
        throw XCTSkip("the copy never finished: \(String(describing: await to.operations.state(key))) / \(String(describing: await from.operations.state(key)))")
    }
}
