import Foundation

/// The daemon's answers about images: `image.wait` from the host operation journal, and the connector's
/// `host.operations` long poll, which hands it each finished operation to report to the account. `SandboxHost` routes
/// these requests here and never touches image work itself.
public actor ImageHost {
    private let operations: HostOperationStore
    /// `host.begin_operation` starts any registered kind directly: a dev tool (`LOCALBOX_DEV=1`) for proofs, since the
    /// catalog operations that begin real kinds belong to later slices.
    private let allowsDirectOperations: Bool

    public init(operations: HostOperationStore, allowsDirectOperations: Bool = false) {
        self.operations = operations; self.allowsDirectOperations = allowsDirectOperations
    }

    /// Operations answered here: the catalog's image operations a machine runs, and the connector's internal ones.
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
            // As job.wait: without timeout_ms, wait as long as the request may run, leaving room to answer before its deadline.
            let deadline = (object["deadline_ms"] as? NSNumber)?.intValue ?? 30_000
            let waitMs = min((input["timeout_ms"] as? NSNumber)?.intValue ?? Int.max, max(0, deadline - 1_000))
            guard let latest = await operations.latest(subject: image) else {
                return failure(object, code: "image_not_found", message: "this machine has no operation for image \(image)")
            }
            let record = await operations.wait(latest.key, timeoutMs: waitMs) ?? latest
            return success(object, result: view(record))
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
        default:
            return failure(object, code: "unsupported", message: "this machine does not run \(operation) yet")
        }
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
