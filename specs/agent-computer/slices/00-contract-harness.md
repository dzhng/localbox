# Slice 00 — Contract harness

## Contract unlocked

The repository has one versioned operation catalog and deterministic fake runtime
that every later adapter can use without a real VM.

## API seam and ownership

Create `packages/contract` with operation IDs, JSON Schemas, envelopes, stable
errors, retry/idempotency metadata, limits, and generated help. Create a small
`packages/runtime` fake dispatcher with one handler registry and a fixture clock.
Adapters must consume the catalog and never define operations.

## Runnable artifact

`agent-computer contract probe` prints catalog/help snapshots and invokes a fake
`system.info` operation. The output is deterministic and suitable for a golden
fixture.

## Verification

- Schema validation rejects unknown operations and malformed fields.
- CLI-help and generated MCP-tool snapshots are identical in operation identity.
- Success/error envelopes preserve request, operation, VM, and release identity.
- Property tests cover deadlines, cancellation, retryability, and mutation IDs.
- A parity harness can invoke every catalog entry through a direct dispatcher.

## Delegated decisions

Internal schema library and package names may vary. Operation semantics and error
fields may not.

## Human review

No visual gate. Review the catalog and envelope snapshot as the API decision.
