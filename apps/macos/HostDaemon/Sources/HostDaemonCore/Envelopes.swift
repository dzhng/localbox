import Foundation

/// The envelope every answer the daemon makes itself travels in: the request's identity (protocol, request id,
/// operation, sandbox id or null) and this release, then `ok` with a `result` or an `error`.
enum Reply {
    static func success(_ request: [String: Any], _ result: Any) -> Data { envelope(request, ["ok": true, "result": result]) }

    /// `retryable`: the same request may succeed later as it is (a wait, not a fault in the request).
    static func failure(_ request: [String: Any], code: String, message: String, details: [String: Any]? = nil, retryable: Bool = false) -> Data {
        var error: [String: Any] = ["code": code, "message": message, "retryable": retryable]
        if let details { error["details"] = details }
        return envelope(request, ["ok": false, "error": error])
    }

    /// A host operation's failure, with its next step (when it has one) in `details.next_step`.
    static func failure(_ request: [String: Any], _ failure: HostOperationFailure) -> Data {
        Self.failure(request, code: failure.code, message: failure.message, details: failure.nextStep.map { ["next_step": $0] })
    }

    private static func envelope(_ request: [String: Any], _ values: [String: Any]) -> Data {
        let identity: [String: Any] = [
            "protocol_version": request["protocol_version"] as? String ?? protocolVersion,
            "request_id": request["request_id"] as? String ?? "unknown",
            "operation": request["operation"] as? String ?? "unknown",
            "sandbox_id": request["sandbox_id"] as? String as Any? ?? NSNull(),
            "release_id": releaseID,
        ]
        return (try? JSONSerialization.data(withJSONObject: identity.merging(values) { _, latest in latest })) ?? Data("{}".utf8)
    }
}

/// A request the host makes itself, shaped as the relay sends one: a fresh request id, `deadlineMs`, and a fresh
/// mutation id unless it only reads (`mutates: false`).
public func requestEnvelope(_ operation: String, sandboxID: String?, input: [String: Any] = [:], deadlineMs: Int, mutates: Bool = true) throws -> Data {
    try JSONSerialization.data(withJSONObject: ["protocol_version": protocolVersion, "request_id": UUID().uuidString, "operation": operation, "sandbox_id": sandboxID as Any? ?? NSNull(),
                                                "deadline_ms": deadlineMs, "mutation_id": mutates ? UUID().uuidString : NSNull(), "input": input] as [String: Any])
}

/// The longest deadline the guest agent accepts on a request (it refuses more than 120 s).
let guestMaxDeadlineMs = 120_000

/// `shell.exec` through the guest agent's request lane, which runs it as root: its stdout, or a throw with the tail of
/// its output when it exits non-zero. `step` says what runs, for the error ("a build step").
func rootShell(on channel: any GuestChannel, sandboxID: String, step: String) -> GuestDiskClaim.RootShell {
    { script, timeout in
        let request = try requestEnvelope("shell.exec", sandboxID: sandboxID, input: ["command": script], deadlineMs: min(Int(timeout * 1000), guestMaxDeadlineMs))
        let answer = try JSONSerialization.jsonObject(with: try await channel.send(request)) as? [String: Any] ?? [:]
        guard answer["ok"] as? Bool == true, let result = answer["result"] as? [String: Any] else {
            throw HostDaemonError.unsupported("the guest agent refused \(step): \(((answer["error"] as? [String: Any])?["message"] as? String) ?? "no answer")")
        }
        let status = (result["exit_code"] as? NSNumber)?.intValue ?? -1
        let stdout = result["stdout"] as? String ?? "", stderr = result["stderr"] as? String ?? ""
        guard status == 0 else { throw HostDaemonError.unsupported("\(step) in the guest exited \(status): \(String((stderr + stdout).suffix(1500)))") }
        return stdout
    }
}
