import CryptoKit
import Foundation
import Network

/// The answering side, and the brain of the transfer: it picks the path, asks for exactly the fragments it
/// lacks, detects loss, verifies every chunk's sha256, writes it, and persists the resume bitmap.
///
/// Layout on disk while receiving into `<dest>`: files under `<dest>.partial/`, bitmap at
/// `<dest>.partial.resume`. Both are removed once every file is verified, fsynced and moved into `<dest>`.
///
/// The bitmap is saved without an fsync of the data and is only a hint: a resume re-hashes every chunk it
/// claims against the manifest and fetches the ones that don't match. That keeps fsync (which blocks
/// concurrent writes to the file on APFS, stalling the whole window) off the transfer path, and survives a
/// power loss or a torn write, not just a killed process.
final class Receiver: @unchecked Sendable {
    struct Options {
        var datagramSize = 1400
        var punchTimeout: TimeInterval = 15
        /// Local candidates get this head start before reflexive ones are tried, so a LAN wins when both work.
        var localGrace: TimeInterval = 0.3
        var maxActiveChunks = 48
        /// Flows (local ports) on a local path. Network.framework's ceiling is per process pair (~260k
        /// datagrams/s here, whatever the flow count), but splitting it over two flows halves each flow's
        /// burst into its socket buffer, which cut loss in the spike's runs. Punched paths stay on one flow:
        /// each extra port would need its own NAT mapping.
        var localLanes = 2
        var progress: ((Progress) -> Void)?
    }

    struct Progress: Encodable { var doneBytes: UInt64; var dataBytes: UInt64; var fraction: Double }

    struct Report: Encodable {
        var path = ""
        var pathKind = ""
        var lanes = 1
        var files = 0
        var chunks = 0
        var zeroChunks = 0
        var dataBytes: UInt64 = 0
        var resumedChunks = 0
        var resumedBytes: UInt64 = 0
        var resumeRejectedChunks = 0
        var receivedBytes: UInt64 = 0
        var dataSeconds = 0.0
        var throughputGbps = 0.0
        var rejectedDatagrams = 0
        var rejectedChunks = 0
        var lostFragments: UInt64 = 0
        var duplicateFragments = 0
    }

    private struct Task {
        var stream: UInt8
        var chunk: UInt32
        var length: Int
        var hash: Data
        var ref: ChunkRef?  // nil for the manifest blob
    }

    /// One chunk being assembled in memory until every fragment is in.
    private final class Assembly {
        let task: Task
        let buffer: UnsafeMutableRawBufferPointer
        var received: [Bool]
        var receivedCount = 0
        var nextUnrequested = 0
        var verifying = false
        init(task: Task, payloadSize: Int) {
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
        let socket: UDPSocket
        var order: [(sequence: UInt64, key: UInt64, at: TimeInterval)] = []
        var orderHead = 0
        var nextSequence: UInt64 = 0
        init(_ index: Int, _ socket: UDPSocket) { self.index = index; self.socket = socket }
    }

    private let socket: UDPSocket
    private var lanes: [Lane]
    private var nextLane = 0
    private let cipher: PacketCipher
    private let options: Options
    private let destination: URL
    private let tempDirectory: URL
    private let bitmapURL: URL
    private let session = UInt32.random(in: 0...UInt32.max)
    private let payloadSize: Int
    private let io = DispatchQueue(label: "punchlab.receiver.io", qos: .userInitiated)
    private let persist = DispatchQueue(label: "punchlab.receiver.persist", qos: .utility)
    private var persisting = false

    // Path selection.
    private var offered: [Candidate]
    private var learned: [Candidate] = []
    private var peer: NWEndpoint?
    private var punchStarted = Date()
    private var lastHello = Date.distantPast

    // Transfer state, owned by `socket.delivery`.
    private var tasks: [Task] = []
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
    private var dataStarted: Date?
    private var lastProgress = Date.distantPast
    private var report = Report()
    private var failure: PunchError?
    private var timer: DispatchSourceTimer?
    private let finished = DispatchSemaphore(value: 0)

    /// Fragments arrive in request order on a LAN; one this far behind the newest arrival is lost.
    private let reorderThreshold: UInt64 = 256

