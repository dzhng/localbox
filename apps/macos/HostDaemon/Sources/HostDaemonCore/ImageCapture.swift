import Foundation

/// Host operation kind `image.capture` (`image create --from`): saves a sandbox's disk and boot store as an image on
/// this Mac. A running sandbox is frozen and paused only for the APFS clone, then carries on; a sleeping one wakes
/// through admission first, since what its sleep kept is in memory or its save file, not on disk (P2); a stopped one is
/// cloned as it lies. The image is assembled in an `ImageStore` temporary and committed by one rename.
///
/// Checkpoint: `{ sandbox_id }`, plus what the clone did (`stall_ms`, `disk`, `woke`, `made_room`) once it is taken. A
/// resume finds the image committed (only the result was left to record) or starts over: it removes the half-written
/// temporary, and the sandbox's disk has moved on since, so the clone is retaken.
public actor ImageCapture: HostOperationKind {
    public static let kind = "image.capture"
    /// Free disk a capture leaves beyond the source disk's allocated bytes, which the clone may come to hold in full
    /// as the sandbox writes on.
    public static let marginBytes: UInt64 = 1 << 30

    private let store: ImageStore
    private let operations: HostOperationStore
    private let sandboxes: SandboxHost

    public init(store: ImageStore, operations: HostOperationStore, sandboxes: SandboxHost) {
        self.store = store; self.operations = operations; self.sandboxes = sandboxes
    }

    /// Starts saving sandbox `sandboxID` as image `imageID` under `key` (the create's mutation id), or returns the
    /// operation already under that key. A sandbox this machine doesn't have is refused before anything is journaled.
    public func begin(key: String, imageID: String, sandboxID: String) async throws -> HostOperationRecord {
        if let existing = await operations.state(key) { return existing }
        guard let runtime = await sandboxes.runtime(sandboxID), await runtime.record.inCatalog else {
            throw HostOperationFailure(code: "sandbox_not_found", message: "no sandbox \(sandboxID) on this machine")
        }
        return try await operations.begin(kind: Self.kind, key: key, subject: imageID, checkpoint: .object(["sandbox_id": .string(sandboxID)]))
    }

    func run(_ context: HostOperationContext) async throws -> JSONValue {
        guard case .object(var checkpoint) = context.checkpoint, case .string(let sandboxID)? = checkpoint["sandbox_id"] else {
            throw HostOperationFailure(code: "invalid_input", message: "image.capture needs a checkpoint { sandbox_id }")
        }
        let imageID = context.subject
        if let manifest = try? store.manifest(imageID) { return Self.result(manifest, checkpoint) }
        guard let runtime = await sandboxes.runtime(sandboxID) else {
            throw HostOperationFailure(code: "sandbox_not_found", message: "sandbox \(sandboxID) is no longer on this machine", nextStep: "delete the failed image; there is nothing left to save it from")
        }
        let record = await runtime.record, directory = runtime.directory
        let disk = directory.disk, boot = directory.bootStore(for: record.os)

        // 1. Room for the clone to grow into, before anything is frozen (E3).
        try await context.report(HostOperationProgress(phase: "checking_disk"), checkpoint: .object(checkpoint))
        try store.requireFree(allocatedBytes(disk) + allocatedBytes(boot) + Self.marginBytes, for: "saving \(record.name)",
                              because: "its disk plus a \(gibibytes(Self.marginBytes)) margin", then: "delete the failed image and save it again")

        // 2–4. Clone as it lies when down; otherwise wake it if it sleeps, then freeze around the clone.
        try await context.report(HostOperationProgress(phase: "saving"), checkpoint: .object(checkpoint))
        // A resumed capture starts over: what its last run half-wrote goes first (the start sweep keeps a running
        // operation's temporaries).
        store.discardTemps(of: imageID)
        let temp = try store.reserveTemp(imageID)
        let manifest: ImageManifest
        do {
            let store = store, os = record.os
            let layDown: @Sendable () async throws -> String = { try store.layDown(disk: disk, bootStore: boot, os: os, into: temp) }
            if let cloned = try await runtime.cloneWhileDown(layDown) {
                checkpoint["disk"] = .string(cloned); checkpoint["stall_ms"] = .null
            } else {
                let actions = try await sandboxes.wakeForCapture(runtime)
                if let woke = actions.first(where: { ["woke", "cold_booted"].contains($0["kind"]) }) { checkpoint["woke"] = .string(woke["detail"] ?? "woke \(record.name)") }
                let madeRoom = actions.filter { $0["kind"] == "made_room" }.compactMap { $0["detail"] }
                if !madeRoom.isEmpty { checkpoint["made_room"] = .array(madeRoom.map(JSONValue.string)) }
                let frozen = try await runtime.freezeAndClone(layDown)
                checkpoint["disk"] = .string(frozen.value); checkpoint["stall_ms"] = .number(Double(frozen.stallMs))
            }
            // The image carries the agent its guest last ran; the host's build replaces it on first boot when they differ.
            let parent = try? store.manifest(record.imageID)
            let agent = await runtime.snapshot().agentVersion ?? parent?.agentVersion ?? "unknown"
            manifest = try store.seal(temp, imageID: imageID, os: os, hardwareModel: record.hardwareModel, minMacOS: parent?.minMacOS, agentVersion: agent)

            // 5. Commit: the image exists from here, so a resume only records the result.
            try await context.report(HostOperationProgress(phase: "committing"), checkpoint: .object(checkpoint))
            try store.commit(temp, as: imageID)
        } catch {
            try? FileManager.default.removeItem(at: temp)
            throw Self.failure(error, name: record.name)
        }
        return Self.result(manifest, checkpoint)
    }

    /// What the connector reports (`size_bytes`) and the relay words the result from.
    private static func result(_ manifest: ImageManifest, _ checkpoint: [String: JSONValue]) -> JSONValue {
        var result = checkpoint
        result["size_bytes"] = .number(Double(manifest.sizeBytes)); result["os"] = .string(manifest.os.rawValue)
        result["stall_ms"] = checkpoint["stall_ms"] ?? .null
        return .object(result)
    }

    private static func failure(_ error: Error, name: String) -> Error {
        switch error {
        case let failure as HostOperationFailure: return failure
        case is CancellationError: return error
        case let refused as AdmissionRefused:
            return HostOperationFailure(code: "machine_full", message: "\(name) is asleep and must wake to be saved: \(refused.message)", nextStep: "stop or sleep a sandbox on this Mac, then delete the failed image and save it again")
        case HostDaemonError.unsupported(let message):
            return HostOperationFailure(code: "unsupported", message: message, nextStep: "stop \(name), then delete the failed image and save it again")
        default:
            return HostOperationFailure(code: "internal", message: "could not save \(name): \(explain(error))")
        }
    }
}
