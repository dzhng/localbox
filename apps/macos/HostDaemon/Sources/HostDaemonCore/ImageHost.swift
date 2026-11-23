import Foundation

/// The daemon's answers about images: `image.create` (a capture, run by `ImageCapture`, or a macOS base build, run by
/// `MacBaseBuilder`), `image.copy` and its rendezvous (`ImageCopy`), `image.wait` from the host operation journal, the
/// connector's `host.operations` long poll (each finished operation, to report to the account), and the image files
/// themselves through `ImageStore` (`image.mirror`, `image.delete`). `HostDaemon` routes these requests here; nothing
/// else answers them.
public actor ImageHost {
    private let operations: HostOperationStore
    private let store: ImageStore
    private let capture: ImageCapture
    private let copy: ImageCopy
    private let macBuilder: MacBaseBuilder
    /// `host.begin_operation` starts any registered kind directly: a dev tool (`LOCALBOX_DEV=1`) for proofs.
    private let allowsDirectOperations: Bool

    public init(operations: HostOperationStore, store: ImageStore, capture: ImageCapture, copy: ImageCopy, macBuilder: MacBaseBuilder, allowsDirectOperations: Bool = false) {
        self.operations = operations; self.store = store; self.capture = capture; self.copy = copy; self.macBuilder = macBuilder; self.allowsDirectOperations = allowsDirectOperations
    }

    /// The connector's image operations, outside the public catalog.
    static let internalOperations: Set<String> = ["image.mirror", "image.copy_rendezvous", "image.copy_outbox", "host.operations", "host.begin_operation"]

    /// Whether this actor answers `operation`: the catalog's image operations and the connector's internal ones.
    public static func answers(_ operation: String) -> Bool {
        HostOperation(rawValue: operation)?.isImage ?? internalOperations.contains(operation)
    }

    public func request(_ envelope: Data) async -> Data {
        guard let object = try? JSONSerialization.jsonObject(with: envelope) as? [String: Any], let operation = object["operation"] as? String else {
            return Reply.failure([:], code: "invalid_input", message: "the request is not a JSON envelope with an operation")
        }
        let input = object["input"] as? [String: Any] ?? [:]
        switch operation {
        case "image.wait":
            guard let image = input["image"] as? String, !image.isEmpty else { return failure(object, code: "invalid_input", message: "image.wait requires image") }
            guard let latest = await operations.latest(subject: image) else {
                return failure(object, code: "image_not_found", message: "this machine has no operation for image \(store.displayName(image))")
            }
            return success(object, result: view(await settled(latest, object, timeoutMs: (input["timeout_ms"] as? NSNumber)?.intValue)))
        case "image.create":
            if input["macos"] as? Bool == true {
                guard let image = input["image"] as? String, !image.isEmpty, let key = object["mutation_id"] as? String, !key.isEmpty else {
                    return failure(object, code: "invalid_input", message: "image.create { macos } takes image (the reserved image's id) and a mutation id")
                }
                do { return Reply.success(object, view(await settled(try await macBuilder.begin(key: key, imageID: image), object, timeoutMs: nil))) }
                catch let refused as HostOperationFailure { return Reply.failure(object, refused) }
                catch { return Reply.failure(object, code: "invalid_input", message: explain(error)) }
            }
            guard let from = input["from"] as? String, !from.isEmpty, let image = input["image"] as? String, !image.isEmpty, let key = object["mutation_id"] as? String, !key.isEmpty else {
                return failure(object, code: "invalid_input", message: "image.create takes from (the source sandbox's id), image (the reserved image's id) and a mutation id")
            }
            do { return Reply.success(object, view(await settled(try await capture.begin(key: key, imageID: image, sandboxID: from), object, timeoutMs: nil))) }
            catch let refused as HostOperationFailure { return Reply.failure(object, refused) }
            catch { return Reply.failure(object, code: "invalid_input", message: explain(error)) }
        case "image.copy":
            guard let image = input["image"] as? String, !image.isEmpty, let key = object["mutation_id"] as? String, !key.isEmpty else {
                return failure(object, code: "invalid_input", message: "image.copy takes image (the image's id) and a mutation id")
            }
            // Answers at once: a copy takes as long as its bytes, and image.wait follows it.
            do { return success(object, result: view(try await copy.begin(key: key, imageID: image))) }
            catch { return failure(object, code: "invalid_input", message: explain(error)) }
        case "image.copy_rendezvous":
            guard let listed = input["copies"] as? [[String: Any]] else { return failure(object, code: "invalid_input", message: "image.copy_rendezvous takes copies (this machine's copies as the account lists them)") }
            await copy.absorb(listed)
            return success(object, result: ["copies": listed.count])
        case "image.copy_outbox":
            let published = (input["published"] as? [[String: Any]] ?? []).compactMap { entry -> (copyID: String, generation: Int)? in
                guard let copyID = entry["copy_id"] as? String, let generation = (entry["generation"] as? NSNumber)?.intValue else { return nil }
                return (copyID, generation)
            }
            let timeout = (input["timeout_ms"] as? NSNumber)?.intValue ?? 25_000
            return success(object, result: await copy.outbox(published: published, timeoutMs: timeout))
        case "host.operations":
            let reported = input["reported"] as? [String] ?? []
            do { try await operations.markReported(reported) } catch { return failure(object, code: "internal", message: "could not record reported operations: \(explain(error))") }
            let timeout = (input["timeout_ms"] as? NSNumber)?.intValue ?? 25_000
            return success(object, result: ["operations": await operations.unreported(timeoutMs: timeout).map(view)])
        case "host.begin_operation":
            guard allowsDirectOperations else { return failure(object, code: "unsupported", message: "host.begin_operation needs a daemon started with LOCALBOX_DEV=1") }
            guard let kind = input["kind"] as? String, let key = input["key"] as? String, let subject = input["subject"] as? String else {
                return failure(object, code: "invalid_input", message: "host.begin_operation takes kind, key, subject and checkpoint")
            }
            do {
                return success(object, result: view(try await operations.begin(kind: kind, key: key, subject: subject, checkpoint: try JSONValue(input["checkpoint"] ?? NSNull()))))
            } catch { return failure(object, code: "invalid_input", message: explain(error)) }
        case "image.delete":
            guard let image = input["image"] as? String, !image.isEmpty else { return failure(object, code: "invalid_input", message: "image.delete requires image") }
            if await operations.isRunning(subject: image) { return failure(object, code: "conflict", message: "an operation on image \(store.displayName(image)) is still running on this machine") }
            do { return success(object, result: ["image": image, "removed": try store.removeIfPresent(image)]) }
            catch { return failure(object, code: "internal", message: "could not remove image \(store.displayName(image)): \(explain(error))") }
        case "image.mirror":
            let rows = (input["images"] as? [[String: Any]])?.map { (id: $0["image_id"] as? String ?? "", name: $0["name"] as? String) }
            guard let machineID = input["machine_id"] as? String, !machineID.isEmpty, let rows, !rows.contains(where: { $0.id.isEmpty }) else {
                return failure(object, code: "invalid_input", message: "image.mirror takes machine_id (the signed-in connector's machine) and images (each image its catalog lists here, as image_id and name)")
            }
            // The names come first: a rename lists the same images, and changes only what this Mac's image work is called.
            store.setAccountNames(Dictionary(rows.compactMap { row in row.name.map { (row.id, $0) } }, uniquingKeysWith: { _, last in last }))
            do { return success(object, result: try await mirror(machineID: machineID, listed: Set(rows.map(\.id)))) }
            catch { return failure(object, code: "internal", message: "image mirror failed: \(explain(error))") }
        default:
            return failure(object, code: "unsupported", message: "\(operation) is not an image operation")
        }
    }

    /// Follows the account catalog's list of the images this machine holds (the caller has already handed their names to
    /// `ImageStore`). An image it lists is marked listed by that machine. An image it no longer lists that the same machine's catalog listed before (deleted while this Mac was
    /// offline) is removed, unless an operation on it is still running; anything else (never listed, or listed by an
    /// earlier sign-in) stays and is reported `unknown`.
    private func mirror(machineID: String, listed: Set<String>) async throws -> [String: Any] {
        var deleted: [[String: String]] = [], unknown: [String] = [], present: Set<String> = []
        for held in store.held() {
            if listed.contains(held.imageID) {
                present.insert(held.imageID)
                if held.listedBy != machineID { try store.markListed(held.imageID, by: machineID) }
            } else if held.listedBy == machineID, !(await operations.isRunning(subject: held.imageID)) {
                _ = try store.removeIfPresent(held.imageID)
                deleted.append(["image": held.imageID, "detail": "deleted image \(held.imageID): the account catalog no longer lists it here"])
            } else { unknown.append(held.imageID) }
        }
        return ["images": present.count, "missing": listed.subtracting(present).sorted(), "deleted": deleted, "unknown": unknown]
    }

    /// `record` once it finishes, or as it stands when the wait ends. As job.wait: without `timeoutMs`, the wait lasts as
    /// long as the request may run, leaving a second to answer before its deadline. A capture usually finishes inside
    /// that, so `image.create` mostly answers with the saved image rather than a pending one. A macOS build runs for many
    /// minutes, so its waits also end when it moves to its next phase, and `image wait` shows each one.
    private func settled(_ record: HostOperationRecord, _ request: [String: Any], timeoutMs: Int?) async -> HostOperationRecord {
        let deadline = (request["deadline_ms"] as? NSNumber)?.intValue ?? 30_000
        return await operations.wait(record.key, timeoutMs: min(timeoutMs ?? Int.max, max(0, deadline - 1_000)), untilPhaseChanges: record.kind == MacBaseBuilder.kind) ?? record
    }

    /// A record as callers see it: everything but the checkpoint, which is the kind's private resume point.
    private func view(_ record: HostOperationRecord) -> [String: Any] {
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        guard let data = try? encoder.encode(record), var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ["key": record.key] }
        object["checkpoint"] = nil
        return object
    }

    private func success(_ request: [String: Any], result: Any) -> Data { Reply.success(request, result) }
    private func failure(_ request: [String: Any], code: String, message: String) -> Data { Reply.failure(request, code: code, message: message) }
}

extension HostOperation {
    /// The catalog's image operations, which `ImageHost` answers; every other catalog operation is `SandboxHost`'s.
    var isImage: Bool {
        switch self {
        case .imageCreate, .imageCopy, .imageDelete, .imageWait: return true
        case .sandboxCreate, .sandboxList, .sandboxRename, .sandboxDelete, .systemInfo, .sandboxStatus, .sandboxResize, .sandboxStart, .sandboxStop, .sandboxSleep, .sandboxLogs,
             .relayStatus, .skillStatus, .skillInstall, .skillUpdate, .skillUninstall, .cliStatus, .agentsSetupStatus, .agentsSetupSet: return false
        }
    }
}
