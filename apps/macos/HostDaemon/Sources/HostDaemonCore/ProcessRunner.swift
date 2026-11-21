import Foundation

/// How a child process ended: its exit status and output, or that it ran past its timeout and was terminated.
public struct ProcessOutcome: Sendable {
    public let status: Int32
    public let stdout: Data
    public let stderr: String
    public let timedOut: Bool
    public var output: String { String(decoding: stdout, as: UTF8.self) }
}

/// Runs `executable` to completion without holding a thread of the cooperative pool: both pipes are read while it runs
/// (a large reply never blocks it on a full pipe), and the answer comes from its termination handler. Past `timeout` it
/// is terminated and answered `timedOut`, even when a grandchild keeps its pipes open. `stdin` is written and closed;
/// without it the child reads nothing.
public func runProcess(_ executable: URL, _ arguments: [String], environment: [String: String]? = nil, stdin: Data? = nil, timeout: TimeInterval) async -> ProcessOutcome {
    await withCheckedContinuation { continuation in
        let process = Process(), out = Pipe(), err = Pipe(), input = Pipe()
        process.executableURL = executable; process.arguments = arguments
        if let environment { process.environment = environment }
        process.standardOutput = out; process.standardError = err
        process.standardInput = stdin == nil ? FileHandle.nullDevice : input
        let answered = Locked(false), timedOut = Locked(false)
        let finish: @Sendable (ProcessOutcome) -> Void = { outcome in if answered.claim() { continuation.resume(returning: outcome) } }
        let reading = DispatchGroup(), stdout = Locked(Data()), stderr = Locked(Data())
        for (pipe, sink) in [(out, stdout), (err, stderr)] {
            reading.enter()
            DispatchQueue.global().async { sink.value = pipe.fileHandleForReading.readDataToEndOfFile(); reading.leave() }
        }
        process.terminationHandler = { finished in
            reading.notify(queue: .global()) {
                finish(ProcessOutcome(status: finished.terminationStatus, stdout: stdout.value, stderr: String(decoding: stderr.value, as: UTF8.self), timedOut: timedOut.value))
            }
        }
        do { try process.run() } catch {
            try? out.fileHandleForWriting.close(); try? err.fileHandleForWriting.close()
            finish(ProcessOutcome(status: -1, stdout: Data(), stderr: "could not run \(executable.path): \(error)", timedOut: false)); return
        }
        if let stdin {
            DispatchQueue.global().async { try? input.fileHandleForWriting.write(contentsOf: stdin); try? input.fileHandleForWriting.close() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
            guard process.isRunning else { return }
            timedOut.value = true; process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { finish(ProcessOutcome(status: -1, stdout: Data(), stderr: "", timedOut: true)) }
        }
    }
}
