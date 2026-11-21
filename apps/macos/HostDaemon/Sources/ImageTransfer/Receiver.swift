import CryptoKit
import Foundation

/// A finished transfer. `bytes` is the files' data (zero chunks excluded, resumed chunks included); `duration`
/// is the whole receive, path selection and resume check included.
public struct TransferReport: Codable, Equatable, Sendable {
    public var bytes: UInt64
    public var duration: TimeInterval
    public var path: TransferPath
    public var stats: TransferStats
}

public struct TransferStats: Codable, Equatable, Sendable {
    public var files = 0
    public var chunks = 0
    public var zeroChunks = 0
    public var resumedChunks = 0
    public var resumedBytes: UInt64 = 0
    /// Chunks the bitmap claimed whose bytes on disk didn't hash right; fetched again.
    public var resumeRejectedChunks = 0
    /// Bytes fetched in this run (the rest were resumed).
    public var receivedBytes: UInt64 = 0
    /// From the manifest's arrival to the last chunk written: what `throughputGbps` divides by.
    public var dataSeconds = 0.0
    public var throughputGbps = 0.0
    /// Datagrams that failed AEAD (wrong key, tampered, or not ours).
    public var rejectedDatagrams = 0
    /// Chunks whose bytes authenticated but didn't match the manifest's sha256; fetched again.
    public var rejectedChunks = 0
    public var lostFragments: UInt64 = 0
    public var duplicateFragments = 0
}

public struct TransferProgress: Codable, Equatable, Sendable {
    public var doneBytes: UInt64
    public var dataBytes: UInt64
    public var fraction: Double
}

/// The answering side, and the brain of the transfer: it picks the path, asks for exactly the fragments it
/// lacks, detects loss, verifies every chunk's sha256, writes it, and persists the resume bitmap.
///
/// Files are written in place under the receiver's temp directory; the bitmap lives beside it
/// (`ResumeBitmap.url(beside:)`). Once every chunk is verified the files are fsynced and the bitmap removed; the
/// caller commits the directory. A temp directory with no matching bitmap is emptied and started over.
///
/// The bitmap is saved without an fsync of the data and is only a hint: a resume re-hashes every chunk it
/// claims against the manifest and fetches the ones that don't match. That keeps fsync (which blocks
/// concurrent writes to the file on APFS, stalling the whole window) off the transfer path, and survives a
/// power loss or a torn write, not just a killed process.
public final class Receiver: @unchecked Sendable {
    public struct Options: Sendable {
        public var datagramSize = 1400
        /// Gives up (`TransferError.unreachable`) when no candidate answers with the key within this long.
        public var punchTimeout: TimeInterval = 15
        public var maxActiveChunks = 48
        /// Called on the port's delivery queue at most every 200 ms, and once at the end.
        public var progress: (@Sendable (TransferProgress) -> Void)?
        public init() {}
    }

