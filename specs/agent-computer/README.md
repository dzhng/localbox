# Agent Computer implementation spec

**Status:** Slice 00 shipped; contract and deterministic fake runtime are implemented.  
**Last updated:** 2026-10-09.  
**Current pickup:** Slice 01, Apple VM viability probe.

## Next Agent Prompt

Read this README, [`MAP.md`](MAP.md), and [`SECURITY.md`](../../SECURITY.md).
Implement **Slice 00 only**. Create the shared contract package, deterministic
fake runtime, generated help/catalog snapshots, and the first parity harness.
Do not build the VM, relay, OAuth, desktop, or app UI in that pass. Record the
slice verdict and any new decisions in `choices.md`, update this section before
ending, and keep the global TODO list current.

## Goal

Ship a signed Apple-silicon macOS application that runs one durable,
preconfigured Linux ARM64 VM with a virtual desktop and headful browser. A
cloud or local agent can operate that VM through either the `agent-computer` CLI
or an optional Streamable HTTP MCP server. Both adapters expose the exact same
operation catalog, schemas, behavior, errors, permissions, retry semantics, and
limits.

On first launch the Mac app provisions and starts the default VM and establishes
the outbound relay automatically. The heavier desktop/browser processes remain
demand-started inside that running VM and can be explicitly paused or stopped.

The VM uses the Mac's outbound network, so web requests originate from the
user's current network. A hosted relay receives an outbound connection from the
Mac app; users do not configure Tailscale, port forwarding, UPnP, or inbound
firewall rules.

## Non-goals for v1

- Host filesystem, host process, host credential, clipboard, or arbitrary host
  UI access from the VM.
- Per-tool security scopes, approval prompts, or a second trust boundary inside
  the VM. Shell is the authority.
- A promise that every anti-bot or access-control system accepts residential
  egress.
- Per-agent displays, separate browser profiles, multi-monitor support, audio,
  or responsive guest resolutions.
- Live browser-profile sync while Chrome is running.
- Compatibility shims, data migrations, or deploy-order scaffolding. This is a
  new repository with a hard-cutover plan.

## Product contracts

### One owner per concept

| Concept | Sole owner | Adapters that must not reimplement it |
| --- | --- | --- |
| Operation IDs, JSON schemas, help, envelopes, limits | `packages/contract` | CLI, MCP, relay, app |
| Dispatch, authorization context, idempotency, deadlines | `packages/runtime` | CLI, MCP, relay |
| Transport selection, request identity, reconnect observation | `packages/client` | CLI, MCP, app |
| Host VM lifecycle and disk registry | `apps/macos` host daemon | CLI, MCP, guest |
| Guest shell/files/browser/desktop | `apps/guest-gateway` | CLI, MCP, host UI |
| Outbound channel and OAuth admission | `apps/relay` | guest, CLI, MCP |
| ARM64 image and desktop wiring | `packages/vm-image` | runtime, app |
| Consumer installation and agent runbook | `skills/agent-computer` | app docs, release scripts |

The CLI and MCP are transport adapters. Convenience subcommands compile into
the same catalog operations; MCP tool definitions and descriptions are
generated from the catalog. A change to one operation must produce the same
result/error behavior through both adapters.

### Security boundary

The Linux VM is one trust domain. An authorized VM credential effectively grants
shell-level control of that VM. The host is outside the boundary and exposes
only reviewed lifecycle and transport seams. The hosted relay is trusted with
transport metadata and request/response payloads in v1; it must authenticate,
revoke, rotate, bound, and redact transport without inventing a second tool
authorization model. The full rule is in [`SECURITY.md`](../../SECURITY.md).

### VM and desktop invariants

- One VM is the default account resource; every contract carries `vm_id` so a
  second VM can be added without changing operation semantics.
- The VM disk persists files, packages, browser profile/cookies, and desktop
  state. Reset/reprovision is explicit and destructive when state is discarded.
