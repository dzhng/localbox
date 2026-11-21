import Foundation

/// Any JSON value: a kind's checkpoint and result are its own shape, kept verbatim in the journal.
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

public enum HostOperationState: String, Codable, Sendable {
    case running, succeeded, failed
}

/// What a caller is shown while the work runs: a named phase and, where the phase is countable, how far it got.
public struct HostOperationProgress: Codable, Equatable, Sendable {
    public var phase: String
    public var completed: Int?
    public var total: Int?
    public init(phase: String, completed: Int? = nil, total: Int? = nil) { self.phase = phase; self.completed = completed; self.total = total }
}

/// Why an operation failed, in the envelope's error vocabulary.
public struct HostOperationFailure: Error, Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
}

/// One long piece of host work, as `<operations>/<key>.json`. `checkpoint` is the kind's own resume point (a phase, a
/// bitmap of copied chunks): seeded by `begin`, replaced by every `report`, and the only thing a resumer starts from.
public struct HostOperationRecord: Codable, Equatable, Sendable {
    public let key: String
    public let kind: String
    public let subject: String
    public var state: HostOperationState
    public var progress: HostOperationProgress?
    public var checkpoint: JSONValue
    public var result: JSONValue?
    public var error: HostOperationFailure?
    /// Milliseconds since 1970, as the relay's `deadline_at`: whole numbers survive the journal exactly, so a record
    /// read back after a restart equals the one a replay got before it.
    public let startedAt: Int
    public var updatedAt: Int
    enum CodingKeys: String, CodingKey {
        case key, kind, subject, state, progress, checkpoint, result, error, startedAt = "started_at", updatedAt = "updated_at"
    }
}

/// What a kind's work sees: where it left off, and how to record a new checkpoint before moving past it.
public struct HostOperationContext: Sendable {
    public let key: String
    public let subject: String
    public let progress: HostOperationProgress?
    public let checkpoint: JSONValue
    let store: HostOperationStore

    /// Journals progress and the new resume point; throws once the store has stopped, so a work that outlives its
    /// daemon (a simulated restart) never writes over the record the next store resumes.
    public func report(_ progress: HostOperationProgress, checkpoint: JSONValue) async throws {
        try await store.report(key, progress: progress, checkpoint: checkpoint)
    }
}

/// A kind's work, for a fresh `begin` and for a resume alike: it reads `context.checkpoint` to know where to start.
public typealias HostOperationWork = @Sendable (HostOperationContext) async throws -> JSONValue

