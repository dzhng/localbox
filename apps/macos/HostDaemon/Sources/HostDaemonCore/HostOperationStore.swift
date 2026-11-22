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

extension JSONValue {
    /// A Foundation JSON value (`JSONSerialization`'s), as the journal keeps it.
    init(_ foundation: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: foundation, options: .fragmentsAllowed)
        self = try JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// The value as `JSONSerialization` would read it back.
    var foundation: Any? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)
    }

    /// A kind's own `Codable` checkpoint or result, as the journal keeps it.
    init<Value: Encodable>(encoding value: Value) throws {
        self = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    func decoded<Value: Decodable>(as type: Value.Type) throws -> Value {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
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

/// Why an operation failed, in the envelope's error vocabulary, and what the caller can try next (a kind knows; a
/// failure the store makes itself leaves it to the caller's reader).
public struct HostOperationFailure: Error, Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let nextStep: String?
    public init(code: String, message: String, nextStep: String? = nil) { self.code = code; self.message = message; self.nextStep = nextStep }
    enum CodingKeys: String, CodingKey { case code, message, nextStep = "next_step" }
}

/// One long piece of host work, as `<operations>/<key>.json`. `checkpoint` is the kind's own resume point (a phase, a
/// bitmap of copied chunks): seeded by `begin`, replaced by every `report`, and the only thing a resumer starts from.
/// `subject` is the image the work produces on this Mac. `reportedAt` is set once the connector has told the account
/// how a finished operation ended, so an outcome is reported until it lands, across restarts of either process.
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
    public var reportedAt: Int?
    enum CodingKeys: String, CodingKey {
        case key, kind, subject, state, progress, checkpoint, result, error, startedAt = "started_at", updatedAt = "updated_at", reportedAt = "reported_at"
    }
}

/// What a kind's work sees: where it left off, and how to record a new checkpoint before moving past it.
public struct HostOperationContext: Sendable {
    public let key: String
    public let subject: String
    public let progress: HostOperationProgress?
    public let checkpoint: JSONValue
    /// When the operation began (ms since 1970), kept across resumes.
    public let startedAt: Int
    let store: HostOperationStore

    /// Journals progress and the new resume point; throws once the store has stopped, so a work that outlives its
    /// daemon (a simulated restart) never writes over the record the next store resumes.
    public func report(_ progress: HostOperationProgress, checkpoint: JSONValue) async throws {
        try await store.report(key, progress: progress, checkpoint: checkpoint)
    }
}

/// A kind's work, for a fresh `begin` and for a resume alike: it reads `context.checkpoint` to know where to start.
public typealias HostOperationWork = @Sendable (HostOperationContext) async throws -> JSONValue

