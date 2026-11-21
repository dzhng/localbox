import Foundation

/// Host operation kind `sandbox.create_after_copy` (`sandbox create --image X` on a Mac without X): chained to this
/// Mac's receiving side of the image's copy (`image.copy`, journaled under the copy's mutation id), it follows the copy,
/// showing the copy's progress as its own, and once the copy commits lays the sandbox down and boots it exactly as a
/// plain `sandbox.create` does. A copy that fails fails it with the copy's reason. Keyed by the create's mutation id; its
/// subject is the image, so `image.wait` on this Mac follows it to the end: the image here and the sandbox made from it.
///
/// Checkpoint: `{ sandbox_id, copy_key, input }`, where `input` is the create's own (name, image, size, idle policy). A
/// resume follows the copy again (the copy resumes from its own checkpoint) and creates; a create the last run already
/// finished finds the sandbox and only boots it.
public actor SandboxCreateAfterCopy {
    public static let kind = "sandbox.create_after_copy"
    /// How often the copy's progress is looked at and, when it moved, journaled here: as often as the copy journals it.
    static let followIntervalMs = ImageCopy.progressIntervalMs

    private let operations: HostOperationStore
    private var sandboxes: SandboxHost?

    public init(operations: HostOperationStore) { self.operations = operations }

    /// Registers the kind, creating on `sandboxes`; before the operation store starts.
    public func attach(to sandboxes: SandboxHost) async {
        self.sandboxes = sandboxes
        await operations.register(kind: Self.kind) { [self] context in try await self.run(context) }
    }

    /// Starts creating sandbox `sandboxID` once copy `copyKey` lands, under `key` (the create's mutation id), or returns
    /// the operation already under that key. A copy this Mac isn't receiving `imageID` under is refused before anything
    /// is journaled.
    func begin(key: String, sandboxID: String, copyKey: String, input: [String: Any]) async throws -> HostOperationRecord {
        if let existing = await operations.state(key) { return existing }
        guard let imageID = input["image"] as? String, let copy = await operations.state(copyKey), copy.kind == ImageCopy.kind, copy.subject == imageID else {
            throw HostOperationFailure(code: "invalid_input", message: "this Mac has no copy \(copyKey) of image \(input["image"] as? String ?? "(none)") to wait for")
        }
        var plain = input; plain["after_copy"] = nil
        let checkpoint: JSONValue = .object(["sandbox_id": .string(sandboxID), "copy_key": .string(copyKey), "input": try JSONValue(plain)])
        return try await operations.begin(kind: Self.kind, key: key, subject: imageID, checkpoint: checkpoint)
    }

    private func run(_ context: HostOperationContext) async throws -> JSONValue {
        guard case .object(let checkpoint) = context.checkpoint, case .string(let sandboxID)? = checkpoint["sandbox_id"], case .string(let copyKey)? = checkpoint["copy_key"],
              let input = checkpoint["input"]?.foundation as? [String: Any], let name = input["name"] as? String else {
            throw HostOperationFailure(code: "invalid_input", message: "\(Self.kind) needs a checkpoint { sandbox_id, copy_key, input }")
        }
        let image = context.subject
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
        // 2. The image is here: lay the sandbox down and boot it as a plain create does.
        try await context.report(HostOperationProgress(phase: "creating"), checkpoint: context.checkpoint)
        guard let sandboxes else { throw HostOperationFailure(code: "internal", message: "\(Self.kind) is not attached to this daemon's sandboxes") }
        let answer = await sandboxes.createArrived(sandboxID: sandboxID, input: input)
        guard let envelope = try? JSONSerialization.jsonObject(with: answer) as? [String: Any] else { throw HostOperationFailure(code: "internal", message: "creating \(name) gave no answer") }
        guard envelope["ok"] as? Bool == true, let report = envelope["result"] as? [String: Any] else {
            let error = envelope["error"] as? [String: Any] ?? [:]
            throw HostOperationFailure(code: error["code"] as? String ?? "internal", message: "image \(image) arrived, but \(name) could not be created: \(error["message"] as? String ?? "no reason given")", nextStep: again)
        }
        var result = (report["produced"] as? [String: Any]) ?? [:]
        result["copy_operation_id"] = copyKey
        // What the copy moved (bytes, duration, path), for the report, whether or not its own outcome has reached the account.
        result["copy"] = copied?.foundation ?? NSNull()
        result["actions"] = report["actions"] ?? []
        return try JSONValue(result)
    }
}
