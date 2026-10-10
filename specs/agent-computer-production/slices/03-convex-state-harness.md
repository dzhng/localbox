# Slice 03 — Convex state owner and local harness

## Contract unlocked

Relay, OAuth, leases, dedupe, audit, and quotas survive process restarts and concurrent serverless invocations.

## Seam

Add a `RelayStateRepository` interface and Convex functions/schema for owner accounts, VMs, channel grants/epochs/revocation, request and response frames, lease ownership/expiry, mutation dedupe, OAuth code/access/refresh families, audit records, and quotas. Store token/channel hashes where possible; never persist raw shell output as audit data.

Add a Duet-inspired local Convex harness that starts an isolated deployment, pushes this schema, exposes a client, and cleans up. The local harness and Convex production adapter implement the same transaction semantics; in-memory fixtures may remain only as unit doubles.

## Human runnable artifact

A local test command boots Convex, creates one owner/VM/channel, enqueues and claims a request, records a response, restarts the harness, and resolves exact replay, lease expiry, stale epoch, revocation, and refresh rotation.

## Verification

- Atomic unique request IDs and `(vm, operation, mutation_id)` dedupe; conflicting payloads fail.
- Concurrent pollers cannot claim one frame twice; expired leases redeliver safely.
- OAuth PKCE code use, access expiry, refresh rotation/replay family revocation, audience and VM binding.
- Convex local harness tests run in CI and use injected clock/IDs for deterministic evidence.
