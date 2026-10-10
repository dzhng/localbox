# Agent Computer

Agent Computer gives a local or cloud agent one durable Linux ARM64 computer on a Mac. Shell is the authority inside the VM; filesystem, browser, desktop, CLI, and MCP are adapters over the same versioned operation catalog. The host stays outside the VM boundary and the relay uses an outbound channel so the user does not configure inbound ports or a VPN.

The shipped code is a host-testable product foundation with native macOS probe seams. The deterministic runtime, guest gateway, desktop/browser model, relay, OAuth, MCP, recovery supervisor, registry, release verifier, and consumer skill are runnable in CI. The native Apple Virtualization adapter validates pinned image configuration and deliberately reports that host-daemon lifecycle wiring is still required before it can claim a real boot. That failure remains visible instead of silently selecting the fixture backend.

## Why this shape exists

The VM is the only security boundary. Splitting permissions between shell, browser, and filesystem would create a second policy system without protecting an already-authorized VM, so convenience operations share one dispatcher and one error model. The relay transports authenticated frames and may observe payloads in v1; it does not implement business handlers or silently retry mutations. A lost mutation response is therefore reported as uncertain and can only be resolved by status or exact replay with the same mutation identity.

The catalog lives in `packages/contract`. CLI help, MCP tools, request/response envelopes, retry flags, limits, and schema validation are generated from that owner. `packages/runtime` supplies the deterministic dispatcher used by tests and fixtures. `packages/client` owns request identity and transport selection. The guest gateway and desktop runtime are separate owners so host transport, guest process/filesystem controls, and browser/desktop demand lifecycle do not grow parallel implementations.

The native probe is intentionally swappable. `apps/macos/VMProbe` has a fake backend for repeatable persistence and reconnect evidence plus an Apple Virtualization backend that validates ARM64 kernel, initrd, rootfs, disk, NAT, and virtio configuration. The native backend throws an explicit unsupported result until a host daemon supplies the long-lived VM lifecycle and guest channel.

## Invariants

- Every operation carries protocol version, request ID, operation ID, VM ID, deadline, and mutation ID. Replies preserve those identities and release identity.
- Unknown operations, unknown input fields, malformed values, missing required mutation IDs, expired authorization, stale VM IDs, stale relay epochs, and stale browser generations fail closed.
- A mutation is never retried implicitly after a lost response. Durable guest journaling returns the original response for an exact duplicate mutation ID.
- Guest filesystem paths are rooted inside the VM filesystem. Shell process groups, output size, and execution time are bounded.
- The desktop uses one 1440×900 display model, one browser profile, demand-driven startup, and grace-based reap. Browser target IDs are generation-local witnesses.
- OAuth access and refresh tokens are audience-bound and VM-bound. Refresh rotation supports a short replay grace and revokes the whole family on replay outside that grace.
- Reset is explicit and destructive. Reprovision preserves the registry disk path and guest state unless the caller confirms discard.
- Release verification checks ARM64, artifact checksums, release schema, and image digest before installation. The consumer skill teaches CLI-first use; MCP remains optional.

## Where to look

- Catalog, schemas, envelopes, and help: `packages/contract/src/index.ts`.
- Dispatcher and fixture clock: `packages/runtime/src/index.ts`.
- Local/remote client and uncertain transport behavior: `packages/client/src/index.ts`.
- Guest sandbox and mutation journal: `packages/guest-gateway/src/index.ts`.
- Fixed desktop and generation-scoped browser targets: `packages/desktop/src/index.ts`.
- Relay frames/supervision and OAuth: `apps/relay/src/index.ts`, `apps/relay/src/oauth.ts`.
- Streamable HTTP MCP mapping: `apps/mcp/src/index.ts`.
- Recovery and durable VM registry: `packages/recovery/src/index.ts`, `packages/registry/src/index.ts`.
- Native probe and host status seam: `apps/macos/VMProbe`, `apps/macos/HostDaemon`.
- Release verification and consumer runbook: `scripts/release.ts`, `skills/agent-computer/SKILL.md`.
- Contract, gateway, relay, OAuth/MCP, desktop, recovery, and release behavior: `tests/`.

Run `npm run build && npm test` for the host suite. Run `swift test --package-path apps/macos/VMProbe` for the native probe package. `node bin/agent-computer.js contract probe`, `vm probe --json`, `status --json`, `shell exec -- …`, and `recovery probe --json` are deterministic smoke entry points.

## Decisions and dead ends

The consolidated choices ledger is in [`choices.md`](choices.md). Tailscale and inbound port forwarding were rejected because they violate zero-setup installation. Raw remote desktop as the only API was rejected because routine shell/filesystem work needs a structured contract. Per-tool approval scopes were rejected because shell already grants the VM trust domain. The native VM lifecycle is kept behind an explicit adapter instead of being faked by a compatibility wrapper.

There are no visual baselines in this build: the host status model and desktop runtime have no shipped visual surface yet, so screenshot comparison would invent a target rather than preserve one.
