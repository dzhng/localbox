# Localbox production

## Goal

Ship Localbox as a usable product: a signed macOS Apple Silicon host runs one durable Linux ARM64 VM; the host maintains an outbound HTTPS polling connection to a Vercel relay; Convex is the durable control-plane state; a logged-in CLI is the default interface; and an optional MCP endpoint exposes the same complete operation catalog. One owner account may connect any number of agents to the same MCP server. There is no invite workflow.

The existing `specs/done/agent-computer` material is the testable foundation and evidence base. This spec now owns the production seams for native VM boot, guest execution, durable relay state, full CLI parity, image verification, and signed release activation; the remaining work is evidence from Apple hardware and deployed services. Local Convex/Vercel-compatible smoke and signed packaging now run with the repository and local release credentials.

## Settled decisions

| Decision | Resolution | Why / evidence |
|---|---|---|
| Remote interface | Operation tunnel over the existing catalog | Shell, filesystem, jobs, browser, desktop, VM controls share one authority and envelope. |
| Default client | CLI after `localbox login` | User explicitly chose CLI-first; every MCP capability must be available on CLI. |
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
- `GuestGateway` owns the guest-side shell, filesystem, job, browser, and desktop catalog. The production image starts loopback Xvfb/XFCE/VNC/Chromium and selects the CDP/X11 backend; the signed image and Apple gate still need hardware validation. The current catalog has no job-submit operation, so the guest job status/wait/cancel/output handlers are compatibility seams rather than a process-backed job scheduler.
- `HostDaemon` intercepts VM lifecycle operations at the authenticated local IPC boundary, so `vm.start`, `vm.stop`, `vm.pause`, `vm.reset`, status, logs, and listing operate on the native lifecycle owner before guest forwarding.
- The macOS `HostDaemon` owns VM lifecycle, image verification, guest channel, reconnect, and local IPC. The Swift probe validates it; it is not a second lifecycle owner.
- `RelayStateRepository` is the only durable relay/OAuth authority. Convex is its production implementation; the local harness implements the same transaction interface.
- Vercel route handlers authenticate, validate, and call repository transactions. OAuth authorization, token rotation, and revocation use the same repository; handlers never dispatch operations, retry mutations, or own in-memory authority.
- CLI and MCP are generated adapters over one remote `AgentClient` and must produce the same request/response/error identities.
- The local VM registry remains a host cache for disk paths; Convex owns account, VM, channel, request, response, auth, audit, and quota state.

## Slice graph

