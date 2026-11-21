import Foundation

/// `sleep_steps`, the proof's stand-in for a long image operation (dev daemons only, `LOCALBOX_DEV=1`): it advances a
/// counter to `steps`, one step every `step_ms`, journaling each step as its checkpoint, and finishes with a size so the
/// connector reports a ready holder. Checkpoint: `{ done, steps, step_ms }`.
public enum FixtureOperations {
    public static let sleepSteps = "sleep_steps"

    public static func register(on store: HostOperationStore) async {
        await store.register(kind: sleepSteps) { context in
            guard case .object(let checkpoint) = context.checkpoint, case .number(let done)? = checkpoint["done"], case .number(let steps)? = checkpoint["steps"], case .number(let stepMs)? = checkpoint["step_ms"] else {
                throw HostOperationFailure(code: "invalid_input", message: "sleep_steps needs a checkpoint { done, steps, step_ms }")
            }
            for step in Int(done)..<Int(steps) {
                try await Task.sleep(nanoseconds: UInt64(stepMs) * 1_000_000)
                var next = checkpoint; next["done"] = .number(Double(step + 1))
                try await context.report(HostOperationProgress(phase: "stepping", completed: step + 1, total: Int(steps)), checkpoint: .object(next))
            }
            return .object(["steps": .number(steps), "size_bytes": .number(steps * 1_048_576)])
        }
    }
}
