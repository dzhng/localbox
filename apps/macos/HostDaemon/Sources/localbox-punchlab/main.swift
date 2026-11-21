import CryptoKit
import Foundation
import Network

/// Hole-punch and transfer lab for slice 20. Two Macs exchange candidates through pasted files, punch
/// UDP through their NATs (local addresses first) and move a file or directory with per-chunk sha256,
/// a resume bitmap and ChaChaPoly under a one-time key. Every line on stdout is one JSON event.
///
///   punchlab offer --send <file|dir> --offer <offer.json> --answer <answer.json>
///   punchlab answer <offer.json> --receive <dir> --answer <answer.json>
///   punchlab stun
///   punchlab blast-send --rate <datagrams/s> [--flows 2] [--seconds 3]
///   punchlab blast-receive --to <ipv4> --port <p> [--flows 2] [--seconds 4]
///
/// The blast pair moves bare datagrams over the same socket layer with no protocol, AEAD or disk: the
/// ceiling Network.framework itself sets on a path, to compare a transfer against.
///
/// Shared flags: --candidate <ipv4> (repeatable; replaces this Mac's interface list), --no-stun,
/// --datagram <bytes> (default 1400). Offer: --chunk-size <bytes> (default 1 MiB), --max-rate <pps>,
/// --idle <s>, --tamper-datagram <n>, --corrupt-chunk <n>. Answer: --punch-timeout <s>, --key <base64>
/// (overrides the offer's key; for the wrong-key check), --lanes <n> (flows on a local path, default 2).
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

func writeAtomically<T: Encodable>(_ value: T, to path: String) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(value).write(to: URL(fileURLWithPath: path), options: .atomic)
}

func randomID() -> String { (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined() }

/// The socket, plus the candidates a peer should try for it.
func gather(queue: DispatchQueue) throws -> (UDPSocket, [Candidate], NATReport?) {
    let socket = try UDPSocket(delivery: queue)
    let nat = flag("--no-stun") ? nil : CandidateGatherer.stun(socket)
    let addresses = options("--candidate").isEmpty ? CandidateGatherer.localAddresses() : options("--candidate")
    var candidates = addresses.map { Candidate(kind: .local, address: $0, port: socket.port) }
    if let reflexive = nat?.reflexive, !candidates.contains(reflexive) { candidates.append(reflexive) }
    return (socket, candidates, nat)
}

/// A file sends as itself; a directory sends every regular file under it.
func sendSet(_ path: String) throws -> (URL, [String]) {
    let url = URL(fileURLWithPath: path).standardizedFileURL
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else { throw PunchError("no such file: \(path)") }
    guard isDirectory.boolValue else { return (url.deletingLastPathComponent(), [url.lastPathComponent]) }
    let files = (FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.isRegularFileKey])?.compactMap { $0 as? URL } ?? [])
        .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
        .map { String($0.standardizedFileURL.path.dropFirst(url.path.count + 1)) }
        .sorted()
    return (url, files)
}

