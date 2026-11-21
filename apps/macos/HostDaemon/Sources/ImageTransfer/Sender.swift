import CryptoKit
import Foundation

/// What the sender saw. `finished` is false when the receiver never reported done (idle timeout or cancel).
public struct SenderReport: Codable, Equatable, Sendable {
    public var dataDatagrams = 0
    public var dataBytes = 0
    public var rejectedDatagrams = 0
    public var finalRate = 0.0
    public var peers: [String] = []
    public var finished = false
}

/// The offering side. It is deliberately simple: it answers HELLO with the manifest info and sends exactly
/// the fragments each REQUEST names, in order, paced at a rate the receiver's loss feedback steers. All
/// retransmission and resume decisions live in the receiver, so a restarted receiver simply asks again.
public final class Sender: @unchecked Sendable {
    public struct Options: Sendable {
        public var datagramSize = 1400
        public var initialRate = 20_000.0  // datagrams per second
        public var maxRate = 1_000_000.0
        /// Gives up when nothing authenticated arrives for this long.
        public var idleTimeout: TimeInterval = 60
        public init() {}
    }

    /// Serves `directory` as `manifest` until the receiver reports done, nothing authenticated arrives for
    /// `idleTimeout`, or the task is cancelled. Each element of `answers` is a (new) receiver's candidate set:
    /// the sender punches toward it so its own NAT opens a mapping for the receiver.
    public static func send(directory: URL, manifest: TransferManifest, key: SymmetricKey, over endpoint: TransferEndpoint,
                            answers: AsyncStream<[Candidate]> = AsyncStream { $0.finish() }, options: Options = Options()) async throws -> SenderReport {
        let sender = try Sender(port: endpoint.port, key: PacketCipher(key: key), root: directory, manifest: manifest, options: options)
        let watcher = Task { for await candidates in answers { sender.punch(toward: candidates) } }
        defer { watcher.cancel() }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in sender.port.delivery.async { sender.start(continuation) } }
        } onCancel: {
            sender.port.delivery.async { sender.conclude() }
        }
    }

    private let port: any DatagramPort
    private let cipher: PacketCipher
    private let options: Options
    private let session = UInt32.random(in: 0...UInt32.max)
    private let payloadSize: Int
    private let manifestBytes: Data
    private let manifestInfo: ManifestInfo
    private let chunks: [ChunkRef]
    private let firstGlobal: [Int]  // global index of each file's chunk 0
    private let chunkCounts: [Int]
    private let files: [Int32]

    // State below is owned by `port.delivery`.
    private var queue: [(range: FragmentRange, peer: PeerAddress)] = []
    private var queueHead = 0
    private var cursor: UInt16 = 0  // next fragment within queue[queueHead]
    private var rate: Double
    private var tokens = 0.0
    private var lastTick = DispatchTime.now()
    private var rateLimited = false
    private var epoch = (at: Date(), received: UInt64(0), lost: UInt64(0))
    private var lastDecrease = Date.distantPast
    private var peerSession: UInt32?
    private var cache: [Int: Data] = [:]
    private var cacheOrder: [Int] = []
    private var sequence: UInt64 = 0
    private var probeTargets: [PeerAddress] = []
    private var probeUntil = Date.distantPast
    private var lastProbe = Date.distantPast
    private var lastHeard = Date()
    private var report = SenderReport()
    private var timer: DispatchSourceTimer?
    private var continuation: CheckedContinuation<SenderReport, Never>?
    private var concluded = false

    private init(port: any DatagramPort, key: PacketCipher, root: URL, manifest: TransferManifest, options: Options) throws {
        self.port = port; self.cipher = key; self.options = options
        payloadSize = options.datagramSize - PacketHeader.size - PacketHeader.tagSize
        manifestBytes = manifest.encoded()
        manifestInfo = ManifestInfo(length: UInt32(manifestBytes.count), digest: sha256(manifestBytes))
        chunks = manifest.chunks
        var starts: [Int] = []; var total = 0
        for file in manifest.files { starts.append(total); total += file.chunkCount }
        firstGlobal = starts
        chunkCounts = manifest.files.map(\.chunkCount)
        var opened: [Int32] = []
        for file in manifest.files {
            let fd = open(root.appendingPathComponent(file.path).path, O_RDONLY)
            guard fd >= 0 else { opened.forEach { close($0) }; throw TransferError.failed("cannot open \(file.path)") }
            opened.append(fd)
        }
        files = opened
        rate = options.initialRate
    }

    deinit { files.forEach { close($0) } }

    private func start(_ continuation: CheckedContinuation<SenderReport, Never>) {
        guard !concluded else { return continuation.resume(returning: report) }
        self.continuation = continuation
        port.open = cipher.open
        port.onDatagrams = { [weak self] batch in batch.forEach { self?.handle($0) } }
        let timer = DispatchSource.makeTimerSource(flags: .strict, queue: port.delivery)
        timer.schedule(deadline: .now(), repeating: .microseconds(250), leeway: .microseconds(50))
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
        lastHeard = Date()
    }

    /// On `port.delivery`, once: stops serving and hands the report back.
    private func conclude() {
        guard !concluded else { return }
        concluded = true
        timer?.cancel(); timer = nil
        port.onDatagrams = nil
        report.finalRate = rate
        continuation?.resume(returning: report); continuation = nil
    }

    /// A (new) answer arrived: punch toward its candidates for a while so our NAT opens a mapping for it.
    private func punch(toward candidates: [Candidate]) {
        port.delivery.async { [self] in
            probeTargets = candidates.map(\.peer)
            probeUntil = Date().addingTimeInterval(20)
            sendProbes()
        }
    }

    private func handle(_ datagram: Datagram) {
        guard let (header, payload) = datagram.opened else { report.rejectedDatagrams += 1; return }
        let remote = datagram.from
        lastHeard = Date()
        if peerSession != header.session, header.kind == .hello || header.kind == .request {
            // A new receiver process (a restart resuming from its bitmap): drop what the old one queued.
            peerSession = header.session
            queue.removeAll(); queueHead = 0; cursor = 0
            epoch = (Date(), 0, 0)
            rate = max(options.initialRate, rate / 2)
            if !report.peers.contains(remote.description) { report.peers.append(remote.description) }
        }
        switch header.kind {
        case .hello:
            probeUntil = .distantPast
            sendControl(.manifestInfo, manifestInfo.bytes, to: remote)
        case .request:
            guard let request = RequestMessage(payload) else { return }
            adaptRate(received: request.received, lost: request.lost)
            for range in request.ranges where range.count > 0 { queue.append((range, remote)) }
        case .done:
            report.finished = true
            conclude()
        default: break
        }
    }

    /// Loss above 1% in a 20 ms epoch backs the rate off by 15%. An epoch where we held
    /// fragments back grows it by a tenth, but only while the receiver takes at least 1/1.3 of the rate, so
    /// a receiver-bound transfer isn't paced as bursts its socket buffer can't absorb. A quiet epoch never
    /// lowers the rate: feedback arrives in bursts, and chasing 20 ms samples down spirals.
    private func adaptRate(received: UInt64, lost: UInt64) {
        let now = Date()
        if received < epoch.received || lost < epoch.lost { epoch = (now, received, lost); return }
        guard now.timeIntervalSince(epoch.at) >= 0.02 else { return }
        let deltaReceived = Double(received - epoch.received), deltaLost = Double(lost - epoch.lost)
        let delivered = deltaReceived / now.timeIntervalSince(epoch.at)
        if deltaLost > 0.01 * (deltaReceived + deltaLost), now.timeIntervalSince(lastDecrease) > 0.05 {
            rate = max(2_000, rate * 0.85); lastDecrease = now
        } else if rateLimited, delivered * 1.3 >= rate {
            // Until the first loss, grow fast (a quarter per epoch: 20k to 300k in about a quarter second).
            rate = min(options.maxRate, rate * (lastDecrease == .distantPast ? 1.25 : 1.1))
        }
        if debug { FileHandle.standardError.write(Data("tx rate=\(Int(rate)) recv=\(Int(deltaReceived)) lost=\(Int(deltaLost)) queued=\(queue.count - queueHead) limited=\(rateLimited)\n".utf8)) }
        rateLimited = false
        epoch = (now, received, lost)
    }

    private func tick() {
        let now = DispatchTime.now()
        let elapsed = Double(now.uptimeNanoseconds - lastTick.uptimeNanoseconds) / 1e9
        lastTick = now
        // A burst cap of 1 ms of sending keeps a late timer from dumping a socket buffer's worth at once.
        tokens = min(tokens + rate * elapsed, max(16, rate * 0.001))
        // Consecutive fragments almost always go to the same flow, so they are grouped by run, not hashed.
        var due: [(peer: PeerAddress, pieces: [(PacketHeader, Data)])] = []
        while tokens >= 1, let (header, peer) = nextFragment() {
            tokens -= 1
            guard let piece = fragmentPlaintext(header) else { continue }
            if let last = due.indices.last, due[last].peer == peer { due[last].pieces.append((header, piece)) } else { due.append((peer, [(header, piece)])) }
        }
        if queueHead < queue.count { rateLimited = true } else { tokens = min(tokens, 16) }
        for (peer, pieces) in due { port.send(sealFragments(pieces), to: peer) }
        if queueHead > 4096 { queue.removeFirst(queueHead); queueHead = 0 }
        let wall = Date()
        if wall < probeUntil, wall.timeIntervalSince(lastProbe) >= 0.1 { sendProbes() }
        if wall.timeIntervalSince(lastHeard) > options.idleTimeout { conclude() }
    }

    private func nextFragment() -> (PacketHeader, PeerAddress)? {
        guard queueHead < queue.count else { return nil }
        let (range, peer) = queue[queueHead]
        let header = PacketHeader(session: session, kind: .data, stream: range.stream, chunk: range.chunk, fragment: range.first + cursor)
        cursor += 1
        if cursor >= range.count { queueHead += 1; cursor = 0 }
        return (header, peer)
    }

    /// nil for a fragment that does not exist (a malformed or stale request); it is skipped.
    private func fragmentPlaintext(_ header: PacketHeader) -> Data? {
        guard let chunk = plaintext(stream: header.stream, chunk: Int(header.chunk)) else { return nil }
        let start = Int(header.fragment) * payloadSize
        guard start < chunk.count else { return nil }
        return chunk.subdata(in: start..<min(chunk.count, start + payloadSize))
    }

    private func sealFragments(_ pieces: [(PacketHeader, Data)]) -> [Data] {
        let datagrams = cipher.seal(pieces)
        report.dataDatagrams += datagrams.count
        report.dataBytes += pieces.reduce(0) { $0 + $1.1.count }
        return datagrams
    }

    /// Stream 0 is the manifest itself; stream n is file n-1. A few recent chunks stay cached because
    /// requests walk chunks in order and retransmissions revisit recent ones.
    private func plaintext(stream: UInt8, chunk: Int) -> Data? {
        if stream == 0 { return chunk == 0 ? manifestBytes : nil }
        let file = Int(stream) - 1
        guard file < files.count, chunk < chunkCounts[file] else { return nil }
        let global = firstGlobal[file] + chunk
        if let hit = cache[global] { return hit }
        let ref = chunks[global]
        var buffer = Data(count: ref.length)
        guard (try? readExactly(files[file], into: &buffer, length: ref.length, offset: ref.offset)) != nil else { return nil }
        cache[global] = buffer; cacheOrder.append(global)
        if cacheOrder.count > 32 { cache[cacheOrder.removeFirst()] = nil }
        return buffer
    }

    private func sendProbes() {
        lastProbe = Date()
        for target in probeTargets { sendControl(.probe, Data(), to: target) }
    }

    private func sendControl(_ kind: PacketKind, _ payload: Data, to remote: PeerAddress) {
        sequence += 1
        port.send([cipher.seal(PacketHeader(session: session, kind: kind, sequence: sequence), payload)], to: remote)
    }
}
