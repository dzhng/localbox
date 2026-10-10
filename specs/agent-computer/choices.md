# Spec choices ledger

This ledger records decisions made while turning the product map into an
implementation plan. It is intentionally separate from the slice contracts so
an implementer can be reviewed on judgment calls without rereading the diff.

## Confirmed by the user

- The product is a personal agent computer with a virtual desktop.
- A hosted outbound relay replaces Tailscale and inbound port configuration.
- The VM is durable and reset is explicit.
- Shell is the authority; other tools are conveniences.
- The VM is the sole security boundary. Do not split capabilities inside it.
- MCP uses Streamable HTTP and OAuth, but MCP is optional.
- CLI and MCP must expose exactly the same functionality.
- The CLI should let an agent start without MCP by reading the repo/site skill
  and downloading the CLI.
- The CLI is remote-capable for cloud agents and uses the Mac app's local socket
  when invoked on the host; both paths use one transport-neutral client.
- One VM is the default; multiple VMs are acceptable if low effort.

## Answered on the user’s behalf

- **No compatibility or migration scaffolding.** This is a new repository with
  no deployed data; hard cutovers keep the first implementation legible.
- **Model `vm_id` from day one while defaulting to one VM.** This follows the
  user’s “one by default, more if not too much effort” preference and avoids a
  second security model later.
- **Trust the relay with payloads in v1.** The product goal prioritizes a simple
  install and operation path; end-to-end payload encryption is deferred until
  it has a clear owner and measured need.

## Delegated implementation choices

The implementer may choose the internal language, package manager, test runner,
Linux distribution, kernel/rootfs, image builder, relay hosting/storage, SwiftUI
visual styling, and OAuth library only within the ownership and verification
contracts in the README. A choice that changes those contracts requires a new
slice or an explicit user decision.

## Rejected alternatives

- Tailscale and manual port forwarding: violate the zero-setup product promise.
- Raw remote desktop as the only API: makes routine shell/files/browser work
  slower and less reliable.
- Per-tool scopes or approval prompts: add complexity without a new boundary
  inside an authorized VM.
- Per-agent desktops or browser profiles: split shared login/observation and do
  not protect a VM whose shell is already authoritative.
- Silent retry of mutations: cannot distinguish a lost response from a failed
  write.

### Slice 00 implementation decisions

- TypeScript on Node.js with `tsx` and the built-in `node:test` runner keeps the
  contract runnable on the host without a service or VM dependency.
- The contract owns a 37-entry operation catalog, a small JSON Schema subset,
  versioned request/response envelopes, stable error codes, retry/idempotency
  metadata, and generated CLI/MCP help snapshots.
- The fake runtime uses a fixture clock starting at `1700000000000` and a single
  handler registry. Mutation IDs cache the complete response so exact replay is
  deterministic; deadlines and cancellation are checked around every handler.
- `agent-computer contract probe` emits catalog, help, and a `system.info` fake
  response as one stable JSON document. Snapshots are committed under
  `snapshots/` and parity tests invoke every catalog entry through the same
  dispatcher.