func runOffer() throws -> Int32 {
    guard let send = option("--send"), let offerPath = option("--offer"), let answerPath = option("--answer") else {
        throw PunchError("usage: punchlab offer --send <file|dir> --offer <offer.json> --answer <answer.json>")
    }
    let datagramSize = Int(option("--datagram") ?? "") ?? 1400
    let (root, paths) = try sendSet(send)
    let started = Date()
    let manifest = try TransferManifest.build(root: root, paths: paths, chunkSize: UInt32(option("--chunk-size") ?? "") ?? 1 << 20)
    struct Built: Encodable { var files: Int; var chunks: Int; var zeroChunks: Int; var dataBytes: UInt64; var seconds: Double }
    let chunks = manifest.chunks
    emit("manifest", Built(files: paths.count, chunks: chunks.count, zeroChunks: chunks.filter(\.isZero).count, dataBytes: manifest.dataBytes, seconds: Date().timeIntervalSince(started)))

    let queue = DispatchQueue(label: "punchlab.offer", qos: .userInteractive)
    let (socket, candidates, nat) = try gather(queue: queue)
    let key = SymmetricKey(size: .bits256)
    let offer = Offer(id: randomID(), key: key.withUnsafeBytes { Data($0) }.base64EncodedString(), candidates: candidates, nat: nat)
    try? FileManager.default.removeItem(atPath: answerPath)
    try writeAtomically(offer, to: offerPath)
    struct Offered: Encodable { var id: String; var candidates: [Candidate]; var nat: NATReport? }
    emit("offer", Offered(id: offer.id, candidates: candidates, nat: nat))

    var senderOptions = Sender.Options()
    senderOptions.datagramSize = datagramSize
    if let rate = option("--max-rate").flatMap(Double.init) { senderOptions.maxRate = rate }
    if let idle = option("--idle").flatMap(Double.init) { senderOptions.idleTimeout = idle }
    senderOptions.tamperDatagram = option("--tamper-datagram").flatMap(Int.init)
    senderOptions.corruptChunk = option("--corrupt-chunk").flatMap(Int.init)
    let sender = try Sender(socket: socket, key: PacketCipher(key: key), root: root, manifest: manifest, options: senderOptions)

    // The answer is a pasted file: poll for it, and punch again whenever a restarted receiver replaces it.
    let watcher = Thread {
        var seen: String?
        while true {
            if let data = FileManager.default.contents(atPath: answerPath), let answer = try? JSONDecoder().decode(Answer.self, from: data),
               answer.offer == offer.id, answer.id != seen {
                seen = answer.id
                emit("answer", answer)
                sender.punch(toward: answer.candidates)
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
    }
    watcher.start()
    let report = sender.run()
    emit(report.finished ? "done" : "idle", report)
    socket.close()
    return report.finished ? 0 : 1
}

func runAnswer() throws -> Int32 {
    guard arguments.count > 1, let destination = option("--receive"), let answerPath = option("--answer") else {
        throw PunchError("usage: punchlab answer <offer.json> --receive <dir> --answer <answer.json>")
    }
    let offerData = try Data(contentsOf: URL(fileURLWithPath: arguments[1]))
    let offer = try JSONDecoder().decode(Offer.self, from: offerData)
    let keyText = option("--key") ?? offer.key
    guard let keyData = Data(base64Encoded: keyText), keyData.count == 32 else { throw PunchError("the offer's key is not 32 bytes of base64") }

    let queue = DispatchQueue(label: "punchlab.answer", qos: .userInteractive)
    let (socket, candidates, nat) = try gather(queue: queue)
    let answer = Answer(id: randomID(), offer: offer.id, candidates: candidates, nat: nat)
    try writeAtomically(answer, to: answerPath)
    emit("answer", answer)

    var receiverOptions = Receiver.Options()
    receiverOptions.datagramSize = Int(option("--datagram") ?? "") ?? 1400
    if let timeout = option("--punch-timeout").flatMap(Double.init) { receiverOptions.punchTimeout = timeout }
    if let lanes = option("--lanes").flatMap(Int.init) { receiverOptions.localLanes = lanes }
    receiverOptions.progress = { emit("progress", $0) }
    let receiver = Receiver(socket: socket, key: PacketCipher(key: SymmetricKey(data: keyData)), offer: offer.candidates,
                            destination: URL(fileURLWithPath: destination).standardizedFileURL, options: receiverOptions)
    let report = try receiver.run()
    emit("done", report)
    socket.close()
    return 0
}

func runStun() throws -> Int32 {
    let socket = try UDPSocket(delivery: DispatchQueue(label: "punchlab.stun"))
    let report = CandidateGatherer.stun(socket)
    emit("stun", report)
    socket.close()
    return report.reflexive == nil ? 1 : 0
}

/// Waits for the receiver's hello on each of its flows, then sends bare datagrams back to every flow that
/// said hello, paced like the sender (a 250 µs timer sending whatever is due), so the data arrives on the
/// receiver's own outgoing flows exactly as a transfer's does.
func runBlastSend() throws -> Int32 {
    guard let rate = option("--rate").flatMap(Double.init) else { throw PunchError("usage: punchlab blast-send --rate <datagrams/s> [--flows 2] [--seconds 3]") }
    let queue = DispatchQueue(label: "punchlab.blast", qos: .userInteractive)
    let socket = try UDPSocket(delivery: queue)
    let flows = Int(option("--flows") ?? "") ?? 2
    var targets: [NWEndpoint] = []
    let ready = DispatchSemaphore(value: 0)
    socket.onDatagrams = { batch in
        for datagram in batch where !targets.contains(datagram.from) {
            targets.append(datagram.from)
            if targets.count == flows { ready.signal() }
        }
    }
    struct Listening: Encodable { var port: UInt16 }
    emit("listening", Listening(port: socket.port))
    guard ready.wait(timeout: .now() + 10) == .success else { throw PunchError("no hello from \(flows) flows within 10 s") }
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
    guard let host = option("--to"), let port = option("--port").flatMap(UInt16.init) else { throw PunchError("usage: punchlab blast-receive --to <ipv4> --port <p>") }
    let queue = DispatchQueue(label: "punchlab.blast", qos: .userInteractive)
    let sockets = try (0..<(Int(option("--flows") ?? "") ?? 2)).map { _ in try UDPSocket(delivery: queue) }
    var count = 0, bytes = 0, first: Date?, last = Date()
    for socket in sockets {
        socket.onDatagrams = { batch in
            if first == nil { first = Date() }
            count += batch.count; bytes += batch.reduce(0) { $0 + $1.data.count }; last = Date()
        }
        socket.send([Data("hello".utf8)], to: UDPSocket.endpoint(host, port))
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
    case "offer": exit(try runOffer())
    case "answer": exit(try runAnswer())
    case "stun": exit(try runStun())
    case "blast-receive": exit(try runBlastReceive())
    case "blast-send": exit(try runBlastSend())
    default: throw PunchError("usage: punchlab offer|answer|stun|blast-receive|blast-send (see the header of main.swift)")
    }
} catch {
    emit("error", Message(message: "\(error)"))
    exit(1)
}