/// The single owner of long host work (image build, copy, capture, create-with-copy). Separate from `SandboxHost` so an
/// hour-long build never queues behind, or holds up, a sandbox request; each work runs detached, off every actor.
/// Keys are mutation ids: a replayed mutation gets the same record and never a second run.
public actor HostOperationStore {
    /// The longest a single `wait` holds a caller, matching the relay's long-poll window.
    public static let maxWaitMs = 120_000

    private let directory: URL
    private var records: [String: HostOperationRecord] = [:]
    private var resumers: [String: HostOperationWork] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]
    private var waiters: [String: [UUID: CheckedContinuation<Void, Never>]] = [:]
    private var stopped = false

    /// Loads every journal under `operationsDirectory`; nothing runs until `start()`.
    public init(operationsDirectory: URL) throws {
        directory = operationsDirectory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let decoder = JSONDecoder()
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) where name.hasSuffix(".json") && !name.hasPrefix(".") {
            // An unreadable journal stays on disk for inspection; it is not an operation anyone can wait on.
            guard let record = try? decoder.decode(HostOperationRecord.self, from: Data(contentsOf: directory.appendingPathComponent(name))) else { continue }
            records[record.key] = record
        }
    }

    /// Kinds register before `start()`, by their owning slice; `begin` refuses a kind with no resumer, so every record
    /// the journal holds can be continued after a restart.
    public func register(kind: String, resume: @escaping HostOperationWork) {
        resumers[kind] = resume
    }

    /// Resumes every record the last run left `running` from its checkpoint; returns their keys. A kind this build no
    /// longer registers fails its record instead, so a waiter learns it will never finish.
    @discardableResult
    public func start() -> [String] {
        var resumed: [String] = []
        for (key, record) in records.sorted(by: { $0.key < $1.key }) where record.state == .running && tasks[key] == nil {
            if let resume = resumers[record.kind] { launch(record, work: resume); resumed.append(key) }
            else { finish(key, .failure(HostOperationFailure(code: "unsupported", message: "no \(record.kind) operations in this daemon"))) }
        }
        return resumed
    }

    /// Starts `work` under `key`, or returns the record already there (running or finished) without starting anything.
    public func begin(kind: String, key: String, subject: String, checkpoint: JSONValue = .null, work: @escaping HostOperationWork) throws -> HostOperationRecord {
        if let existing = records[key] { return existing }
        guard !stopped else { throw HostDaemonError.invalidState("the operation store has stopped") }
        guard resumers[kind] != nil else { throw HostDaemonError.invalidState("operation kind \(kind) has no resumer registered") }
        guard !key.isEmpty, !key.contains("/"), !key.hasPrefix(".") else { throw HostDaemonError.invalidState("operation key \(key) is not a file name") }
        let now = epochMs()
        let record = HostOperationRecord(key: key, kind: kind, subject: subject, state: .running, checkpoint: checkpoint, startedAt: now, updatedAt: now)
        // Journaled before the work starts: a crash right after this still finds the record and resumes it.
        try save(record)
        records[key] = record
        launch(record, work: work)
        return record
    }

    public func state(_ key: String) -> HostOperationRecord? { records[key] }

    /// The record once it finishes, or as it stands after `timeoutMs` (capped at `maxWaitMs`); nil for an unknown key.
    public func wait(_ key: String, timeoutMs: Int) async -> HostOperationRecord? {
        guard let record = records[key] else { return nil }
        guard record.state == .running else { return record }
        let id = UUID()
        let timeout = UInt64(min(max(timeoutMs, 0), Self.maxWaitMs)) * 1_000_000
        let timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: timeout)
            await self?.wake(key, id)
        }
        await withCheckedContinuation { continuation in
            waiters[key, default: [:]][id] = continuation
        }
        timer.cancel()
        return records[key]
    }

    /// Cancels running work without touching its records, as a daemon exit would: they stay `running` for the next
    /// start to resume.
    public func stop() async {
        stopped = true
        let running = Array(tasks.values)
        for task in running { task.cancel() }
        for task in running { await task.value }
    }

    // MARK: - Work

    private func launch(_ record: HostOperationRecord, work: @escaping HostOperationWork) {
        let context = HostOperationContext(key: record.key, subject: record.subject, progress: record.progress, checkpoint: record.checkpoint, store: self)
        tasks[record.key] = Task.detached { [weak self] in
            let outcome: Result<JSONValue, HostOperationFailure>?
            do { outcome = .success(try await work(context)) }
            catch is CancellationError { outcome = nil }
            catch let failure as HostOperationFailure { outcome = .failure(failure) }
            catch { outcome = .failure(HostOperationFailure(code: "internal", message: explain(error))) }
            await self?.settle(record.key, outcome)
        }
    }

    /// A cancelled work (the store stopping) leaves its record for the next start; anything else finishes it.
    private func settle(_ key: String, _ outcome: Result<JSONValue, HostOperationFailure>?) {
        tasks[key] = nil
        guard let outcome, !stopped else { return }
        finish(key, outcome)
    }

    fileprivate func report(_ key: String, progress: HostOperationProgress, checkpoint: JSONValue) throws {
        guard !stopped, var record = records[key], record.state == .running else { throw CancellationError() }
        record.progress = progress; record.checkpoint = checkpoint; record.updatedAt = epochMs()
        try save(record)
        records[key] = record
    }

    private func finish(_ key: String, _ outcome: Result<JSONValue, HostOperationFailure>) {
        guard var record = records[key] else { return }
        switch outcome {
        case .success(let result): record.state = .succeeded; record.result = result
        case .failure(let failure): record.state = .failed; record.error = failure
        }
        record.updatedAt = epochMs()
        // The in-memory record is the answer either way; a failed write means the next start resumes the work again.
        try? save(record)
        records[key] = record
        for continuation in (waiters.removeValue(forKey: key) ?? [:]).values { continuation.resume() }
    }

    private func wake(_ key: String, _ id: UUID) {
        waiters[key]?.removeValue(forKey: id)?.resume()
    }

    private func save(_ record: HostOperationRecord) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(record).write(to: directory.appendingPathComponent("\(record.key).json"), options: .atomic)
    }
}

private func epochMs() -> Int { Int((Date().timeIntervalSince1970 * 1000).rounded()) }