    init(socket: UDPSocket, key: PacketCipher, offer candidates: [Candidate], destination: URL, options: Options) {
        self.socket = socket; self.lanes = [Lane(0, socket)]; self.cipher = key; self.options = options; self.offered = candidates
        self.destination = destination
        tempDirectory = URL(fileURLWithPath: destination.path + ".partial", isDirectory: true)
        bitmapURL = URL(fileURLWithPath: destination.path + ".partial.resume")
        payloadSize = options.datagramSize - PacketHeader.size - PacketHeader.tagSize
    }

    deinit { openFiles.forEach { close($0) } }

    func run() throws -> Report {
        socket.delivery.sync {
            punchStarted = Date()
            socket.open = cipher.open
            socket.onDatagrams = { [weak self] batch in self?.handle(batch) }
            let timer = DispatchSource.makeTimerSource(flags: .strict, queue: socket.delivery)
            timer.schedule(deadline: .now(), repeating: .milliseconds(2), leeway: .microseconds(500))
            timer.setEventHandler { [weak self] in self?.tick() }
            timer.resume()
            self.timer = timer
        }
        finished.wait()
        return try socket.delivery.sync {
            timer?.cancel(); socket.onDatagrams = nil
            lanes.dropFirst().forEach { $0.socket.close() }
            if let failure { throw failure }
            return report
        }
    }

    // MARK: - Packets

    private func handle(_ batch: [UDPSocket.Datagram]) {
        for datagram in batch {
            guard let (header, payload) = datagram.opened else { report.rejectedDatagrams += 1; continue }
            handle(header, payload, from: datagram.from)
        }
        if peer != nil, window - inflight.count >= min(128, window / 4) { fill() }
    }

    private func handle(_ header: PacketHeader, _ payload: Data, from remote: NWEndpoint) {
        switch header.kind {
        case .probe where peer == nil:
            // The sender's punch got through first: its source is worth a HELLO even if it wasn't offered.
            if case let .hostPort(.ipv4(address), port) = remote,
               !(offered + learned).contains(where: { $0.endpoint == remote }) {
                learned.append(Candidate(kind: .peerReflexive, address: "\(address)", port: port.rawValue))
            }
            sendControl(.hello, Data(), to: remote)
        case .manifestInfo where peer == nil:
            guard let info = ManifestInfo(payload) else { return }
            choosePath(remote)
            manifestDigest = info.digest
            tasks = [Task(stream: 0, chunk: 0, length: Int(info.length), hash: info.digest, ref: nil)]
            fill(force: true)
        case .data:
            receive(header, payload)
        default: break
        }
    }

    private func choosePath(_ remote: NWEndpoint) {
        peer = remote
        let candidate = (offered + learned).first { $0.endpoint == remote }
        report.path = candidate?.label ?? "\(remote)"
        report.pathKind = candidate?.kind.rawValue ?? Candidate.Kind.peerReflexive.rawValue
        guard candidate?.kind == .local else { return }
        for _ in 1..<max(1, options.localLanes) {
            guard let extra = try? UDPSocket(delivery: socket.delivery) else { break }
            extra.open = cipher.open
            extra.onDatagrams = { [weak self] batch in self?.handle(batch) }
            lanes.append(Lane(lanes.count, extra))
        }
        report.lanes = lanes.count
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
            report.duplicateFragments += 1; return
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
            let message = RequestMessage(received: receivedFragments, lost: report.lostFragments, ranges: slice)
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
        report.lostFragments += 1
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
        let task = assembly.task
        active[Self.chunkKey(task.stream, task.chunk)] = nil
        guard ok else {
            // A chunk whose bytes authenticated but don't hash right was wrong at the source or in our
            // assembly; fetch all of it again.
            report.rejectedChunks += 1
            tasks.insert(task, at: nextTask)
            fill(); return
        }
        if task.ref == nil { startFiles(manifestBytes: assembly.buffer, length: task.length); return }
        doneBytes += UInt64(task.length)
        report.receivedBytes += UInt64(task.length)
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
            openFiles = try manifest.files.map { file in
                let url = tempDirectory.appendingPathComponent(file.path)
                try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                let fd = open(url.path, O_RDWR | O_CREAT, 0o644)
                guard fd >= 0, ftruncate(fd, off_t(file.size)) == 0 else { throw PunchError("cannot create \(url.path): \(String(cString: strerror(errno)))") }
                return fd
            }
            var bitmap = resumed ?? ResumeBitmap(manifestDigest: manifestDigest, count: chunks.count)
            let claimed = chunks.filter { !$0.isZero && bitmap[$0.global] }
            for (ref, ok) in zip(claimed, Self.verifyClaimed(claimed, files: openFiles)) where !ok {
                bitmap.clear(ref.global); report.resumeRejectedChunks += 1
            }
            io.sync { self.bitmap = bitmap; saveBitmapNow() }
            report.files = manifest.files.count
            report.chunks = chunks.count
            report.zeroChunks = chunks.filter(\.isZero).count
            report.dataBytes = manifest.dataBytes
            tasks = []; nextTask = 0
            for ref in chunks where !ref.isZero {
                if bitmap[ref.global] {
                    report.resumedChunks += 1; report.resumedBytes += UInt64(ref.length); doneBytes += UInt64(ref.length)
                } else {
                    tasks.append(Task(stream: UInt8(ref.file + 1), chunk: UInt32(ref.chunk), length: ref.length, hash: ref.hash, ref: ref))
                }
            }
            dataStarted = Date()
            if tasks.isEmpty { finish() } else { fill(force: true) }
        } catch {
            fail(error as? PunchError ?? PunchError("\(error)"))
        }
    }

