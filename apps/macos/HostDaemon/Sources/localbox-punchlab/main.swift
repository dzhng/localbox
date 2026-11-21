import CryptoKit
import Foundation
import ImageTransfer

/// The manual transfer tool on top of `ImageTransfer`, and probe 20's driver. Two Macs exchange candidates
/// through pasted files, reach each other over UDP (local addresses first, then hole punching) and move a
/// file or directory with per-chunk sha256, a resume bitmap and ChaChaPoly under a one-time key. Every line
/// on stdout is one JSON event.
///
///   punchlab offer --send <file|dir> --offer <offer.json> --answer <answer.json>
///   punchlab answer <offer.json> --receive <dir> --answer <answer.json>
///   punchlab stun
///   punchlab blast-send --rate <datagrams/s> [--flows 2] [--seconds 3]
///   punchlab blast-receive --to <ipv4> --port <p> [--flows 2] [--seconds 4]
///
/// The receiver writes into `<dir>` with its resume bitmap at `<dir>.resume`; a restart with the same `<dir>`
/// resumes. The blast pair moves bare datagrams over the same socket layer with no protocol, AEAD or disk:
/// the ceiling Network.framework itself sets on a path, to compare a transfer against.
///
/// Shared flags: --candidate <ipv4> (repeatable; replaces this Mac's interface list), --no-stun,
/// --datagram <bytes> (default 1400). Offer: --chunk-size <bytes> (default 1 MiB), --max-rate <pps>,
/// --idle <s>, --tamper-datagram <n> (flip a ciphertext byte of the nth data datagram: AEAD must refuse it),
/// --corrupt-chunk <n> (flip a plaintext byte of chunk n of the first file, once: its sha256 must refuse it).
/// Answer: --punch-timeout <s>, --key <base64> (overrides the offer's key; for the wrong-key check),
/// --lanes <n> (flows on a local path, default 2).
let arguments = Array(CommandLine.arguments.dropFirst())

func option(_ name: String) -> String? { arguments.firstIndex(of: name).flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil } }
func options(_ name: String) -> [String] { arguments.indices.filter { arguments[$0] == name && $0 + 1 < arguments.count }.map { arguments[$0 + 1] } }
func flag(_ name: String) -> Bool { arguments.contains(name) }

func emit(_ event: String, _ value: some Encodable) {
    let encoder = JSONEncoder()
    encoder.keyEncodingStrategy = .convertToSnakeCase
    encoder.outputFormatting = [.sortedKeys]
    var object = (try? JSONSerialization.jsonObject(with: encoder.encode(value))) as? [String: Any] ?? [:]
    object["event"] = event
    let line = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    FileHandle.standardOutput.write(line + Data("\n".utf8))
}

struct Message: Encodable { var message: String }

struct UsageError: Error, CustomStringConvertible { let description: String }

/// The pasted file the sending side writes: candidates plus the one-time key. Whoever holds it can read the
/// transfer, so it travels like a password.
struct Offer: Codable {
    var id: String
    var key: String
    var candidates: [Candidate]
    var nat: NATReport?
}

/// The pasted reply. The sending side watches for it and punches toward its candidates; a new `id` (a
/// restarted receiver) makes it punch again.
struct Answer: Codable {
    var id: String
    var offer: String
    var candidates: [Candidate]
    var nat: NATReport?
}

func writeAtomically<T: Encodable>(_ value: T, to path: String) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(value).write(to: URL(fileURLWithPath: path), options: .atomic)
}

