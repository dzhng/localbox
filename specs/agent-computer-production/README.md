# Agent Computer production

## Goal

Ship Agent Computer as a usable product: a signed macOS Apple Silicon host runs one durable Linux ARM64 VM; the host maintains an outbound HTTPS polling connection to a Vercel relay; Convex is the durable control-plane state; a logged-in CLI is the default interface; and an optional MCP endpoint exposes the same complete operation catalog. One owner account may connect any number of agents to the same MCP server. There is no invite workflow.

The existing `specs/done/agent-computer` material is the testable foundation and evidence base. It is not the production implementation: native VM boot, real guest execution, durable relay state, full CLI parity, image publication, and signed distribution remain to be built.

## Settled decisions

| Decision | Resolution | Why / evidence |
|---|---|---|
| Remote interface | Operation tunnel over the existing catalog | Shell, filesystem, jobs, browser, desktop, VM controls share one authority and envelope. |
| Default client | CLI after `agent-computer login` | User explicitly chose CLI-first; every MCP capability must be available on CLI. |
| MCP | Optional separate endpoint; product publishes install details | MCP is a compatibility adapter, not a prerequisite for CLI use. |
| Transport | Vercel HTTPS polling; Mac always dials out | Vercel functions are stateless/short-lived; no inbound port or VPN setup. |
| Durable state | Convex, with a local Convex test harness | User selected Convex and asked to follow Duet's isolated deployment pattern. |
| Audience | One owner account, one or many agents, no invites | Revocation is credential/channel scoped. |
| Operation scope | Complete current catalog | Includes shell, filesystem, jobs, browser, desktop, VM, network, and relay operations. |
| Image | Our own reproducible pinned ARM64 image | Duet's tool inventory is the compatibility target, not its image identity. |
| Image inventory | Carry Duet's prebuilt workflow programs/modules; substitute ARM64 artifacts where necessary | Duet's amd64-specific binaries cannot be copied blindly. |
| Data compatibility | Hard cutover; no compatibility shim or migration scaffolding | This is unshipped development infrastructure. |

## One-owner architecture

- `packages/contract` owns operation IDs, input schemas, envelopes, limits, idempotency, and generated CLI/MCP help.
- `packages/client` owns request identity, explicit retry/uncertainty behavior, and transport selection.
- `packages/guest-gateway` plus the in-VM guest agent own shell/filesystem/jobs and the mutation journal. The relay never executes handlers.
- `DesktopRuntime` is replaced in production by the guest desktop/browser backend; it remains the deterministic fixture oracle.
- The macOS `HostDaemon` owns VM lifecycle, image verification, guest channel, reconnect, and local IPC. The Swift probe validates it; it is not a second lifecycle owner.
- `RelayStateRepository` is the only durable relay/OAuth authority. Convex is its production implementation; the local harness implements the same transaction interface.
- Vercel route handlers authenticate, validate, and call repository transactions. They never dispatch operations, retry mutations, or own in-memory authority.
- CLI and MCP are generated adapters over one remote `AgentClient` and must produce the same request/response/error identities.
- The local VM registry remains a host cache for disk paths; Convex owns account, VM, channel, request, response, auth, audit, and quota state.

## Slice graph

```text
00 contract + CLI/MCP parity corrections
       |
01 ARM64 image + real guest agent seam
       |
02 native macOS HostDaemon + local CLI transport
       |
03 Convex repository + local harness
       |
04 Vercel HTTPS relay + host poller + remote CLI
       |\
       | 05 optional MCP/OAuth parity
       |
06 recovery, observability, signed release, installer
```

Slices 01 and 02 may use the existing fake backend for deterministic tests, but each must leave a real Apple Silicon gate. Slice 03 precedes all Vercel routes. Slice 04 is the first internet-usable checkpoint. Slice 05 must not introduce a separate operation or auth owner. Slice 06 is the ship gate.

## Cross-cutting invariants

