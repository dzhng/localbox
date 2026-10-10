# Slice 00 — Contract and CLI/MCP parity

## Contract unlocked

One catalog is executable by the CLI and MCP. Every current operation has a canonical input schema, generated help/tool description, explicit limits, and safe mutation semantics.

## Seam

`packages/contract` remains the sole owner. Add the missing destructive confirmation to `vm.reset` (for example `discard_state` plus `confirm: "RESET"`), and add a generic client-facing invocation shape that preserves the existing `RequestEnvelope`/`ResponseEnvelope`. CLI aliases may be generated from `operationCatalog`; MCP tools must use the same entries.

The CLI must support `agent-computer login`, `status`, and a generic `invoke <operation>` path even before remote transport lands. It must expose every catalog entry in help and validate input/deadlines/mutation IDs before dispatch.

## Human runnable artifact

`node bin/agent-computer.js contract`, `... help --json`, and `... invoke system.info --input-json '{}' --json` show the same catalog identity. `... invoke vm.reset ...` refuses without explicit confirmation.

## Verification

- Existing `npm run build` and `npm test` remain green.
- Add a parity matrix over all catalog entries: CLI help snapshot equals `helpSnapshot()` and MCP `tools/list`; malformed fields, unknown operations, missing mutation IDs, stale VM IDs, and reset without confirmation fail closed.
- Add deterministic fixture tests for generic CLI invocation and explicit uncertainty/retry flags.

## Delegated choices

Internal argument parser and output formatting are free to change. Operation names, envelope fields, limits, and error codes are not.