```text
00 contract + CLI/MCP parity corrections
       |
01a ARM64 image contract + guest channel framing
       |
01b reproducible ARM64 image + real guest agent
       |
02 native macOS HostDaemon + local CLI transport seam
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
- Convex reads are bounded and indexed; relay request, channel, and status routes use targeted lookups instead of loading the entire state snapshot on every poll or response.
- Payloads up to the inline limit remain inline; the relay rejects oversized frames. Larger/binary results use the versioned `BlobReference` contract from `packages/blob`, whose signed URLs carry a hash, byte size, content type, and expiry. The in-memory provider is the local harness seam; deployment supplies durable object storage behind the same interface.
- Guest paths never escape the VM root. Shell process groups, output, deadlines, and egress are bounded.
- Reset is explicitly confirmed and destructive. Reprovision preserves the disk unless reset was confirmed.
- A destructive host reset replaces the persistent disk from an immutable template; it never truncates a live disk image.
- Browser targets are generation-scoped. Desktop geometry is 1440x900, loopback-bound, demand-started, and grace-reaped.
- Duet inventory verification probes actual ARM64 executables/linkage and Python imports inside the built image; a manifest string alone is insufficient.

## Verification map

| Gate | Evidence |
|---|---|
| G0 | `npm run build`, `npm test`; catalog/help/tool snapshots and malformed-request tests. |
| G1 | Reproducible ARM64 image build, digest, actual tool probes, guest readiness and inventory report. |
| G2 | Apple Silicon cold/warm boot, persistent marker, guest channel, pause/resume, clean stop, no leaks. Local HostDaemon/IPC coverage is green; hardware and launchd remain external. |
| G3 | Local Convex deployment starts with `npx convex dev`; restart, lease expiry, dedupe, revocation, and refresh tests. Local harness and local deployment are green; deployed Convex remains external. |
| G4 | Stateless Vercel HTTP contract against local Convex through `npm run dev:local`; concurrent polls, stale epochs, ack/replay, limits, uncertain response, and the full catalog relay path. |
| G5 | Logged-in CLI invokes all catalog operations through local and HTTPS paths with identical envelopes/errors/help; `tests/catalog-relay-parity.test.ts` drives the real Web Request handler, host poller, and remote transport. |
| G6 | MCP metadata/PKCE/tools list and tools call equal CLI behavior; MCP is optional. Local parity is green; deployed smoke remains external. |
| G7 | Sleep/network/guest-crash recovery, redacted audit/quotas, signed/notarized ARM64 app/CLI/image verification and rollback. Local signed packaging and manifest verification are green with fixture VM inputs; notarization and bootable-artifact installation remain external. |

## Remaining external gates

- Apple Virtualization must boot the published ARM64 kernel/initrd/disk, attach
  virtio-serial to `GuestService`, and exercise cold/warm persistence,
  pause/resume, sleep recovery, and clean stop on Apple Silicon.
  A local artifact boot attempt reached `HostDaemon` but stopped before VM
  validation with `VZErrorDomain Code=2`: the process lacked the
  `com.apple.security.virtualization` entitlement. The next run must use the
  signed entitlement-bearing product bundle.
- A real Convex deployment and Vercel project must be provisioned with the
  environment variables in `DEVELOPMENT.md`; the local schema/function harness,
  local Convex deployment, and local route contract cover the transaction
  behavior, including repository-backed OAuth authorization, token rotation,
  and revocation.
- The blob seam is complete: `packages/blob` provides the local harness provider
  and a private Vercel Blob provider with bounded size/TTL, signed downloads,
  hashes, and prefix isolation. The deployed relay still needs a real
  `BLOB_READ_WRITE_TOKEN` and an internet smoke run.
- Release infrastructure must publish bootable ARM64 kernel, initrd, and
  template-disk artifacts, provide notarization credentials, and run the signed
  clean-machine install, interrupted upgrade, and rollback tests. Local
  packaging imports the screen-recorder PKCS#12 into a disposable keychain and
  signs the app/CLI; the repository now provides the versioned installer and
  rollback commands, while their real launchd/Virtualization path remains
  hardware-gated. The release script intentionally requires externally
  supplied boot artifacts; the container image builder does not manufacture
  them.

## Delegated implementation choices

The implementer may choose internal names and package layout within the owners above. Unless new evidence contradicts them, use Debian Bookworm ARM64 as the base, system Chromium/Playwright with CDP for browser control, XFCE + a loopback-only VNC server for desktop, virtio-serial for the guest channel, short bounded HTTP polls rather than long-lived Vercel requests, and Keychain for macOS credentials. These are reversible implementation choices; changing them requires updating the owning slice and choices ledger.

## Next Agent Prompt

You are resuming the production spec. All code-level seams are implemented and committed: pinned ARM64 image/guest entrypoint with loopback desktop services, authenticated HostDaemon IPC seam with the installed CLI as its default client, named virtio-console framing, host-owned VM lifecycle routing, complete guest catalog handlers, safe template-disk reset, bounded/indexed Convex relay reads with unique VM identities and usable channel rotation, lease-owned response completion, Vercel relay/poller with fail-closed production environment checks, signed blob references with bounded replay cleanup, repository-backed MCP OAuth, Keychain-aware CLI token storage, recovery, versioned install/rollback scripts, and signed release manifests with verified atomic activation and rollback. The last verified pre-desktop ARM64 Docker image had digest `sha256:7adaf4b410916c868dee76dcebb581a2d1e0c5fd32449c0987b3522684a82c69` and inventory digest `sha256:b790c8762f8d8a61972cd9811760de53c649a0b0a734e48e6be45522822b2db2`; 69 TypeScript tests and 9 HostDaemon Swift tests pass; the full catalog parity test drives the actual Vercel Web Request handler, host poller, and remote transport. Rebuild and reverify the image after the desktop-service and Node-runtime Dockerfile changes. Remaining external validation is Apple Virtualization/virtio-serial and launchd, deployed Convex/Vercel internet smoke, durable object storage, then notarized packaging and an interrupted upgrade/rollback run. Keep CLI primary and MCP optional; do not add invites or a second operation/auth owner. Do not claim production usability until gates G2–G7 are green.

Pickup priority is: (1) run the published ARM64 kernel/initrd/template disk through an entitlement-bearing signed HostDaemon bundle and launchd, including sleep and guest-crash recovery; (2) deploy Convex and Vercel and run internet CLI/MCP smoke; (3) bind `BlobProvider` to durable object storage; (4) sign, notarize, install, interrupt, and roll back the release. A local unsigned boot attempt was rejected for the missing `com.apple.security.virtualization` entitlement; deployment credentials and signed packaging are still required.

## Global TODO

- [x] Slice 00: freeze contract and generic CLI/MCP parity, including destructive reset input.
- [x] Slice 01a: freeze image manifest, Duet inventory, and guest channel framing.
- [x] Slice 01b: build/publish reproducible ARM64 image and real guest agent (Docker/Apple Silicon gate pending).
- [x] Slice 02: implement native HostDaemon lifecycle owner and named virtio-console guest channel; boot/readiness remains hardware-gated.
- [x] Slice 03 seam: add Convex-compatible repository and isolated local harness.
- [x] Slice 03b: add production Convex schema/functions and `convex-test` transaction harness.
- [x] Slice 04 seam: add stateless HTTP polling routes and remote CLI transport against the local repository.
- [x] Slice 04b seam: add Vercel Web Request handler and outbound host poller; deployed smoke remains pending.
- [x] Slice 02b: add authenticated local IPC forwarding into HostDaemon and a launchd executable/plist seam; hardware boot smoke and signed installer remain pending.
- [ ] External G2: run entitlement-bearing HostDaemon on Apple Silicon with cold/warm persistence, sleep/network/guest-crash recovery, and launchd.
- [ ] External G3/G4/G5/G6: push Convex/Vercel, bind durable Blob storage, and run deployed CLI/MCP internet smoke with production credentials.
- [x] Blob payload seam: signed expiring references, local and Vercel Blob providers, relay download path, and guest/relay large-result integration; deployed token/smoke remains external.
- [x] Slice 05: wire optional MCP endpoint and repository-backed OAuth/PKCE endpoints to durable Convex state with exact catalog parity; deployed smoke remains pending.
- [x] Slice 06 seam: add recovery timeline, redacted audit/quota state, Ed25519 release-manifest signing, verified atomic release activation/rollback, ARM64 app/CLI packaging, bundled Node runtime, and clean-machine install/rollback scripts; production signing/notarization and hardware smoke remain pending.
- [x] Local closeout: 69 TypeScript tests, 9 Swift HostDaemon tests, `npm run build`, Swift build, full catalog Web Request/host-poller parity, guest catalog smoke, production desktop handler smoke, relay lease-owner regressions, local Convex/Web Request smoke, and a signed release-package smoke with non-bootable fixture inputs pass. The updated desktop/Node image must be rebuilt and reverified in an ARM64 Docker environment, and the signed package still needs real boot artifacts and hardware validation.
