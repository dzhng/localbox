import Foundation

/// An image with files on this Mac. `listedBy` is the machine whose account catalog last listed it here, so a catalog
/// push deletes only what that same machine's catalog listed before (as `sandbox.mirror` does for sandboxes).
public struct HeldImage: Sendable, Equatable {
    public let imageID: String
    public let listedBy: String?
    public init(imageID: String, listedBy: String?) { self.imageID = imageID; self.listedBy = listedBy }
}

/// The image files on this Mac, as `ImageHost` needs them: what is here, which catalog listed it, and removing one.
/// Slice 24's `ImageStore` owns the files and conforms; nothing else touches them.
public protocol ImageFiles: Sendable {
    /// Every image with files here, except the built-in `linux`.
    func list() async throws -> [HeldImage]
    /// Records that machine `machineID`'s catalog lists `imageID` here.
    func markListed(_ imageID: String, by machineID: String) async throws
    /// Removes every file of `imageID`; false when it had none.
    func remove(_ imageID: String) async throws -> Bool
}

/// The daemon's answers about images: `image.create` (a capture, run by `ImageCapture`), `image.wait` from the host
/// operation journal, the connector's `host.operations` long poll (each finished operation, to report to the account),
/// and the image files themselves (`image.mirror`, `image.delete`). `SandboxHost` routes these requests here and never
/// touches image work itself.
public actor ImageHost {
    private let operations: HostOperationStore
    /// Nil until this daemon has an image store: file operations then answer `unsupported`.
    private let files: (any ImageFiles)?
    /// `host.begin_operation` starts any registered kind directly: a dev tool (`LOCALBOX_DEV=1`) for proofs, since the
    /// catalog operations that begin real kinds belong to later slices.
    private let allowsDirectOperations: Bool

    /// Saves sandboxes as images (`image.create { from }`); nil answers it `unsupported`.
    private let capture: ImageCapture?
    /// Copies images between Macs (`image.copy` and its rendezvous); nil, on a daemon without a transport, answers the
    /// copy `unsupported` and the connector's rendezvous calls with nothing.
    private let copy: ImageCopy?

    public init(operations: HostOperationStore, files: (any ImageFiles)? = nil, capture: ImageCapture? = nil, copy: ImageCopy? = nil, allowsDirectOperations: Bool = false) {
        self.operations = operations; self.files = files; self.capture = capture; self.copy = copy; self.allowsDirectOperations = allowsDirectOperations
    }

    /// Operations answered here: the catalog's image operations a machine runs, and the connector's internal ones
    /// (`image.mirror` among them).
    public static func answers(_ operation: String) -> Bool {
        operation.hasPrefix("image.") || ["host.operations", "host.begin_operation"].contains(operation)
    }

    public func request(_ envelope: Data) async -> Data {
        guard let object = try? JSONSerialization.jsonObject(with: envelope) as? [String: Any], let operation = object["operation"] as? String else {
            return failure([:], code: "invalid_input", message: "the request is not a JSON envelope with an operation")
        }
        let input = object["input"] as? [String: Any] ?? [:]
        switch operation {
        case "image.wait":
            guard let image = input["image"] as? String, !image.isEmpty else { return failure(object, code: "invalid_input", message: "image.wait requires image") }
            guard let latest = await operations.latest(subject: image) else {
                return failure(object, code: "image_not_found", message: "this machine has no operation for image \(image)")
            }
            return success(object, result: view(await settled(latest, object, timeoutMs: (input["timeout_ms"] as? NSNumber)?.intValue)))
        case "image.create":
            if input["macos"] != nil { return failure(object, code: "unsupported", message: "this machine does not build macOS images yet") }
            guard let from = input["from"] as? String, !from.isEmpty, let image = input["image"] as? String, !image.isEmpty, let key = object["mutation_id"] as? String, !key.isEmpty else {
                return failure(object, code: "invalid_input", message: "image.create takes from (the source sandbox's id), image (the reserved image's id) and a mutation id")
            }
            guard let capture else { return failure(object, code: "unsupported", message: "this machine has no image store yet") }
            do { return success(object, result: view(await settled(try await capture.begin(key: key, imageID: image, sandboxID: from), object, timeoutMs: nil))) }
            catch let refused as HostOperationFailure { return failure(object, code: refused.code, message: refused.message) }
            catch { return failure(object, code: "invalid_input", message: explain(error)) }
        case "image.copy":
            guard let image = input["image"] as? String, !image.isEmpty, let key = object["mutation_id"] as? String, !key.isEmpty else {
                return failure(object, code: "invalid_input", message: "image.copy takes image (the image's id) and a mutation id")
            }
            guard let copy else { return failure(object, code: "unsupported", message: "this Mac can't copy images yet: its daemon has no image transfer") }
            // Answers at once: a copy takes as long as its bytes, and image.wait follows it.
            do { return success(object, result: view(try await copy.begin(key: key, imageID: image))) }
            catch { return failure(object, code: "invalid_input", message: explain(error)) }
        case "image.copy_rendezvous":
            guard let listed = input["copies"] as? [[String: Any]] else { return failure(object, code: "invalid_input", message: "image.copy_rendezvous takes copies (this machine's copies as the account lists them)") }
            await copy?.absorb(listed)
            return success(object, result: ["copies": listed.count])
        case "image.copy_outbox":
            let published = (input["published"] as? [[String: Any]] ?? []).compactMap { entry -> (copyID: String, generation: Int)? in
                guard let copyID = entry["copy_id"] as? String, let generation = (entry["generation"] as? NSNumber)?.intValue else { return nil }
                return (copyID, generation)
            }
            let timeout = (input["timeout_ms"] as? NSNumber)?.intValue ?? 25_000
            guard let copy else {
                try? await Task.sleep(nanoseconds: UInt64(min(max(timeout, 0), HostOperationStore.maxWaitMs)) * 1_000_000)
                return success(object, result: ["offers": [Any](), "missing": [String]()])
            }
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
                let checkpoint = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: input["checkpoint"] ?? NSNull(), options: .fragmentsAllowed))
                return success(object, result: view(try await operations.begin(kind: kind, key: key, subject: subject, checkpoint: checkpoint)))
            } catch { return failure(object, code: "invalid_input", message: explain(error)) }
        case "image.delete":
            guard let image = input["image"] as? String, !image.isEmpty else { return failure(object, code: "invalid_input", message: "image.delete requires image") }
            guard let files else { return failure(object, code: "unsupported", message: "this machine has no image store yet") }
            if await operations.isRunning(subject: image) { return failure(object, code: "conflict", message: "an operation on image \(image) is still running on this machine") }
            do { return success(object, result: ["image": image, "removed": try await files.remove(image)]) }
            catch { return failure(object, code: "internal", message: "could not remove image \(image): \(explain(error))") }
        case "image.mirror":
            guard let machineID = input["machine_id"] as? String, !machineID.isEmpty, let listed = input["images"] as? [String] else {
                return failure(object, code: "invalid_input", message: "image.mirror takes machine_id (the signed-in connector's machine) and images (the image ids its catalog lists here)")
            }
            guard let files else { return failure(object, code: "unsupported", message: "this machine has no image store yet") }
            do { return success(object, result: try await mirror(files, machineID: machineID, listed: Set(listed))) }
            catch { return failure(object, code: "internal", message: "image mirror failed: \(explain(error))") }
        default:
            return failure(object, code: "unsupported", message: "this machine does not run \(operation) yet")
        }
    }

    /// Follows the account catalog's list of the images this machine holds. An image it lists is marked listed by that
    /// machine. An image it no longer lists that the same machine's catalog listed before (deleted while this Mac was
    /// offline) is removed, unless an operation on it is still running; anything else (never listed, or listed by an
    /// earlier sign-in) stays and is reported `unknown`.
    private func mirror(_ files: any ImageFiles, machineID: String, listed: Set<String>) async throws -> [String: Any] {
        var deleted: [[String: String]] = [], unknown: [String] = [], present: Set<String> = []
        for held in try await files.list().sorted(by: { $0.imageID < $1.imageID }) {
            if listed.contains(held.imageID) {
                present.insert(held.imageID)
                if held.listedBy != machineID { try await files.markListed(held.imageID, by: machineID) }
            } else if held.listedBy == machineID, !(await operations.isRunning(subject: held.imageID)) {
                _ = try await files.remove(held.imageID)
                deleted.append(["image": held.imageID, "detail": "deleted image \(held.imageID): the account catalog no longer lists it here"])
            } else { unknown.append(held.imageID) }
        }
        return ["images": present.count, "missing": listed.subtracting(present).sorted(), "deleted": deleted, "unknown": unknown]
    }

    /// `record` once it finishes, or as it stands when the wait ends. As job.wait: without `timeoutMs`, the wait lasts as
    /// long as the request may run, leaving a second to answer before its deadline. A capture usually finishes inside
    /// that, so `image.create` mostly answers with the saved image rather than a pending one.
    private func settled(_ record: HostOperationRecord, _ request: [String: Any], timeoutMs: Int?) async -> HostOperationRecord {
        let deadline = (request["deadline_ms"] as? NSNumber)?.intValue ?? 30_000
        return await operations.wait(record.key, timeoutMs: min(timeoutMs ?? Int.max, max(0, deadline - 1_000))) ?? record
    }

    /// A record as callers see it: everything but the checkpoint, which is the kind's private resume point.
    private func view(_ record: HostOperationRecord) -> [String: Any] {
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        guard let data = try? encoder.encode(record), var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ["key": record.key] }
        object["checkpoint"] = nil
        return object
    }

    private func success(_ request: [String: Any], result: Any) -> Data { envelope(request, ["ok": true, "result": result]) }

    private func failure(_ request: [String: Any], code: String, message: String) -> Data {
        envelope(request, ["ok": false, "error": ["code": code, "message": message, "retryable": false]])
    }

    /// The same envelope identity `SandboxHost` answers with.
    private func envelope(_ request: [String: Any], _ values: [String: Any]) -> Data {
        let identity: [String: Any] = [
            "protocol_version": request["protocol_version"] as? String ?? protocolVersion,
            "request_id": request["request_id"] as? String ?? "unknown",
            "operation": request["operation"] as? String ?? "unknown",
            "sandbox_id": NSNull(),
            "release_id": releaseID,
        ]
        return (try? JSONSerialization.data(withJSONObject: identity.merging(values) { _, latest in latest })) ?? Data("{}".utf8)
    }
}