/// One kind of long host work: its name in the journal and the work that runs a record of it, fresh or resumed.
protocol HostOperationKind: Sendable {
    static var kind: String { get }
    func run(_ context: HostOperationContext) async throws -> JSONValue
}

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
    /// Why each work `cancel` is stopping will fail, by key.
    private var cancellations: [String: HostOperationFailure] = [:]
    /// Callers of `wait`, by key; `phase` is set (to the phase it started in) when a phase change should wake it.
    private let waiters = WaitList<(key: String, phase: String??)>()
    /// Callers of `unreported`, woken when an operation finishes.
    private let outcomeWaiters = WaitList<Void>()
    private var stopped = false
    /// The last `startedAt` given out: each begin takes a later one, so "the most recent operation" never ties.
    private var lastStartedAt = 0
    /// Told whenever an operation starts running or stops (`onRunningChange`).
    private var runningChanged: (@Sendable () -> Void)?

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
        lastStartedAt = records.values.map(\.startedAt).max() ?? 0
    }

    /// Kinds register before `start()`; `begin` refuses a kind with no resumer, so every record the journal holds can be
    /// continued after a restart.
    public func register(kind: String, resume: @escaping HostOperationWork) {
        resumers[kind] = resume
    }

    /// `handler` hears every operation starting to run or ending; `SandboxHost` keeps the Mac awake while any runs.
    public func onRunningChange(_ handler: @escaping @Sendable () -> Void) { runningChanged = handler }

    func register<Kind: HostOperationKind>(_ kind: Kind) {
        register(kind: Kind.kind) { context in try await kind.run(context) }
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
        if !resumed.isEmpty { runningChanged?() }
        return resumed
    }

    /// Starts `work` under `key`, or returns the record already there (running or finished) without starting anything.
    public func begin(kind: String, key: String, subject: String, checkpoint: JSONValue = .null, work: @escaping HostOperationWork) throws -> HostOperationRecord {
        if let existing = records[key] { return existing }
        guard !stopped else { throw HostDaemonError.invalidState("the operation store has stopped") }
        guard resumers[kind] != nil else { throw HostDaemonError.invalidState("operation kind \(kind) has no resumer registered") }
        guard !key.isEmpty, !key.contains("/"), !key.hasPrefix(".") else { throw HostDaemonError.invalidState("operation key \(key) is not a file name") }
        let now = max(Date().epochMs, lastStartedAt + 1)
        lastStartedAt = now
        let record = HostOperationRecord(key: key, kind: kind, subject: subject, state: .running, checkpoint: checkpoint, startedAt: now, updatedAt: now)
        // Journaled before the work starts: a crash right after this still finds the record and resumes it.
        try save(record)
        records[key] = record
        launch(record, work: work)
        runningChanged?()
        return record
    }

    /// `begin` with the kind's registered resumer as the work, for a kind whose checkpoint carries everything it needs.
    public func begin(kind: String, key: String, subject: String, checkpoint: JSONValue) throws -> HostOperationRecord {
        guard let resume = resumers[kind] else { throw HostDaemonError.invalidState("operation kind \(kind) has no resumer registered") }
        return try begin(kind: kind, key: key, subject: subject, checkpoint: checkpoint, work: resume)
    }

    public func state(_ key: String) -> HostOperationRecord? { records[key] }

    /// The most recently started operation on `subject`: what a wait on an image follows, since a retried copy or
    /// build starts a new record for the same image.
    public func latest(subject: String) -> HostOperationRecord? {
        records.values.filter { $0.subject == subject }.max { $0.startedAt < $1.startedAt }
    }

    /// What is under way or went wrong on this Mac: every running operation, plus each subject's latest operation
    /// when it failed, oldest first.
    public func current() -> [HostOperationRecord] {
        let latest = Dictionary(grouping: records.values, by: \.subject).compactMapValues { $0.max { $0.startedAt < $1.startedAt } }
        return records.values.filter { $0.state == .running || ($0.state == .failed && latest[$0.subject]?.key == $0.key) }.sorted { $0.startedAt < $1.startedAt }
    }

    /// Every running operation of `kind`.
    public func running(kind: String) -> [HostOperationRecord] { records.values.filter { $0.kind == kind && $0.state == .running } }

    /// Whether any operation on `subject` is still running.
    public func isRunning(subject: String) -> Bool { records.values.contains { $0.subject == subject && $0.state == .running } }

    /// The subjects of every running operation: what their resumes may still need on disk.
    public func runningSubjects() -> Set<String> { Set(records.values.filter { $0.state == .running }.map(\.subject)) }

    /// Finished operations whose outcome the connector has not yet reported, oldest first. With none, waits up to
    /// `timeoutMs` (capped at `maxWaitMs`) for one to finish.
    public func unreported(timeoutMs: Int) async -> [HostOperationRecord] {
        if outcomes().isEmpty, !stopped { await outcomeWaiters.wait(for: (), timeout: Self.waitSeconds(timeoutMs)) }
        return outcomes()
    }

    /// Records that the account has these outcomes, so `unreported` stops returning them. Unknown or running keys are
    /// ignored.
    public func markReported(_ keys: [String]) throws {
        for key in keys {
            guard var record = records[key], record.state != .running, record.reportedAt == nil else { continue }
            record.reportedAt = Date().epochMs
            try save(record)
            records[key] = record
        }
    }

    private func outcomes() -> [HostOperationRecord] {
        records.values.filter { $0.state != .running && $0.reportedAt == nil }.sorted { ($0.updatedAt, $0.key) < ($1.updatedAt, $1.key) }
    }

    /// The record once it finishes, or as it stands after `timeoutMs` (capped at `maxWaitMs`); nil for an unknown key.
    /// With `untilPhaseChanges`, it also returns as soon as the work reports a phase other than the one it was in, so a
    /// caller can follow a long build phase by phase.
    public func wait(_ key: String, timeoutMs: Int, untilPhaseChanges: Bool = false) async -> HostOperationRecord? {
        guard let record = records[key] else { return nil }
        guard record.state == .running, !stopped else { return record }
        await waiters.wait(for: (key, untilPhaseChanges ? .some(record.progress?.phase) : nil), timeout: Self.waitSeconds(timeoutMs))
        return records[key]
    }

    /// A caller's timeout, held to `0...maxWaitMs`.
    private static func waitSeconds(_ timeoutMs: Int) -> TimeInterval { TimeInterval(min(max(timeoutMs, 0), maxWaitMs)) / 1000 }

    /// Stops the running work under `key` (what it was for went away) and fails its record with `failure`; returns the
    /// record once the work has ended. Work that succeeded before it noticed keeps its result. Nil for an unknown key.
    public func cancel(_ key: String, because failure: HostOperationFailure) async -> HostOperationRecord? {
        guard records[key]?.state == .running else { return records[key] }
        // A record not yet resumed (before `start()`) has no work to stop.
        guard let task = tasks[key] else { finish(key, .failure(failure)); return records[key] }
        cancellations[key] = failure
        task.cancel()
        await task.value
        return records[key]
    }

    /// Cancels running work without touching its records, as a daemon exit would: they stay `running` for the next
    /// start to resume.
    public func stop() async {
        stopped = true
        waiters.wakeAll(); outcomeWaiters.wakeAll()
        let running = Array(tasks.values)
        for task in running { task.cancel() }
        for task in running { await task.value }
    }

    // MARK: - Work

    private func launch(_ record: HostOperationRecord, work: @escaping HostOperationWork) {
        let context = HostOperationContext(key: record.key, subject: record.subject, progress: record.progress, checkpoint: record.checkpoint, startedAt: record.startedAt, store: self)
        tasks[record.key] = Task.detached { [weak self] in
            let outcome: Result<JSONValue, HostOperationFailure>?
            do { outcome = .success(try await work(context)) }
            catch is CancellationError { outcome = nil }
            catch let failure as HostOperationFailure { outcome = .failure(failure) }
            catch { outcome = .failure(HostOperationFailure(code: "internal", message: explain(error))) }
            await self?.settle(record.key, outcome)
        }
    }

    /// A work the store stopping cancelled leaves its record for the next start; one `cancel` stopped fails with its
    /// reason unless it succeeded first; anything else finishes it.
    private func settle(_ key: String, _ outcome: Result<JSONValue, HostOperationFailure>?) {
        tasks[key] = nil
        var outcome = outcome
        if let cancelled = cancellations.removeValue(forKey: key), (try? outcome?.get()) == nil { outcome = .failure(cancelled) }
        guard let outcome, !stopped else { return }
        finish(key, outcome)
    }

    fileprivate func report(_ key: String, progress: HostOperationProgress, checkpoint: JSONValue) throws {
        guard !stopped, var record = records[key], record.state == .running else { throw CancellationError() }
        record.progress = progress; record.checkpoint = checkpoint; record.updatedAt = Date().epochMs
        try save(record)
        records[key] = record
        waiters.wake { waiting in
            guard waiting.key == key, case .some(let phase) = waiting.phase else { return false }
            return phase != progress.phase
        }
    }

    private func finish(_ key: String, _ outcome: Result<JSONValue, HostOperationFailure>) {
        guard var record = records[key] else { return }
        switch outcome {
        case .success(let result): record.state = .succeeded; record.result = result
        case .failure(let failure): record.state = .failed; record.error = failure
        }
        record.updatedAt = Date().epochMs
        // The in-memory record is the answer either way; a failed write means the next start resumes the work again.
        try? save(record)
        records[key] = record
        waiters.wake { $0.key == key }
        outcomeWaiters.wakeAll()
        runningChanged?()
    }

    private func save(_ record: HostOperationRecord) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(record).write(to: directory.appendingPathComponent("\(record.key).json"), options: .atomic)
    }
}

