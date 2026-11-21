# 26 Durable host operations

**Unlocks:** L3. Long host work survives daemon and connector restarts, a replayed
mutation returns the same operation, and callers poll with a bounded wait instead
of holding a request open.

## Seam

- `HostDaemonCore/HostOperationStore.swift` (new actor, separate from `SandboxHost`):
  - Journal at `machinePaths().operations/<mutation_id>.json`:
    `{ kind, subject, state, progress, result | error, startedAt, updatedAt }`.
  - `begin(kind, key, work) -> ImageOperationState`: a key already in the journal
    returns its record and never starts the work twice (today the daemon dedupes
    only on sandbox id, `SandboxHost.swift:494-497`).
  - `state(key)`, `wait(key, timeoutMs ≤ 120_000)`.
  - Kinds register a resumer at daemon start; an unfinished record resumes from its
    checkpoint (a resume bitmap or phase), never from scratch.
- Daemon host op `image.wait` reads it; `image.create`, `image.copy` and
  create-with-copy (later slices) return the record at once.
- Relay: a pending state is a normal result, so `relay:enqueue`'s stored response
  (`packages/state/convex/relay.ts:39-43`) is the operation's current state, never a
  timeout. `image.wait` long-polls with the client's existing `{continue}` loop
  (`packages/client/src/index.ts:76`), at most 120 s per call.
- The connector reports holder state changes (`imageHolders.setHolder`) when an
  operation finishes.

## See it

A fixture operation kind `sleep_steps` (test-only, registered in the test target)
that advances a counter: start it, kill the daemon, restart, `image wait` shows it
continue from its last step.

## Gates

- Tier `s`, `HostOperationStoreTests`: resume after a simulated restart, replay
  returns the same record, `wait` is bounded, two kinds run at once without
  blocking the `SandboxHost` actor.
- Tier `l`, probe 26: connector restart mid-operation; a lost response then a replay
  returns the live state.

## Delegated

Journal encoding, progress granularity, how often progress is written.

## Firewall

No image logic here; kinds are registered by their owning slices (28, 34, 38, 39).

## Stays green

`tests/connector.test.ts`, `tests/connector-job.test.ts`, `tests/ops-errors.test.ts`.