- One fixed 1440×900 guest display and one shared headful Chrome profile are the
  v1 desktop contract. Browser target/window IDs are generation-local witnesses,
  not security boundaries.
- KasmVNC (or the measured equivalent) and Chrome bind to loopback. The guest
  gateway is the only browser-visible door.
- Desktop lifecycle is demand-driven and reaps only after no live work/viewers
  remain plus a grace interval.
- The live Chrome database remains inside the VM disk; it is never copied while
  Chrome is running.

### Request and error identity

Every call uses a versioned envelope:

```json
{
  "protocol_version": "v1",
  "request_id": "transport-correlation-id",
  "operation": "shell.exec",
  "vm_id": "vm_01",
  "deadline_ms": 30000,
  "mutation_id": "caller-chosen-id-or-null",
  "input": {}
}
```

Successful and failed replies preserve `request_id`, `operation`, `vm_id`, and
release identity. Errors have stable `code`, human-readable `message`,
`retryable`, and optional structured details. A lost response never proves a
mutation failed; only catalog operations explicitly marked safe may be retried,
and exact replay is the only recovery for an uncertain mutation.

Initial error codes are: `invalid_input`, `unauthorized`, `forbidden`,
`vm_not_found`, `vm_not_ready`, `guest_unreachable`, `operation_timeout`,
`operation_cancelled`, `operation_uncertain`, `conflict`, `rate_limited`,
`resource_exhausted`, `host_denied`, `unsupported`, and `internal`.

### Initial operation catalog

The exact JSON Schemas are created in Slice 00. The initial IDs are:

```text
system.info          vm.list              vm.status
vm.start             vm.stop              vm.pause
vm.reset             vm.logs              network.egress
relay.status         shell.exec           job.status
job.wait              job.cancel          job.output
fs.list              fs.stat              fs.read
fs.write             fs.mkdir             fs.remove
browser.list_tabs     browser.open         browser.navigate
browser.focus        browser.close        browser.screenshot
browser.click        browser.type         browser.key
desktop.status       desktop.screenshot   desktop.click
desktop.move         desktop.scroll      desktop.key
desktop.type
```

The catalog may add operations only through a spec update and parity test. It
must not grow a CLI-only or MCP-only permission.

## Slice graph

The graph is deliberately risk-first. Host-only CI runs contract and fixture
tests; an Apple-silicon lane runs virtualization, desktop, sleep, and packaging
probes.

| Slice | Unlocks | Depends on | Runnable proof |
| --- | --- | --- | --- |
| [00 Contract harness](slices/00-contract-harness.md) | One typed catalog and fake runtime | — | `agent-computer contract probe` |
| [01 Apple VM probe](slices/01-apple-vm-probe.md) | Proven local virtualization choice | 00 | `agent-computer vm probe --json` |
| [02 Guest gateway](slices/02-guest-gateway.md) | Shell/files over the VM boundary | 00, 01 | `agent-computer exec run ...` |
| [03 Desktop image](slices/03-desktop-image.md) | Pixels, browser, computer use | 02 | `agent-computer desktop screenshot` |
| [04 Egress diagnostics](slices/04-egress-diagnostics.md) | Evidence about residential routing | 02 | `agent-computer network egress` |
| [05 Local and remote CLI](slices/05-local-cli.md) | Full CLI workflow without MCP | 00–04 | CLI parity matrix |
| [06 Outbound relay](slices/06-outbound-relay.md) | No-inbound-port remote transport | 00, 02, 05 | relay fault probe |
| [07 OAuth resources](slices/07-oauth-resources.md) | VM-scoped authorization | 06 | consent/refresh/revoke journey |
| [08 Remote CLI](slices/08-remote-cli.md) | CLI from a cloud agent | 05–07 | local/remote diff report |
| [09 MCP adapter](slices/09-mcp-adapter.md) | Optional standards-based MCP | 07, 08 | MCP initialize/list/call |
| [10 Recovery](slices/10-recovery.md) | Sleep, reconnect, uncertain writes | 03, 05–09 | injected failure timeline |
| [11 Durable registry](slices/11-durable-registry.md) | Reset/reprovision and low-cost multi-VM | 01–04, 10 | persistence/reset journey |
| [12 Mac app](slices/12-macos-app.md) | Consumer lifecycle/status UI | 05, 10, 11 | packaged app journey |
| [13 Release and skill](slices/13-release-and-skill.md) | Agent-driven installation | 05, 09, 12 | clean-account install |
| [14 Closeout](slices/14-closeout.md) | Shippable, reviewed product | 00–13 | full acceptance and review |