    /// Everything verified: flush, move the files into place, drop the temp state, tell the sender.
    private func finish() {
        guard let manifest else { return }
        report.dataSeconds = Date().timeIntervalSince(dataStarted ?? Date())
        report.throughputGbps = report.dataSeconds > 0 ? Double(report.receivedBytes) * 8 / report.dataSeconds / 1e9 : 0
        io.sync { saveBitmapNow() }
        openFiles.forEach { fsync($0); close($0) }; openFiles = []
        do {
            let fm = FileManager.default
            try fm.createDirectory(at: destination, withIntermediateDirectories: true)
            for file in manifest.files {
                let target = destination.appendingPathComponent(file.path)
                try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
                try fm.moveItem(at: tempDirectory.appendingPathComponent(file.path), to: target)
            }
            try? fm.removeItem(at: tempDirectory)
            try? fm.removeItem(at: bitmapURL)
        } catch {
            return fail(PunchError("verified but could not move into \(destination.path): \(error)"))
        }
        if let peer { for _ in 0..<3 { sendControl(.done, Data(), to: peer) } }
        emitProgress(force: true)
        finished.signal()
    }

    private func fail(_ error: PunchError) {
        failure = error
        finished.signal()
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
            if debug { FileHandle.standardError.write(Data("rx rate=\(Int(deliveryRate)) window=\(window) inflight=\(inflight.count) lost=\(report.lostFragments) retry=\(retry.count) dup=\(report.duplicateFragments) active=\(active.count)\n".utf8)) }
        }
        expireTimeouts()
        fill()
        emitProgress(force: false)
    }

    private func punchTick() {
        let elapsed = Date().timeIntervalSince(punchStarted)
        guard elapsed < options.punchTimeout else {
            let tried = (offered + learned).map(\.label).joined(separator: ", ")
            return fail(PunchError("no authenticated reply within \(Int(options.punchTimeout))s (wrong key, or no path); tried: \(tried.isEmpty ? "no candidates" : tried)"))
        }
        // Every 100 ms: local candidates from the start, reflexive ones after the grace period.
        guard Date().timeIntervalSince(lastHello) >= 0.1 else { return }
        lastHello = Date()
        for candidate in offered + learned where candidate.kind != .reflexive || elapsed >= options.localGrace {
            sendControl(.hello, Data(), to: candidate.endpoint)
        }
    }

    private func emitProgress(force: Bool) {
        guard manifest != nil, force || Date().timeIntervalSince(lastProgress) >= 0.2 else { return }
        lastProgress = Date()
        let total = report.dataBytes
        options.progress?(Progress(doneBytes: doneBytes, dataBytes: total, fraction: total == 0 ? 1 : Double(doneBytes) / Double(total)))
    }

    private func sendControl(_ kind: PacketKind, _ payload: Data, to remote: NWEndpoint) {
        controlSequence += 1
        socket.send([cipher.seal(PacketHeader(session: session, kind: kind, sequence: controlSequence), payload)], to: remote)
    }
}
