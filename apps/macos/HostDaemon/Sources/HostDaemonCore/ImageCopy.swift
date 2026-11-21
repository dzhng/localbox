import Foundation

/// Host operation kind `image.copy` (`image copy NAME --to M`), on both ends: the sender serves its `ImageStore` files
/// and the receiver writes them into a resumable temporary, checks the manifest and commits. Both journal their side
/// under the copy's mutation id with the image as subject; which side a Mac is, and the copy's one-time key, come from
/// the copy's Convex row, which the connector hands over (`absorb`). Where each end can be reached goes the other way:
/// the transport publishes candidates, the connector picks them up (`outbox`) and puts them on the row.
///
/// Checkpoint: `{ role, copy_id }` once the rendezvous arrived, plus `bytes`, `duration_ms`, `path` once the receiver has
/// everything. A resume waits for the rendezvous again (the key is never journaled); a receiver that committed only
/// records the result, and one that didn't resumes the transfer into the temporary the daemon's start kept.
public actor ImageCopy {
    public static let kind = "image.copy"
    /// Free disk a receiver leaves beyond the image, so a copy never fills the Mac.
    public static let marginBytes: UInt64 = 1 << 30
    public static let unreachableNextStep = "put both Macs on the same network once, then copy"
    /// How often a running copy journals its byte count.
    static let progressIntervalMs = 250

    /// One copy's row, as this Mac's side needs it.
    struct Rendezvous: Sendable {
        let copyID: String, role: String, key: Data, sizeBytes: UInt64?, state: String
        let peerCandidates: [ImageCopyCandidate]?
        let error: HostOperationFailure?
    }

    private let store: ImageStore
    private let operations: HostOperationStore
    private let transport: any ImageCopyTransport
    private let freeBytes: @Sendable () throws -> UInt64
    /// How long a side waits for the copy's row or for the peer before failing `copy_unreachable`.
    private let peerWaitMs: Int

    private var rows: [String: Rendezvous] = [:]
    private var waiters: [String: [UUID: CheckedContinuation<Void, Never>]] = [:]
    /// Candidates this Mac's sides published and the connector has not yet acknowledged, by copy id.
    private var offers: [String: (candidates: [ImageCopyCandidate], generation: Int)] = [:]
    private var generation = 0
    /// Operations whose work waits for a row it has not been given, and those `outbox` already named.
    private var awaiting: Set<String> = [], named: Set<String> = []
    private var outboxWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]
    private var lastProgress: [String: Date] = [:]

    /// `freeBytes` defaults to the images volume's; tests pass a smaller one and a shorter `peerWaitMs`.
    public init(store: ImageStore, operations: HostOperationStore, transport: any ImageCopyTransport, freeBytes: (@Sendable () throws -> UInt64)? = nil, peerWaitMs: Int = 120_000) {
        self.store = store; self.operations = operations; self.transport = transport; self.peerWaitMs = peerWaitMs
        self.freeBytes = freeBytes ?? { [store] in try store.freeBytes() }
    }

    /// Registers the kind; before the operation store starts.
    public func attach() async {
        await operations.register(kind: Self.kind) { [self] context in try await self.run(context) }
    }

    /// Starts this Mac's side of copying `imageID` under `key` (the copy's mutation id), or returns the side already
    /// under that key.
    public func begin(key: String, imageID: String) async throws -> HostOperationRecord {
        try await operations.begin(kind: Self.kind, key: key, subject: imageID, checkpoint: .object([:]))
    }

    /// This Mac's copies as the account lists them (`images:copiesForMachine`), from the connector.
    public func absorb(_ listed: [[String: Any]]) {
        for row in listed {
            guard let key = row["operation_id"] as? String, let copyID = row["copy_id"] as? String, let role = row["role"] as? String,
                  let keyText = row["key"] as? String, let secret = Data(base64Encoded: keyText) else { continue }
            let error = (row["error"] as? [String: Any]).map { HostOperationFailure(code: $0["code"] as? String ?? "internal", message: $0["message"] as? String ?? "the copy failed", nextStep: $0["next_step"] as? String) }
            let peer = (row["peer_candidates"] as? [[String: Any]]).map { $0.compactMap(Self.candidate) }
            rows[key] = Rendezvous(copyID: copyID, role: role, key: secret, sizeBytes: (row["size_bytes"] as? NSNumber)?.uint64Value, state: row["state"] as? String ?? "waiting", peerCandidates: peer, error: error)
            awaiting.remove(key); named.remove(key)
            for continuation in (waiters.removeValue(forKey: key) ?? [:]).values { continuation.resume() }
        }
    }

    /// The connector's long poll: candidates to publish, and operations missing their row (named once each, so a
    /// connector that has no row for one doesn't spin). Acknowledged offers go; waits up to `timeoutMs` for news.
    public func outbox(published: [(copyID: String, generation: Int)], timeoutMs: Int) async -> [String: Any] {
        for (copyID, acked) in published where (offers[copyID]?.generation ?? .max) <= acked { offers[copyID] = nil }
        if offers.isEmpty, awaiting.subtracting(named).isEmpty {
            let id = UUID(), timeout = UInt64(min(max(timeoutMs, 0), HostOperationStore.maxWaitMs)) * 1_000_000
            let timer = Task { [weak self] in try? await Task.sleep(nanoseconds: timeout); await self?.wakeOutbox(id) }
            await withCheckedContinuation { outboxWaiters[id] = $0 }
            timer.cancel()
        }
        named.formUnion(awaiting)
        let listed = offers.sorted { $0.key < $1.key }.map { copyID, offer -> [String: Any] in
            ["copy_id": copyID, "generation": offer.generation, "candidates": offer.candidates.map { ["kind": $0.kind, "address": $0.address, "port": $0.port] as [String: Any] }]
        }
        return ["offers": listed, "missing": awaiting.sorted()]
    }

    // MARK: - Work

    private func run(_ context: HostOperationContext) async throws -> JSONValue {
        guard case .object(var checkpoint) = context.checkpoint else { throw HostOperationFailure(code: "invalid_input", message: "image.copy needs an object checkpoint") }
        let imageID = context.subject
        try await context.report(HostOperationProgress(phase: "waiting_for_peer"), checkpoint: .object(checkpoint))
        let row = try await rendezvous(context.key)
        checkpoint["role"] = .string(row.role); checkpoint["copy_id"] = .string(row.copyID)
        let link = Link(copy: self, key: context.key, copyID: row.copyID)
        if row.role == "sender" {
            // The receiver may have everything already (this side restarted after it finished, or its done never arrived).
            guard row.state != "copied" else { return .object(["role": .string("sender")]) }
            let source: ImageCopySource
            do { source = try store.copySource(imageID) } catch {
                throw HostOperationFailure(code: "image_not_found", message: "image \(imageID) is no longer on this Mac", nextStep: "copy it from another Mac that holds it")
            }
            try await context.report(HostOperationProgress(phase: "sending"), checkpoint: .object(checkpoint))
            let journaled = checkpoint
            do {
                let sent = try await transfer { [self] in try await transport.send(source, key: row.key, rendezvous: link, progress: progress(context, journaled, phase: "sending")) }
                return Self.result(["role": .string("sender")], sent)
            } catch is ReceiverFinished {
                return .object(["role": .string("sender")])
            }
        }
        if let manifest = try? store.manifest(imageID) {
            // Committed before the last run could record it; the checkpoint has what the transfer did.
            return .object(checkpoint.merging(["size_bytes": .number(Double(manifest.sizeBytes))]) { $1 })
        }
        try await context.report(HostOperationProgress(phase: "checking_disk"), checkpoint: .object(checkpoint))
        let needed = (row.sizeBytes ?? 0) + Self.marginBytes
        let free: UInt64
        do { free = try freeBytes() } catch { throw HostOperationFailure(code: "internal", message: "could not read this Mac's free disk: \(explain(error))") }
        guard free >= needed else {
            throw HostOperationFailure(code: "disk_full", message: "copying image \(imageID) here needs \(gibibytes(needed)) free (the image plus a \(gibibytes(Self.marginBytes)) margin), and \(gibibytes(free)) is free",
                                       nextStep: "free at least \(gibibytes(needed - free)) on this Mac (delete sandboxes or images it no longer needs), then copy again")
        }
        let temp = try store.resumableTemp(imageID, key: context.key)
        do {
            try await context.report(HostOperationProgress(phase: "receiving", completed: 0, total: row.sizeBytes.map(Int.init)), checkpoint: .object(checkpoint))
            let journaled = checkpoint
            let report = try await transfer { [self] in try await transport.receive(into: temp, key: row.key, rendezvous: link, progress: progress(context, journaled, phase: "receiving")) }
            // The copy's duration is what the person waited, from the request on, across any restart of this daemon.
            let received = ImageCopyReport(bytes: report.bytes, durationMs: max(report.durationMs, Int(Date().timeIntervalSince1970 * 1000) - context.startedAt), path: report.path)
            guard case .object(let done) = Self.result(checkpoint, received) else { throw HostOperationFailure(code: "internal", message: "unreachable") }
            checkpoint = done
            try await context.report(HostOperationProgress(phase: "committing"), checkpoint: .object(checkpoint))
            try store.commit(temp, as: imageID)
        } catch is CancellationError {
            // The daemon is exiting: the temporary stays for the resumed transfer.
            throw CancellationError()
        } catch {
            store.discardTemps(of: imageID)
            throw error is HostOperationFailure ? error : HostOperationFailure(code: "internal", message: "could not receive image \(imageID): \(explain(error))", nextStep: "copy it again; if it fails the same way, check this Mac's logs")
        }
        return .object(checkpoint.merging(["size_bytes": .number(Double(try store.manifest(imageID).sizeBytes))]) { $1 })
    }

    /// A transport's failure in the operation's vocabulary: no path is `copy_unreachable` with every path tried.
    private func transfer(_ body: @Sendable () async throws -> ImageCopyReport) async throws -> ImageCopyReport {
        do { return try await body() }
        catch let unreachable as ImageCopyUnreachable {
            let tried = unreachable.tried.isEmpty ? "no path to try" : "tried \(unreachable.tried.map(\.text).joined(separator: ", "))"
            throw HostOperationFailure(code: "copy_unreachable", message: "no direct path between the two Macs; \(tried)", nextStep: Self.unreachableNextStep)
        }
    }

    private static func result(_ base: [String: JSONValue], _ report: ImageCopyReport) -> JSONValue {
        .object(base.merging(["bytes": .number(Double(report.bytes)), "duration_ms": .number(Double(report.durationMs)), "path": .string(report.path.rawValue)]) { $1 })
    }

    /// Journals byte progress at most every `progressIntervalMs`; throws once the store stopped, ending the transfer.
    private nonisolated func progress(_ context: HostOperationContext, _ checkpoint: [String: JSONValue], phase: String) -> ImageCopyProgress {
        { [self] done, total in
            guard await self.due(context.key) else { return }
            try await context.report(HostOperationProgress(phase: phase, completed: Int(done), total: Int(total)), checkpoint: .object(checkpoint))
        }
    }

    private func due(_ key: String) -> Bool {
        let now = Date()
        if let last = lastProgress[key], now.timeIntervalSince(last) * 1000 < Double(Self.progressIntervalMs) { return false }
        lastProgress[key] = now
        return true
    }

    // MARK: - Rendezvous

    /// The copy's row, once the connector handed it over; a row that failed elsewhere ends this side with its cause.
    private func rendezvous(_ key: String) async throws -> Rendezvous {
        let deadline = Date().addingTimeInterval(Double(peerWaitMs) / 1000)
        while rows[key] == nil {
            awaiting.insert(key); wakeOutboxAll()
            guard try await changed(key, until: deadline) else {
                awaiting.remove(key)
                throw HostOperationFailure(code: "copy_unreachable", message: "this Mac never got the copy's details from the account within \(peerWaitMs / 1000) s (is its connector running?)", nextStep: "start this Mac's connector, then copy again")
            }
        }
        let row = rows[key]!
        if row.state == "failed" { throw peerFailure(row) }
        return row
    }

    fileprivate func publish(_ copyID: String, _ candidates: [ImageCopyCandidate]) {
        generation += 1
        offers[copyID] = (candidates, generation)
        wakeOutboxAll()
    }

    /// The first wait (no `previous`) gives up after `peerWaitMs`; a wait for the peer's next set has no deadline, since
    /// the transfer it watches bounds itself.
    fileprivate func peerCandidates(_ key: String, after previous: [ImageCopyCandidate]?) async throws -> [ImageCopyCandidate] {
        let deadline = previous == nil ? Date().addingTimeInterval(Double(peerWaitMs) / 1000) : .distantFuture
        while true {
            if let row = rows[key] {
                if row.state == "failed" { throw peerFailure(row) }
                if row.state == "copied" { throw ReceiverFinished() }
                if let peer = row.peerCandidates, peer != previous { return peer }
            }
            guard try await changed(key, until: deadline) else {
                throw HostOperationFailure(code: "copy_unreachable", message: "the other Mac published no address to reach it within \(peerWaitMs / 1000) s", nextStep: Self.unreachableNextStep)
            }
        }
    }

    /// The copy's row says the receiver committed: a sender still waiting on its peer has nothing left to do.
    struct ReceiverFinished: Error {}

    private func peerFailure(_ row: Rendezvous) -> HostOperationFailure {
        HostOperationFailure(code: row.error?.code ?? "internal", message: "the copy failed elsewhere: \(row.error?.message ?? "no reason given")", nextStep: row.error?.nextStep ?? "copy it again")
    }

    /// Waits for the row under `key` to change; false once `deadline` passed. Cancellation (the daemon exiting) throws.
    private func changed(_ key: String, until deadline: Date) async throws -> Bool {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { return false }
        let id = UUID()
        // A day at most per wait, so a distant deadline never overflows; the caller waits again.
        let timer = Task { [weak self] in try? await Task.sleep(nanoseconds: UInt64(min(remaining, 86_400) * 1_000_000_000)); await self?.wake(key, id) }
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if Task.isCancelled { continuation.resume() } else { waiters[key, default: [:]][id] = continuation }
            }
        } onCancel: { Task { [weak self] in await self?.wake(key, id) } }
        timer.cancel()
        try Task.checkCancellation()
        return Date() < deadline
    }

    private func wake(_ key: String, _ id: UUID) { waiters[key]?.removeValue(forKey: id)?.resume() }
    private func wakeOutbox(_ id: UUID) { outboxWaiters.removeValue(forKey: id)?.resume() }
    private func wakeOutboxAll() { for continuation in outboxWaiters.values { continuation.resume() }; outboxWaiters = [:] }

    private static func candidate(_ object: [String: Any]) -> ImageCopyCandidate? {
        guard let kind = object["kind"] as? String, let address = object["address"] as? String, let port = (object["port"] as? NSNumber)?.intValue else { return nil }
        return ImageCopyCandidate(kind: kind, address: address, port: port)
    }

    /// One side's view of the rendezvous, handed to the transport.
    struct Link: ImageCopyRendezvous {
        let copy: ImageCopy, key: String, copyID: String
        func publish(_ candidates: [ImageCopyCandidate]) async throws { await copy.publish(copyID, candidates) }
        func peerCandidates(after previous: [ImageCopyCandidate]?) async throws -> [ImageCopyCandidate] { try await copy.peerCandidates(key, after: previous) }
    }
}