- Every request carries protocol version, request ID, operation ID, VM ID, deadline, and mutation ID; responses preserve identity and release/image identity.
- Mutations are never implicitly retried after a lost response. Exact replay with the same mutation ID returns the recorded response; conflicting payloads fail closed.
- Channel grants are VM-bound, epoch-bound, revocable, lease-owned, and stored as hashes where possible. Stale epochs/tokens are rejected transactionally.
- Convex transactions make enqueue, claim, ack, response retention, mutation dedupe, refresh rotation, and revocation atomic.
- Payloads up to the inline limit remain inline; larger/binary screenshots and files use signed expiring blobs with hash and size metadata.
- Guest paths never escape the VM root. Shell process groups, output, deadlines, and egress are bounded.
- Reset is explicitly confirmed and destructive. Reprovision preserves the disk unless reset was confirmed.
- Browser targets are generation-scoped. Desktop geometry is 1440x900, loopback-bound, demand-started, and grace-reaped.
- Duet inventory verification probes actual ARM64 executables/linkage and Python imports inside the built image; a manifest string alone is insufficient.

## Verification map

| Gate | Evidence |
|---|---|
| G0 | `npm run build`, `npm test`; catalog/help/tool snapshots and malformed-request tests. |
| G1 | Reproducible ARM64 image build, digest, actual tool probes, guest readiness and inventory report. |
| G2 | Apple Silicon cold/warm boot, persistent marker, guest channel, pause/resume, clean stop, no leaks. |
| G3 | Local Convex deployment starts via Duet-style harness; restart, lease expiry, dedupe, revocation, and refresh tests. |
| G4 | Stateless Vercel HTTP contract against local Convex; concurrent polls, stale epochs, ack/replay, limits, uncertain response. |
| G5 | Logged-in CLI invokes all catalog operations through local and HTTPS paths with identical envelopes/errors/help. |
| G6 | MCP metadata/PKCE/tools list and tools call equal CLI behavior; MCP is optional. |
| G7 | Sleep/network/guest-crash recovery, redacted audit/quotas, signed/notarized ARM64 app/CLI/image verification and rollback. |

## Landmines carried into implementation

- The native backend currently validates then throws unsupported (`apps/macos/VMProbe/Sources/VMProbeCore/AppleVirtualizationBackend.swift:14-23`).
- Relay and OAuth are explicitly in-memory fixtures (`apps/relay/src/index.ts:19`, `apps/relay/src/oauth.ts:44`).
- Current CLI auth only saves a fixture token (`apps/cli/src/index.ts:61-110`) and current transports are fixtures (`packages/client/src/index.ts:58-63`).
- Image verification checks manifest metadata only (`packages/vm-image/src/index.ts:14-26`).
- Guest and desktop adapters are host-side deterministic fixtures, not a Linux guest channel (`packages/guest-gateway/src/index.ts:133`, `packages/desktop/src/index.ts:7`).
- `vm.reset` must gain canonical destructive confirmation in the contract before CLI/MCP parity can be safe.
- The current relay frame model does not provide durable lease/claim/ack semantics or large-payload storage.

## Delegated implementation choices

The implementer may choose internal names and package layout within the owners above. Unless new evidence contradicts them, use Debian Bookworm ARM64 as the base, system Chromium/Playwright with CDP for browser control, XFCE + a loopback-only VNC server for desktop, virtio-serial for the guest channel, short bounded HTTP polls rather than long-lived Vercel requests, and Keychain for macOS credentials. These are reversible implementation choices; changing them requires updating the owning slice and choices ledger.

## Next Agent Prompt

You are resuming `agent-computer-production`. Read this README and the next uncompleted slice. Start at **slice 00**. Implement only that slice, run its focused tests plus the existing build/test gates, apply refactor-clean/code-review/write-docs and audit-choices, commit the clean pass, and update this section with the exact next pickup point. Do not claim production usability until gates G1–G7 are green. Keep CLI as the primary interface and MCP optional; do not add invites or a second operation/auth owner.

## Global TODO

- [ ] Slice 00: freeze contract and generic CLI/MCP parity, including destructive reset input.
- [ ] Slice 01: build/publish reproducible ARM64 image and real guest agent.
- [ ] Slice 02: implement native HostDaemon lifecycle and local IPC transport.
- [ ] Slice 03: add Convex schema/repository and isolated local harness.
- [ ] Slice 04: add Vercel polling routes, host poller, and remote CLI transport.
- [ ] Slice 05: wire optional MCP/OAuth to durable state with exact CLI parity.
- [ ] Slice 06: integrate recovery, quotas/audit, signing/notarization, installer, and rollback.
