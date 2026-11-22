import Foundation

/// Host operation kind `sandbox.create_after_copy` (`sandbox create --image X` on a Mac without X): chained to this
/// Mac's receiving side of the image's copy (`image.copy`, journaled under the copy's mutation id), it follows the copy,
/// showing the copy's progress as its own, and once the copy commits creates the sandbox with `SandboxHost.create`,
/// exactly as a plain `sandbox.create` does. A copy that fails fails it with the copy's reason. Keyed by the create's
/// mutation id; its subject is the image, so `image.wait` on this Mac follows it to the end: the image here and the
/// sandbox made from it.
///
/// Checkpoint: `{ sandbox_id, copy_key, create }`, where `create` is the create's own request (name, image, size, idle
/// policy). A resume follows the copy again (the copy resumes from its own checkpoint) and creates; a create the last
/// run already finished finds the sandbox and only boots it.
public actor SandboxCreateAfterCopy: HostOperationKind {
    public static let kind = "sandbox.create_after_copy"
    /// How often the copy's progress is looked at and, when it moved, journaled here: as often as the copy journals it.
    static let followIntervalMs = ImageCopy.progressIntervalMs

    struct Checkpoint: Codable {
        let sandboxID: String
        let copyKey: String
        let create: SandboxCreation
        enum CodingKeys: String, CodingKey { case sandboxID = "sandbox_id", copyKey = "copy_key", create }
    }

    private let operations: HostOperationStore
    private let sandboxes: SandboxHost

    public init(operations: HostOperationStore, sandboxes: SandboxHost) { self.operations = operations; self.sandboxes = sandboxes }

    /// Starts creating sandbox `sandboxID` once copy `copyKey` lands, under `key` (the create's mutation id), or returns
    /// the operation already under that key. A copy this Mac isn't receiving the image under is refused before anything
    /// is journaled. `SandboxHost` begins it through the store, which runs this kind's registered work.
    static func begin(on operations: HostOperationStore, key: String, sandboxID: String, copyKey: String, create: SandboxCreation) async throws -> HostOperationRecord {
        if let existing = await operations.state(key) { return existing }
        guard let copy = await operations.state(copyKey), copy.kind == ImageCopy.kind, copy.subject == create.image else {
            throw HostOperationFailure(code: "invalid_input", message: "this Mac has no copy \(copyKey) of image \(create.image) to wait for")
        }
        let checkpoint = try JSONValue(encoding: Checkpoint(sandboxID: sandboxID, copyKey: copyKey, create: create))
        return try await operations.begin(kind: kind, key: key, subject: create.image, checkpoint: checkpoint)
    }

    /// Stops the create waiting to make sandbox `sandboxID`, whose sandbox was deleted while it waited, and returns the
    /// sandbox's name once it has stopped; nil when none waits. A create that finished first keeps its sandbox, which
    /// the delete then removes as any other.
    static func cancel(on operations: HostOperationStore, sandboxID: String) async -> String? {
        for record in await operations.running(kind: kind) {
            guard let checkpoint = try? record.checkpoint.decoded(as: Checkpoint.self), checkpoint.sandboxID == sandboxID else { continue }
            _ = await operations.cancel(record.key, because: HostOperationFailure(code: "operation_cancelled", message: "\(checkpoint.create.name) was deleted while it waited for image \(record.subject)"))
            return checkpoint.create.name
        }
        return nil
    }

    func run(_ context: HostOperationContext) async throws -> JSONValue {
        let checkpoint: Checkpoint
        do { checkpoint = try context.checkpoint.decoded(as: Checkpoint.self) } catch {
            throw HostOperationFailure(code: "invalid_input", message: "\(Self.kind) needs a checkpoint { sandbox_id, copy_key, create }")
        }
        let image = context.subject, name = checkpoint.create.name, copyKey = checkpoint.copyKey
        let again = "delete it with localbox sandbox delete \(name) --confirm \(name), then create it again"
        // 1. Follow the copy, its progress shown as this operation's.
        var shown = context.progress
        var copied: JSONValue?
        while true {
            try Task.checkCancellation()
            // The copy as it stands first, so its progress shows from the start; then until it moves on or the interval ends.
            guard let copy = await operations.state(copyKey) else {
                throw HostOperationFailure(code: "internal", message: "the copy \(copyKey) that \(name) waits for is gone from this Mac", nextStep: again)
            }
            if copy.state == .failed {
                let cause = copy.error ?? HostOperationFailure(code: "internal", message: "no reason given")
                throw HostOperationFailure(code: cause.code, message: "image \(image) did not arrive, so \(name) was not created: \(cause.message)", nextStep: [cause.nextStep, again].compactMap { $0 }.joined(separator: "; then "))
            }
            if copy.state == .succeeded { copied = copy.result; break }
            if let progress = copy.progress, progress != shown {
                try await context.report(progress, checkpoint: context.checkpoint)
                shown = progress
            }
            _ = await operations.wait(copyKey, timeoutMs: Self.followIntervalMs)
        }
        // 2. The image is here: create the sandbox as a plain create does.
        try await context.report(HostOperationProgress(phase: "creating"), checkpoint: context.checkpoint)
        let report: CreateReport
        do { report = try await sandboxes.create(checkpoint.sandboxID, checkpoint.create) }
        catch let failure as HostOperationFailure {
            throw HostOperationFailure(code: failure.code, message: "image \(image) arrived, but \(name) could not be created: \(failure.message)", nextStep: again)
        } catch let refused as AdmissionRefused {
            throw HostOperationFailure(code: "machine_full", message: "image \(image) arrived, but \(name) could not be created: \(refused.message)", nextStep: again)
        }
        var result = report.produced
        result["copy_operation_id"] = copyKey
        // What the copy moved (bytes, duration, path), for the report, whether or not its own outcome has reached the account.
        result["copy"] = copied?.foundation ?? NSNull()
        result["actions"] = report.actions
        return try JSONValue(result)
    }
}