    /// Receives into `temp`, reaching the sender through `offer` (its candidates) on the schedule `endpoint`'s
    /// selector sets. A killed or cancelled receive leaves `temp` and its bitmap; the next receive into the same
    /// `temp` resumes from them. Throws `TransferError.unreachable` listing every path tried when no candidate
    /// answers with the key, and `CancellationError` when cancelled.
    public static func receive(into temp: URL, key: SymmetricKey, offer: [Candidate], over endpoint: TransferEndpoint, options: Options = Options()) async throws -> TransferReport {
        let receiver = Receiver(endpoint: endpoint, key: PacketCipher(key: key), offer: offer, temp: temp.standardizedFileURL, options: options)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in receiver.socket.delivery.async { receiver.start(continuation) } }
        } onCancel: {
            receiver.socket.delivery.async { receiver.conclude(.failure(CancellationError())) }
        }
    }

    private struct Fetch {
        var stream: UInt8
        var chunk: UInt32
        var length: Int
        var hash: Data
        var ref: ChunkRef?  // nil for the manifest blob
    }

    /// One chunk being assembled in memory until every fragment is in.
    private final class Assembly {
        let task: Fetch
        let buffer: UnsafeMutableRawBufferPointer
        var received: [Bool]
        var receivedCount = 0
        var nextUnrequested = 0
        var verifying = false
        init(task: Fetch, payloadSize: Int) {
            self.task = task
            buffer = .allocate(byteCount: max(task.length, 1), alignment: 16)
            received = [Bool](repeating: false, count: (task.length + payloadSize - 1) / payloadSize)
        }
        deinit { buffer.deallocate() }
    }

    /// One flow: a local port, and the order its requests were sent in. Fragments come back on the flow
    /// that asked for them, in order, so loss is judged per lane; across lanes, arrival order means nothing.
    private final class Lane {
        let index: Int
        let socket: any DatagramPort
        var order: [(sequence: UInt64, key: UInt64, at: TimeInterval)] = []
        var orderHead = 0
        var nextSequence: UInt64 = 0
        init(_ index: Int, _ socket: any DatagramPort) { self.index = index; self.socket = socket }
    }

    private let socket: any DatagramPort
    private let selector: PathSelector
    private let unavailableHere: [PathAttempt]
    private var lanes: [Lane]
    private var nextLane = 0
    private let cipher: PacketCipher
    private let options: Options
    private let tempDirectory: URL
    private let bitmapURL: URL
    private let session = UInt32.random(in: 0...UInt32.max)
    private let payloadSize: Int
    private let io = DispatchQueue(label: "imagetransfer.receiver.io", qos: .userInitiated)
    private let persist = DispatchQueue(label: "imagetransfer.receiver.persist", qos: .utility)
    private var persisting = false

    // Path selection.
    private let started = Date()
    private var offered: [Candidate]
    private var learned: [Candidate] = []
    private var peer: PeerAddress?
    private var path: TransferPath?
    private var lastHello = Date.distantPast

    // Transfer state, owned by `socket.delivery`.
    private var tasks: [Fetch] = []
    private var nextTask = 0
    private var active: [UInt64: Assembly] = [:]
    private var requestOrder: [UInt64] = []
    private var retry: [UInt64] = []  // fragment keys declared lost, re-requested first
    private var inflight: [UInt64: (lane: Int, sequence: UInt64, at: TimeInterval)] = [:]  // fragment key → when and where it was asked for
    /// Smallest request-to-arrival time seen recently: the path's round trip without queueing.
    private var minRTT = 1.0
    private var minRTTCandidate = 1.0
    private var minRTTWindowStart = 0.0
    private var window = 512
    private var receivedFragments: UInt64 = 0
    private var deliveredSinceSample = 0
    private var lastSample = ProcessInfo.processInfo.systemUptime
    private var deliveryRate = 0.0
    private var lastRequest = 0.0
    private var controlSequence: UInt64 = 0
    private var manifest: TransferManifest?
    private var manifestDigest = Data()
    private var openFiles: [Int32] = []
    private var bitmap: ResumeBitmap?
    private var lastPersist = Date()
    private var doneBytes: UInt64 = 0
    private var dataBytes: UInt64 = 0
    private var dataStarted: Date?
    private var lastProgress = Date.distantPast
    private var stats = TransferStats()
    private var timer: DispatchSourceTimer?
    private var continuation: CheckedContinuation<TransferReport, Error>?
    private var concluded = false

    /// Fragments arrive in request order on a LAN; one this far behind the newest arrival is lost.
    private let reorderThreshold: UInt64 = 256

    private init(endpoint: TransferEndpoint, key: PacketCipher, offer candidates: [Candidate], temp: URL, options: Options) {
        socket = endpoint.port; selector = endpoint.selector; unavailableHere = endpoint.unavailable
        lanes = [Lane(0, endpoint.port)]; cipher = key; self.options = options; offered = candidates
        tempDirectory = temp
        bitmapURL = ResumeBitmap.url(beside: temp)
        payloadSize = options.datagramSize - PacketHeader.size - PacketHeader.tagSize
    }

    deinit { openFiles.forEach { close($0) } }

    private func start(_ continuation: CheckedContinuation<TransferReport, Error>) {
        guard !concluded else { return continuation.resume(throwing: CancellationError()) }
        self.continuation = continuation
        socket.open = cipher.open
        socket.onDatagrams = { [weak self] batch in self?.handle(batch) }
        let timer = DispatchSource.makeTimerSource(flags: .strict, queue: socket.delivery)
        timer.schedule(deadline: .now(), repeating: .milliseconds(2), leeway: .microseconds(500))
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
    }

    /// On `socket.delivery`, once. A failure (or cancel) leaves the temp files and bitmap for a resume; chunk
    /// writes already queued are let finish so a resume in this process doesn't race them.
    private func conclude(_ result: Result<TransferReport, Error>) {
        guard !concluded else { return }
        concluded = true
        timer?.cancel(); timer = nil
        socket.onDatagrams = nil
        lanes.dropFirst().forEach { $0.socket.close() }
        if case .failure = result { io.sync {}; persist.sync {} }
        openFiles.forEach { close($0) }; openFiles = []
        continuation?.resume(with: result); continuation = nil
    }

    // MARK: - Packets

    private func handle(_ batch: [Datagram]) {
        guard !concluded else { return }
        for datagram in batch {
            guard let (header, payload) = datagram.opened else { stats.rejectedDatagrams += 1; continue }
            handle(header, payload, from: datagram.from)
        }
        if peer != nil, window - inflight.count >= min(128, window / 4) { fill() }
    }

    private func handle(_ header: PacketHeader, _ payload: Data, from remote: PeerAddress) {
        switch header.kind {
        case .probe where peer == nil:
            // The sender's punch got through first: its source is worth a HELLO even if it wasn't offered.
            if !(offered + learned).contains(where: { $0.peer == remote }) {
                learned.append(Candidate(kind: .peerReflexive, address: remote.host, port: remote.port))
            }
            sendControl(.hello, Data(), to: remote)
        case .manifestInfo where peer == nil:
            guard let info = ManifestInfo(payload) else { return }
            choosePath(remote)
            manifestDigest = info.digest
            tasks = [Fetch(stream: 0, chunk: 0, length: Int(info.length), hash: info.digest, ref: nil)]
            fill(force: true)
        case .data:
            receive(header, payload)
        default: break
        }
    }

    private func choosePath(_ remote: PeerAddress) {
        peer = remote
        let candidate = (offered + learned).first { $0.peer == remote } ?? Candidate(kind: .peerReflexive, address: remote.host, port: remote.port)
        for _ in 1..<max(1, selector.flows(for: candidate.path)) {
            guard let extra = try? socket.sibling() else { break }
            extra.open = cipher.open
            extra.onDatagrams = { [weak self] batch in self?.handle(batch) }
            lanes.append(Lane(lanes.count, extra))
        }
        path = TransferPath(kind: candidate.path, candidate: candidate, flows: lanes.count)
    }

    private func receive(_ header: PacketHeader, _ payload: Data) {
        let chunkKey = Self.chunkKey(header.stream, header.chunk)
        let key = chunkKey << 16 | UInt64(header.fragment)
        if let asked = inflight.removeValue(forKey: key) {
            deliveredSinceSample += 1
            let rtt = ProcessInfo.processInfo.systemUptime - asked.at
            minRTT = min(minRTT, rtt); minRTTCandidate = min(minRTTCandidate, rtt)
            declareLost(on: lanes[asked.lane], before: asked.sequence)
        }
        let fragment = Int(header.fragment)
        guard let assembly = active[chunkKey], !assembly.verifying, fragment < assembly.received.count, !assembly.received[fragment] else {
            stats.duplicateFragments += 1; return
        }
        let start = fragment * payloadSize
        guard payload.count == min(payloadSize, assembly.task.length - start) else { retry.insert(key, at: 0); return }
        payload.withUnsafeBytes { assembly.buffer.baseAddress!.advanced(by: start).copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
        assembly.received[fragment] = true
        assembly.receivedCount += 1
        receivedFragments += 1
        if assembly.receivedCount == assembly.received.count {
            assembly.verifying = true
            io.async { [self] in
                let ok = verifyAndWrite(assembly)
                socket.delivery.async { [self] in complete(assembly, ok: ok) }
            }
        }
    }

    // MARK: - Requests and loss

    private static func chunkKey(_ stream: UInt8, _ chunk: UInt32) -> UInt64 { UInt64(stream) << 32 | UInt64(chunk) }

    /// Asks for fragments until `window` are in flight: lost ones first, then the rest of active chunks,
    /// then new chunks (bounded, since each active chunk holds its buffer in memory).
    private func fill(force: Bool = false) {
        guard let peer else { return }
        var ranges: [FragmentRange] = []
        let now = ProcessInfo.processInfo.systemUptime
        let laneIndex = nextLane % lanes.count, lane = lanes[laneIndex]
        while inflight.count < window, let key = nextFragmentKey() {
            lane.nextSequence += 1
            inflight[key] = (laneIndex, lane.nextSequence, now)
            lane.order.append((lane.nextSequence, key, now))
            let stream = UInt8(truncatingIfNeeded: key >> 48), chunk = UInt32(truncatingIfNeeded: key >> 16), fragment = UInt16(truncatingIfNeeded: key)
            if let last = ranges.last, last.stream == stream, last.chunk == chunk, last.first + last.count == fragment {
                ranges[ranges.count - 1].count += 1
            } else {
                ranges.append(FragmentRange(stream: stream, chunk: chunk, first: fragment, count: 1))
            }
        }
        guard !ranges.isEmpty || force || now - lastRequest > 0.02 else { return }
        lastRequest = now
        nextLane += 1
        let perPacket = RequestMessage.maxRanges(payload: payloadSize)
        var datagrams: [Data] = []
        var start = 0
        repeat {
            let slice = Array(ranges[start..<min(ranges.count, start + perPacket)])
            let message = RequestMessage(received: receivedFragments, lost: stats.lostFragments, ranges: slice)
            controlSequence += 1
            datagrams.append(cipher.seal(PacketHeader(session: session, kind: .request, sequence: controlSequence), message.bytes))
            start += perPacket
        } while start < ranges.count
        lane.socket.send(datagrams, to: peer)
    }

    private func nextFragmentKey() -> UInt64? {
        while let key = retry.popLast() {
            if let assembly = active[key >> 16], !assembly.verifying, !assembly.received[Int(key & 0xffff)] { return key }
        }
        while let chunkKey = requestOrder.first {
            guard let assembly = active[chunkKey], assembly.nextUnrequested < assembly.received.count else { requestOrder.removeFirst(); continue }
            assembly.nextUnrequested += 1
            return chunkKey << 16 | UInt64(assembly.nextUnrequested - 1)
        }
        guard active.count < options.maxActiveChunks, nextTask < tasks.count else { return nil }
        let task = tasks[nextTask]; nextTask += 1
        let chunkKey = Self.chunkKey(task.stream, task.chunk)
        active[chunkKey] = Assembly(task: task, payloadSize: payloadSize)
        requestOrder.append(chunkKey)
        return nextFragmentKey()
    }

    private func declareLost(on lane: Lane, before sequence: UInt64) {
        while lane.orderHead < lane.order.count, lane.order[lane.orderHead].sequence + reorderThreshold < sequence {
            markLostIfInflight(lane.order[lane.orderHead], on: lane); lane.orderHead += 1
        }
        compactOrder(lane)
    }

    /// The timeout covers what reordering can't see: a lost request, or the tail of the transfer.
    private func expireTimeouts() {
        let timeout = 0.25 + Double(window) / max(deliveryRate, 1_000)
        let now = ProcessInfo.processInfo.systemUptime
        for lane in lanes {
            while lane.orderHead < lane.order.count, now - lane.order[lane.orderHead].at > timeout {
                markLostIfInflight(lane.order[lane.orderHead], on: lane); lane.orderHead += 1
            }
            compactOrder(lane)
        }
    }

    private func markLostIfInflight(_ entry: (sequence: UInt64, key: UInt64, at: TimeInterval), on lane: Lane) {
        guard let asked = inflight[entry.key], asked.lane == lane.index, asked.sequence == entry.sequence else { return }
        inflight[entry.key] = nil
        retry.insert(entry.key, at: 0)
        stats.lostFragments += 1
    }

    private func compactOrder(_ lane: Lane) {
        if lane.orderHead > 8192 { lane.order.removeFirst(lane.orderHead); lane.orderHead = 0 }
    }

    // MARK: - Chunks

    /// On `io`: check the sha256, write the chunk, and save the bitmap at most twice a second.
    private func verifyAndWrite(_ assembly: Assembly) -> Bool {
        let task = assembly.task
        let bytes = UnsafeRawBufferPointer(rebasing: assembly.buffer[0..<task.length])
        guard Data(SHA256.hash(data: bytes)) == task.hash else { return false }
        guard let ref = task.ref else { return true }
        var written = 0
        while written < task.length {
            let count = pwrite(openFiles[ref.file], bytes.baseAddress! + written, task.length - written, off_t(ref.offset) + off_t(written))
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { return false }
            written += count
        }
        bitmap?.set(ref.global)
        if !persisting, Date().timeIntervalSince(lastPersist) > 0.5, let snapshot = bitmap {
            persisting = true; lastPersist = Date()
            persist.async { [self] in
                try? snapshot.save(bitmapURL)
                io.async { [self] in persisting = false }
            }
        }
        return true
    }

    /// On `io`, with no chunk writes in flight.
    private func saveBitmapNow() {
        persist.sync {}
        try? bitmap?.save(bitmapURL)
        lastPersist = Date()
    }

    /// The bitmap is a hint: re-hash every chunk it claims, in parallel, and keep only those that match.
    private static func verifyClaimed(_ refs: [ChunkRef], files: [Int32]) -> [Bool] {
        parallelMap(refs) { ref in
            var buffer = Data(count: ref.length)
            guard (try? readExactly(files[ref.file], into: &buffer, length: ref.length, offset: ref.offset)) != nil else { return false }
            return sha256(buffer) == ref.hash
        }
    }

    private func complete(_ assembly: Assembly, ok: Bool) {
        guard !concluded else { return }
        let task = assembly.task
        active[Self.chunkKey(task.stream, task.chunk)] = nil
        guard ok else {
            // A chunk whose bytes authenticated but don't hash right was wrong at the source or in our
            // assembly; fetch all of it again.
            stats.rejectedChunks += 1
            tasks.insert(task, at: nextTask)
            fill(); return
        }
        if task.ref == nil { startFiles(manifestBytes: assembly.buffer, length: task.length); return }
        doneBytes += UInt64(task.length)
        stats.receivedBytes += UInt64(task.length)
        if nextTask == tasks.count, active.isEmpty { finish() } else { fill() }
    }

    /// The manifest arrived and verified: open (or resume) the temp files and queue every chunk that is
    /// neither a zero chunk nor already set in the bitmap.
    private func startFiles(manifestBytes: UnsafeMutableRawBufferPointer, length: Int) {
        do {
            let manifest = try TransferManifest.decode(Data(UnsafeRawBufferPointer(rebasing: manifestBytes[0..<length])))
            self.manifest = manifest
            let chunks = manifest.chunks
            let resumed = ResumeBitmap.load(bitmapURL, manifestDigest: manifestDigest, count: chunks.count)
            let fm = FileManager.default
            if resumed == nil { try? fm.removeItem(at: tempDirectory) }
            try fm.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
            for file in manifest.files {
                let url = tempDirectory.appendingPathComponent(file.path)
                try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                let fd = open(url.path, O_RDWR | O_CREAT, 0o644)
                guard fd >= 0 else { throw TransferError.failed("cannot create \(url.path): \(String(cString: strerror(errno)))") }
                openFiles.append(fd)
                guard ftruncate(fd, off_t(file.size)) == 0 else { throw TransferError.failed("cannot size \(url.path): \(String(cString: strerror(errno)))") }
            }
            var bitmap = resumed ?? ResumeBitmap(manifestDigest: manifestDigest, count: chunks.count)
            let claimed = chunks.filter { !$0.isZero && bitmap[$0.global] }
            for (ref, ok) in zip(claimed, Self.verifyClaimed(claimed, files: openFiles)) where !ok {
                bitmap.clear(ref.global); stats.resumeRejectedChunks += 1
            }
            io.sync { self.bitmap = bitmap; saveBitmapNow() }
            stats.files = manifest.files.count
            stats.chunks = chunks.count
            stats.zeroChunks = chunks.filter(\.isZero).count
            dataBytes = manifest.dataBytes
            tasks = []; nextTask = 0
            for ref in chunks where !ref.isZero {
                if bitmap[ref.global] {
                    stats.resumedChunks += 1; stats.resumedBytes += UInt64(ref.length); doneBytes += UInt64(ref.length)
                } else {
                    tasks.append(Fetch(stream: UInt8(ref.file + 1), chunk: UInt32(ref.chunk), length: ref.length, hash: ref.hash, ref: ref))
                }
            }
            dataStarted = Date()
            if tasks.isEmpty { finish() } else { fill(force: true) }
        } catch {
            conclude(.failure(error))
        }
    }

    /// Everything verified: flush, drop the bitmap, tell the sender.
    private func finish() {
        guard let path else { return }
        stats.dataSeconds = Date().timeIntervalSince(dataStarted ?? Date())
        stats.throughputGbps = stats.dataSeconds > 0 ? Double(stats.receivedBytes) * 8 / stats.dataSeconds / 1e9 : 0
        io.sync { persist.sync {} }
        for fd in openFiles where fsync(fd) != 0 {
            return conclude(.failure(TransferError.failed("verified but could not flush \(tempDirectory.path): \(String(cString: strerror(errno)))")))
        }
        try? FileManager.default.removeItem(at: bitmapURL)
        if let peer { for _ in 0..<3 { sendControl(.done, Data(), to: peer) } }
        emitProgress(force: true)
        conclude(.success(TransferReport(bytes: dataBytes, duration: Date().timeIntervalSince(started), path: path, stats: stats)))
    }

    // MARK: - Timer

    private func tick() {
        guard peer != nil else { return punchTick() }
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastSample >= 0.05 {
            deliveryRate = Double(deliveredSinceSample) / (now - lastSample)
            deliveredSinceSample = 0; lastSample = now
            // Twice the path's bandwidth-delay product (delivery rate x unqueued round trip, at least 2 ms):
            // enough that the sender never runs dry and the rate can still grow, little enough that no deep
            // queue builds in the sender's Network.framework output, where it would overflow into loss.
            // The round-trip floor is re-measured every 2 s so a path that slows down is noticed.
            if now - minRTTWindowStart > 2 { minRTT = minRTTCandidate; minRTTCandidate = 1; minRTTWindowStart = now }
            window = min(16_384, max(512, Int(2 * deliveryRate * max(minRTT, 0.002)) + 512))
            if debug { FileHandle.standardError.write(Data("rx rate=\(Int(deliveryRate)) window=\(window) inflight=\(inflight.count) lost=\(stats.lostFragments) retry=\(retry.count) dup=\(stats.duplicateFragments) active=\(active.count)\n".utf8)) }
        }
        expireTimeouts()
        fill()
        emitProgress(force: false)
    }

    /// Every 100 ms until a path wins: HELLO to every candidate whose transport's head start has passed.
    private func punchTick() {
        let elapsed = Date().timeIntervalSince(started)
        guard elapsed < options.punchTimeout else {
            return conclude(.failure(TransferError.unreachable(timeout: options.punchTimeout,
                attempts: selector.attempts(offered: offered, learned: learned, unavailableHere: unavailableHere, timeout: options.punchTimeout))))
        }
        guard Date().timeIntervalSince(lastHello) >= 0.1 else { return }
        lastHello = Date()
        for candidate in offered + learned {
            guard let delay = selector.delay(for: candidate), elapsed >= delay else { continue }
            sendControl(.hello, Data(), to: candidate.peer)
        }
    }

    private func emitProgress(force: Bool) {
        guard manifest != nil, force || Date().timeIntervalSince(lastProgress) >= 0.2 else { return }
        lastProgress = Date()
        options.progress?(TransferProgress(doneBytes: doneBytes, dataBytes: dataBytes, fraction: dataBytes == 0 ? 1 : Double(doneBytes) / Double(dataBytes)))
    }

    private func sendControl(_ kind: PacketKind, _ payload: Data, to remote: PeerAddress) {
        controlSequence += 1
        socket.send([cipher.seal(PacketHeader(session: session, kind: kind, sequence: controlSequence), payload)], to: remote)
    }
}