## Review map and firewalls

- Do not proceed past Slice 01 if ARM64 boot, persistent disk, NAT egress, or
  pause/resume is unproven. Record the measured reason and reslice around the
  proven backend.
- Do not expose KasmVNC, CDP, guest shell, or desktop listeners outside guest
  loopback plus the authenticated gateway/virtio channel.
- Do not add relay retry behavior that can duplicate a mutation. Use mutation
  identity, durable guest journaling, and explicit uncertain status.
- Do not add a second operation implementation in an adapter. Generated help,
  schemas, MCP tools, and CLI commands must be parity-tested.
- Do not make OAuth resource selection a custom pairing ceremony. Try standard
  resource selection; if clients cannot select, use the default/only VM in v1.
- Do not promise that residential egress bypasses all anti-bot systems.
- Visual slices must run `screenshot-critique` last. When a pinned target exists,
  also run `compare-screenshots` against the stated crop/mask. Human review is
  non-blocking: open shots with `preview-shots`, allow about five minutes, then
  record the evidence-based decision and close the preview.

## Research anchors

- [Apple Virtualization framework](https://developer.apple.com/documentation/virtualization)
  and [Linux VM tutorial](https://developer.apple.com/documentation/virtualization/running_macos_and_linux_virtual_machines)
  establish the native host API to validate in Slice 01.
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
  defines protected-resource metadata, OAuth discovery, PKCE, and dynamic client
  registration expectations for HTTP MCP servers.
- [MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
  defines Streamable HTTP, POST/GET behavior, Origin validation, and the single
  MCP endpoint contract.
- [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) defines protected-resource
  metadata used to discover the authorization server; [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)
  defines authorization-server metadata. These are protocol inputs for Slice 07,
  not proof that every MCP client supports VM resource selection.
- Duet’s accepted desktop invariants are in
  [`specs/done/vm-desktop/README.md`](../../../duet/specs/done/vm-desktop/README.md);
  its security boundary and OAuth audience reasoning are in
  [`SECURITY.md`](../../../duet/SECURITY.md).
- Screen-recorder’s one-catalog adapter rule and checksum-verified agent setup
  are in [`AGENTS.md`](../../../screen-recorder/AGENTS.md) and
  [`README.md`](../../../screen-recorder/README.md).

## Global TODO

- [x] Run Slice 00 contract harness.
- [ ] Measure Apple VM viability in Slice 01.
- [ ] Freeze the guest channel and image manifest in Slice 02.
- [ ] Prove desktop/browser behavior and resource costs in Slice 03.
- [ ] Measure network/egress caveats in Slice 04.
- [ ] Complete local and remote CLI parity in Slices 05 and 08.
- [ ] Complete relay, OAuth, and MCP fault tests in Slices 06–09.
- [ ] Prove recovery, persistence, and VM selection in Slices 10–11.
- [ ] Package the Mac app and consumer skill in Slices 12–13.
- [ ] Run final review/security/visual gates in Slice 14.

## Next pickup instructions

Implement one slice per pass, keep earlier contract tests green, and update this
README’s status, TODOs, and Next Agent Prompt before ending the pass. Add every
new judgment to `choices.md`; if a slice begins deciding two unrelated things,
stop and reslice it instead of broadening the patch.