func randomID() -> String { (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined() }

func selector() -> PathSelector {
    let lan = LANTransport(addresses: options("--candidate").isEmpty ? nil : options("--candidate"), flows: option("--lanes").flatMap(Int.init) ?? 2)
    return PathSelector(flag("--no-stun") ? [lan] : [lan, PunchedUDPTransport()])
}

/// A file sends as itself; a directory sends every regular file under it.
func manifest(for path: String, chunkSize: UInt32) throws -> (URL, TransferManifest) {
    let url = URL(fileURLWithPath: path).standardizedFileURL
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else { throw UsageError(description: "no such file: \(path)") }
    if isDirectory.boolValue { return (url, try TransferManifest.build(directory: url, chunkSize: chunkSize)) }
    let root = url.deletingLastPathComponent()
    return (root, try TransferManifest.build(root: root, paths: [url.lastPathComponent], chunkSize: chunkSize))
}

/// The probe's integrity checks: damages outgoing data datagrams on their way to the port.
final class TamperingPort: DatagramPort {
    private let inner: any DatagramPort
    private let cipher: PacketCipher
    private let tamperDatagram: Int?
    private let corruptChunk: UInt32?
    private let lock = NSLock()
    private var dataDatagrams = 0
    private var corrupted = false

    init(_ inner: any DatagramPort, cipher: PacketCipher, tamperDatagram: Int?, corruptChunk: UInt32?) {
        self.inner = inner; self.cipher = cipher; self.tamperDatagram = tamperDatagram; self.corruptChunk = corruptChunk
    }

    var delivery: DispatchQueue { inner.delivery }
    var localPort: UInt16 { inner.localPort }
    var open: ((Data) -> (PacketHeader, Data)?)? { get { inner.open } set { inner.open = newValue } }
    var onDatagrams: (([Datagram]) -> Void)? { get { inner.onDatagrams } set { inner.onDatagrams = newValue } }
    func disconnect(_ remote: PeerAddress) { inner.disconnect(remote) }
    func close() { inner.close() }
    func sibling() throws -> any DatagramPort { try inner.sibling() }

    func send(_ datagrams: [Data], to remote: PeerAddress) {
        lock.lock()
        let damaged = datagrams.map { datagram -> Data in
            guard let header = PacketHeader(datagram), header.kind == .data else { return datagram }
            dataDatagrams += 1
            var out = datagram
            if dataDatagrams == tamperDatagram { out[out.startIndex + PacketHeader.size + 3] ^= 0x01 }
            if let corruptChunk, !corrupted, header.stream == 1, header.chunk == corruptChunk, let (_, plaintext) = cipher.open(datagram) {
                var flipped = plaintext
                flipped[flipped.startIndex] ^= 0xff
                out = cipher.seal(header, flipped); corrupted = true
            }
            return out
        }
        lock.unlock()
        inner.send(damaged, to: remote)
    }
}

func runOffer() async throws -> Int32 {
    guard let send = option("--send"), let offerPath = option("--offer"), let answerPath = option("--answer") else {
        throw UsageError(description: "usage: punchlab offer --send <file|dir> --offer <offer.json> --answer <answer.json>")
    }
    let started = Date()
    let (root, manifest) = try manifest(for: send, chunkSize: UInt32(option("--chunk-size") ?? "") ?? TransferManifest.defaultChunkSize)
    struct Built: Encodable { var files: Int; var chunks: Int; var zeroChunks: Int; var dataBytes: UInt64; var seconds: Double }
    emit("manifest", Built(files: manifest.files.count, chunks: manifest.chunkCount, zeroChunks: manifest.zeroChunkCount, dataBytes: manifest.dataBytes, seconds: Date().timeIntervalSince(started)))

    let key = SymmetricKey(size: .bits256)
    let socket = try UDPSocket(delivery: DispatchQueue(label: "punchlab.offer", qos: .userInteractive))
    let tamper = option("--tamper-datagram").flatMap(Int.init), corrupt = option("--corrupt-chunk").flatMap(UInt32.init)
    let port: any DatagramPort = tamper == nil && corrupt == nil ? socket : TamperingPort(socket, cipher: PacketCipher(key: key), tamperDatagram: tamper, corruptChunk: corrupt)
    let endpoint = TransferEndpoint(port: port, selector: selector())
    let offer = Offer(id: randomID(), key: key.withUnsafeBytes { Data($0) }.base64EncodedString(), candidates: endpoint.candidates, nat: endpoint.nat)
    try? FileManager.default.removeItem(atPath: answerPath)
    try writeAtomically(offer, to: offerPath)
    struct Offered: Encodable { var id: String; var candidates: [Candidate]; var nat: NATReport? }
    emit("offer", Offered(id: offer.id, candidates: offer.candidates, nat: offer.nat))

    var senderOptions = Sender.Options()
    senderOptions.datagramSize = Int(option("--datagram") ?? "") ?? 1400
    if let rate = option("--max-rate").flatMap(Double.init) { senderOptions.maxRate = rate }
    if let idle = option("--idle").flatMap(Double.init) { senderOptions.idleTimeout = idle }

    // The answer is a pasted file: poll for it, and punch again whenever a restarted receiver replaces it.
    let answers = AsyncStream<[Candidate]> { continuation in
        Thread {
            var seen: String?
            while true {
                if let data = FileManager.default.contents(atPath: answerPath), let answer = try? JSONDecoder().decode(Answer.self, from: data),
                   answer.offer == offer.id, answer.id != seen {
                    seen = answer.id
                    emit("answer", answer)
                    continuation.yield(answer.candidates)
                }
                Thread.sleep(forTimeInterval: 0.2)
            }
        }.start()
    }
    let report = try await Sender.send(directory: root, manifest: manifest, key: key, over: endpoint, answers: answers, options: senderOptions)
    emit(report.finished ? "done" : "idle", report)
    endpoint.close()
    return report.finished ? 0 : 1
}

/// The receiver's report, flat, as probe 20 reads it.
struct Received: Encodable {
    var bytes: UInt64
    var duration: Double
    var path: String
    var pathKind: String
    var lanes: Int
    var dataBytes: UInt64
    var files: Int
    var chunks: Int
    var zeroChunks: Int
    var resumedChunks: Int
    var resumedBytes: UInt64
    var resumeRejectedChunks: Int
    var receivedBytes: UInt64
    var dataSeconds: Double
    var throughputGbps: Double
    var rejectedDatagrams: Int
    var rejectedChunks: Int
    var lostFragments: UInt64
    var duplicateFragments: Int

    init(_ report: TransferReport) {
        let stats = report.stats
        bytes = report.bytes; duration = report.duration
        path = report.path.candidate.label; pathKind = report.path.kind.rawValue; lanes = report.path.flows
        dataBytes = report.bytes; files = stats.files; chunks = stats.chunks; zeroChunks = stats.zeroChunks
        resumedChunks = stats.resumedChunks; resumedBytes = stats.resumedBytes; resumeRejectedChunks = stats.resumeRejectedChunks
        receivedBytes = stats.receivedBytes; dataSeconds = stats.dataSeconds; throughputGbps = stats.throughputGbps
        rejectedDatagrams = stats.rejectedDatagrams; rejectedChunks = stats.rejectedChunks
        lostFragments = stats.lostFragments; duplicateFragments = stats.duplicateFragments
    }
}

func runAnswer() async throws -> Int32 {
    guard arguments.count > 1, let destination = option("--receive"), let answerPath = option("--answer") else {
        throw UsageError(description: "usage: punchlab answer <offer.json> --receive <dir> --answer <answer.json>")
    }
    let offer = try JSONDecoder().decode(Offer.self, from: Data(contentsOf: URL(fileURLWithPath: arguments[1])))
    guard let keyData = Data(base64Encoded: option("--key") ?? offer.key), keyData.count == 32 else { throw UsageError(description: "the offer's key is not 32 bytes of base64") }

    let endpoint = TransferEndpoint(port: try UDPSocket(delivery: DispatchQueue(label: "punchlab.answer", qos: .userInteractive)), selector: selector())
    let answer = Answer(id: randomID(), offer: offer.id, candidates: endpoint.candidates, nat: endpoint.nat)
    try writeAtomically(answer, to: answerPath)
    emit("answer", answer)

    var receiverOptions = Receiver.Options()
    receiverOptions.datagramSize = Int(option("--datagram") ?? "") ?? 1400
    if let timeout = option("--punch-timeout").flatMap(Double.init) { receiverOptions.punchTimeout = timeout }
    receiverOptions.progress = { emit("progress", $0) }
    let report = try await Receiver.receive(into: URL(fileURLWithPath: destination), key: SymmetricKey(data: keyData), offer: offer.candidates, over: endpoint, options: receiverOptions)
    emit("done", Received(report))
    endpoint.close()
    return 0
}

func runStun() throws -> Int32 {
    let socket = try UDPSocket(delivery: DispatchQueue(label: "punchlab.stun"))
    let report = PunchedUDPTransport().stun(socket)
    emit("stun", report)
    socket.close()
    return report.reflexive == nil ? 1 : 0
}

/// Waits for the receiver's hello on each of its flows, then sends bare datagrams back to every flow that
/// said hello, paced like the sender (a 250 µs timer sending whatever is due), so the data arrives on the
/// receiver's own outgoing flows exactly as a transfer's does.
func runBlastSend() throws -> Int32 {
    guard let rate = option("--rate").flatMap(Double.init) else { throw UsageError(description: "usage: punchlab blast-send --rate <datagrams/s> [--flows 2] [--seconds 3]") }
    let queue = DispatchQueue(label: "punchlab.blast", qos: .userInteractive)
    let socket = try UDPSocket(delivery: queue)
    let flows = Int(option("--flows") ?? "") ?? 2
    var targets: [PeerAddress] = []
    let ready = DispatchSemaphore(value: 0)
    socket.onDatagrams = { batch in
        for datagram in batch where !targets.contains(datagram.from) {
            targets.append(datagram.from)
            if targets.count == flows { ready.signal() }
        }
    }
    struct Listening: Encodable { var port: UInt16 }
    emit("listening", Listening(port: socket.localPort))
    guard ready.wait(timeout: .now() + 10) == .success else { throw UsageError(description: "no hello from \(flows) flows within 10 s") }
    let datagram = Data(count: (Int(option("--datagram") ?? "") ?? 1400) - PacketHeader.size - PacketHeader.tagSize)
    let total = Int(rate * (Double(option("--seconds") ?? "") ?? 3))
    var sent = 0, next = 0
    let start = DispatchTime.now(), finished = DispatchSemaphore(value: 0)
    let timer = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
    timer.schedule(deadline: .now(), repeating: .microseconds(250), leeway: .microseconds(50))
    timer.setEventHandler {
        let due = min(total, Int(Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9 * rate)) - sent
        guard due > 0 else { return }
        var perTarget = [[Data]](repeating: [], count: targets.count)
        for _ in 0..<due { perTarget[next % targets.count].append(datagram); next += 1 }
        for (target, datagrams) in zip(targets, perTarget) where !datagrams.isEmpty { socket.send(datagrams, to: target) }
        sent += due
        if sent >= total { timer.cancel(); finished.signal() }
    }
    timer.resume()
    finished.wait()
    socket.close()
    return 0
}

/// Opens `--flows` local ports, says hello to the blast sender from each, and counts what comes back.
func runBlastReceive() throws -> Int32 {
    guard let host = option("--to"), let port = option("--port").flatMap(UInt16.init) else { throw UsageError(description: "usage: punchlab blast-receive --to <ipv4> --port <p>") }
    let queue = DispatchQueue(label: "punchlab.blast", qos: .userInteractive)
    let sockets = try (0..<(Int(option("--flows") ?? "") ?? 2)).map { _ in try UDPSocket(delivery: queue) }
    var count = 0, bytes = 0, first: Date?, last = Date()
    for socket in sockets {
        socket.onDatagrams = { batch in
            if first == nil { first = Date() }
            count += batch.count; bytes += batch.reduce(0) { $0 + $1.data.count }; last = Date()
        }
        socket.send([Data("hello".utf8)], to: PeerAddress(host, port))
    }
    Thread.sleep(forTimeInterval: Double(option("--seconds") ?? "") ?? 4)
    struct Blast: Encodable { var datagrams: Int; var pps: Double; var gbps: Double }
    let result = queue.sync { () -> Blast in
        let seconds = max(last.timeIntervalSince(first ?? last), 0.001)
        return Blast(datagrams: count, pps: Double(count) / seconds, gbps: Double(bytes) * 8 / seconds / 1e9)
    }
    emit("blast", result)
    sockets.forEach { $0.close() }
    return 0
}

do {
    switch arguments.first {
    case "offer": exit(try await runOffer())
    case "answer": exit(try await runAnswer())
    case "stun": exit(try runStun())
    case "blast-receive": exit(try runBlastReceive())
    case "blast-send": exit(try runBlastSend())
    default: throw UsageError(description: "usage: punchlab offer|answer|stun|blast-receive|blast-send (see the header of main.swift)")
    }
} catch {
    emit("error", Message(message: "\(error)"))
    exit(1)
}
