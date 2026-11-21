# Sandbox images

Let people run sandboxes from their own images on the Macs they already own:
save any sandbox as an image, build a macOS base with no human step, copy
images directly between Macs, and start any sandbox from any image. Linux boots
through EFI with its kernel on its own disk, the guest agent becomes one binary
per OS that the host keeps current, and the positioning moves to "Stop renting
sandboxes. You already own them."

- Every decision this plan rests on: [unknowns map](map.md) (ledger Q1–Q12,
  L1–L6, sharp edges E1–E14, the six confirm-before-coding items). They are
  givens. This plan adds the decisions in [Plan decisions](#plan-decisions).
- **No backward compatibility, no migrations.** Localbox is unlaunched. Formats
  change outright; existing sandboxes, records and releases get no compat path.
- Out of scope: agent-builder positioning and per-app OAuth scopes, Dockerfile or
  arbitrary-Docker-image sources, a paid copy relay, snapshots
  ([placeholder](../sandbox-snapshots/README.md)), shared folders
  ([placeholder](../shared-folders/README.md)).

## Next Agent Prompt

*Status 2026-11-21: spikes 15, 16, 17, 19 passed (go); 18's grants work and its
rerun records P6's fallback. Built and merged: 21, 22, 23, 24, 26, 27, 30, 31,
32, 36. In flight on branches: 20 → 37, 25, 28, 29. Slice numbers start at 15
because `scripts/proof/run.ts` keys probes on a two-digit prefix.*

You are picking up the sandbox-images plan. Where things stand:

- **Decisions the spikes settled:** L1 (EFI boot) holds, so no slice takes the
  `linuxDirect` fork. L2 and Q3 hold: provisioning options plus one scripted
  Recovery screen disable SIP with no human (spike 17). Recovery's `halt` leaves
  the VM on, so builds stop it after csrutil. The darwin forwarder works (19).
- **Next pickup, in priority order:**
  1. Integrate the in-flight branches as they land (merge, rerun gates, re-verify
     any real-VM probe whose code moved).
  2. **33 darwin agent** once 18 is recorded (P4, P6), then **34 macOS base
     build** and **35 macOS sandboxes** (tier `m`).
  3. **38 image copy** after 37, then **39 create with copy** (needs 29, 36, 38).
  4. **40 docs** last.
- **Warnings:**
  - Tier `l` daemons can fail with "socket path is too long" under a long
    worktree path; run those probes from a short `git worktree add /tmp/<x>`.
  - The private VNC server listens on every interface; `RecoveryVNC` always uses
    a one-time VNC password.

Keep green on every pass: `npm run build`, `npm test`,
`swift test --package-path apps/macos/HostDaemon`, `npm run generate:snapshots`
with no diff, and the probes of every slice already done at the tiers it names.

Before ending any pass, update this section: status line, the next pickup point,
any blocker, and tick the TODO list.

**TODO**

- [x] [15 EFI Linux boot and save/restore spike](slices/15-efi-spike.md)
- [x] [16 macOS install, clone identity and suspend spike](slices/16-macos-install-spike.md)
- [x] [17 macOS provisioning, bootstrap and SIP spike](slices/17-macos-provision-spike.md)
- [ ] [18 macOS TCC and desktop helper spike](slices/18-macos-tcc-spike.md)
- [x] [19 darwin vsock forwarder spike](slices/19-darwin-vsock-spike.md)
- [x] [20 hole-punch and transfer spike](slices/20-punch-spike.md) (tier x waits on the user's second Mac)
- [x] [21 catalog routing and image operations](slices/21-catalog-routing.md)
- [x] [22 Convex image records](slices/22-convex-images.md)
- [x] [23 VM spec and boot store](slices/23-vmspec-bootstore.md)
- [x] [24 image store on the Mac](slices/24-image-store.md)
- [x] [25 the built-in linux image ships as an image](slices/25-linux-image-bundle.md)
- [x] [26 durable host operations](slices/26-host-operations.md)
- [x] [27 control lane and freeze lifecycle](slices/27-control-lane-freeze.md)
- [ ] [28 image create --from](slices/28-image-capture.md)
- [ ] [29 sandbox create --image (image already here)](slices/29-create-from-image.md)
- [x] [30 image catalog commands](slices/30-image-catalog-commands.md)
- [x] [31 single-binary guest agent](slices/31-agent-binary.md)
- [x] [32 guest agent self-update](slices/32-agent-self-update.md)
- [ ] [33 darwin guest agent](slices/33-darwin-agent.md)
- [ ] [34 macOS base build](slices/34-macos-base-build.md)
- [ ] [35 macOS sandboxes](slices/35-macos-sandboxes.md)
- [x] [36 placement with images](slices/36-placement-images.md)
- [ ] [37 transfer library](slices/37-transfer-library.md)
- [ ] [38 image copy](slices/38-image-copy.md)
- [ ] [39 create with copy](slices/39-create-with-copy.md)
- [ ] [40 positioning, docs and security](slices/40-docs-positioning.md)
- [ ] Two-Mac different-network run (user; extends the [two-Mac runbook](../durable-sandboxes/two-mac-runbook.md))

## Slice graph

```text
spikes
15 efi ─────────────────────────────────────────────── 23 (fork lands in 23, 25, 28)
16 macos-install ─ 17 provision+sip ─┬─ 18 tcc
                                      └─ 19 darwin-vsock
20 punch ──────────────────────────────────────────── 37

build
21 catalog-routing ─ 22 convex-images ─┬─ 30 catalog-commands
                                        └─ 36 placement-images
23 vmspec-bootstore ─ 24 image-store ─ 25 linux-image-bundle
26 host-operations ──┐
27 control-lane ─────┤
22 + 24 + 26 + 27 ── 28 image-capture
21 + 22 + 24 ─────── 29 create-from-image ─ (30 uses 29's resolution)
31 agent-binary ─ 32 agent-self-update (needs 27)
31 + 18 + 19 ─────── 33 darwin-agent
17 + 18 + 24 + 26 + 33 ─ 34 macos-base-build ─ 35 macos-sandboxes (needs 23, 27)
37 transfer-library + 22 + 26 ─ 38 image-copy
36 + 38 + 29 ─────── 39 create-with-copy
everything ───────── 40 docs-positioning
```

Lanes:

- **V-linux** (tier `v`): 15, then the real parts of 23, 25, 28, 32.
- **V-mac** (tier `m`, macOS 27 host, long): 16–19, 34, 35.
- **L** (no VM): 21, 22, 26, 30, 31, 36, 37, 38 (loopback), 39.
- **X** (user's second Mac): the cross-network part of 20 and 38.

## Review map

| Slice | Human/agent sees | Verdict |
| --- | --- | --- |
| 15 | `evidence/15-efi.json` | EFI boots, PID survives restore, apt kernel upgrade takes effect |
| 16 | `evidence/16-macos-install.json` | two clones run with distinct identifiers, save/restore works, third VM refused |
| 17 | desktop screenshot, `csrutil status` | auto-login desktop, no Setup Assistant, SIP disabled, no human step |
| 18 | probe screenshot taken by the helper, a click read back | grants work and survive a binary replace |
| 19 | 10,000 frames, reconnect log | no dropped bytes, reconnect does not kill the listener |
| 20 | transfer report | resume works, sha256 matches, LAN ≥ 70% of `iperf3`; tier x punch |
| 21 | `localbox help image.create`, routing table test | every op has explicit routing |
| 22 | convex-test cases | `linux` rules, default reset, machine removal drops holders |
| 23 | `VMSpecTests`, `vmlab boot` on EFI | one translator, no Linux command line |
| 24 | `ImageStoreTests` | crash mid-commit swept, thin clones |
| 25 | fresh install from a local release | kernel gone from the app, `images/linux` exists, probe 10 green |
| 26 | kill the daemon mid-operation | resumes, replay returns the same record |
| 27 | freeze during an in-flight request | answers, guest self-thaws, idle sleep skips it |
| 28 | `image create --from` output | stall < 2 s, file written before capture is in the new sandbox |
| 29 | `sandbox create --image` | identity regenerated, default image used with no flag |
| 30 | `image list` output | matches the map's output standard |
| 31 | agent binary under the fixture | no Node needed in the image |
| 32 | push during a running job | sandbox never stops, version updated |
| 33 | desktop/browser handlers on darwin | command mapping tests |
| 34 | `image create --macos`, `image wait` phases | no human step, Chrome present, no Xcode |
| 35 | macOS sandbox: screenshot, browser, shell | every operation works; third Mac VM handled |
| 36 | placement table cases | holders first, copy plan only when none fits |
| 37 | loopback transfer with injected loss | resume and AEAD hold |
| 38 | `image copy --to` between two fixture daemons | size, duration and path reported |
| 39 | `sandbox create --image X --machine Y` | returns `copying`, then works |
| 40 | README, site, skill, SECURITY.md | every named command passes `--help`; screenshot-critique on the site |

## Proof tiers

Every slice is judged by `npm run proof -- <NN> [--tier …]`: one JSON verdict,
exit 0 pass, 1 fail, 2 blocked (names the missing input). Tiers `u`, `s`, `l`,
`v`, `x` are unchanged from the
[durable-sandboxes plan](../durable-sandboxes/README.md#proof-tiers). Slice 16
adds:

| Tier | What runs | Budget |
| --- | --- | --- |
| m | real macOS guests on a macOS 27 host; IPSW and installed base cached under `LOCALBOX_VMLAB_DIR` | < 10 min cached; the first uncached build may take 45 min |

A probe that needs a cached macOS base it doesn't have exits 2
(`blocked: no cached macOS base; run npm run proof -- 16 --tier m`). A fixture is
never evidence for a real-VM claim.

## Plan decisions

Decided while slicing, by the agent, under the user's "your call on all these"
for stage 4 and the map's inferred preferences. Each lands in its owning slice.
Correct any row and the slices that cite it change.

| # | Decision | Why | Slice |
| --- | --- | --- | --- |
| P1 | The built-in `linux` image is not a Convex row. `images:list` synthesizes it with every live machine as a holder. It is never copied; each Mac uses the build its release shipped. | `linux` is on every Mac by definition; holder rows for it would only drift. | 22, 25 |
| P2 | Saving an image from a sleeping sandbox wakes it through admission first, then freezes. A stopped sandbox is cloned without a freeze. | A sleeping sandbox's unwritten data is in its save file, not on disk. | 28 |
| P3 | The macOS base build gets its agent in over SSH: the provisioning options enable Remote Login with a random per-build password; the build connects to the guest's NAT address, installs the agent, the vsock forwarder and Chrome, then turns Remote Login off and discards the password before saving. | No vsock agent exists yet at that point, and SSH is the one channel the public provisioning API offers. | 17, 34 |
| P4 | The darwin agent is one binary in two roles: a root LaunchDaemon (shell, files, jobs, control lane) and a LaunchAgent in the auto-login user's session (`--desktop`) for desktop and browser operations. They talk over a local Unix socket owned by root. | ScreenCaptureKit and CGEvent posting need a process in the GUI session; shell and files run as root like Linux. | 18, 33 |
| P5 | An agent update waits while any job is running (`guest.activity` running_jobs > 0) and is retried on the next connect or idle tick. | The job table lives in the agent's memory; job processes would survive, their tracking would not. Deferring is simpler than persisting the table. | 32 |
| P6 | TCC rows name the agent binary by its install path. If spike 18 shows a replaced binary loses its grants, the agent rewrites its own rows as root after every swap (SIP is off). | Release signing is a self-signed identity, so a stable designated requirement isn't guaranteed. | 18, 32 |
| P7 | A sandbox created with no placement flag (the caller's own Mac) copies the image there when missing, exactly like a named `--machine`. | The local default is an implicit named machine; Q6 says a named machine always gets a copy. | 36, 39 |
| P8 | New proof tier `m` for macOS guests, with the IPSW and installed base cached. | A macOS install breaks tier v's 6-minute budget. | 16 |
| P9 | Node can't open `AF_VSOCK`, so darwin gets a tiny native Swift forwarder (`localbox-vsock`) mirroring socat on Linux: vsock ports to Unix sockets, one process per OS, the agent outliving connections. | Keeps the existing two-unit shape ([guest agent README](../../apps/guest-agent/README.md)); the agent stays one portable program. | 19, 33 |
| P10 | A control lane on vsock port 1025 carries only `freeze`, `thaw` and `agent.update`. Port 1024 stays the request lane. | The request lane serializes with no timeout and journals mutations to disk (E2); a separate port bypasses both by construction. | 27, 32 |
| P11 | Map item 3 is split: 16 installs and proves identity and suspend; 17 proves provisioning, bootstrap and `csrutil`. Provisioning failure reopens L2 (agent); a `csrutil` failure reopens Q3 (user). | Two risks with different owners and different fallbacks. | 16, 17 |
| P12 | The macOS base downloads Chrome from Google's official installer during the build. | Localbox redistributes nothing macOS-side; same reasoning as the IPSW. | 34 |
| P13 | Spike 20's punch failing alone is acceptable (Q5 already says the copy fails with why). Resume or throughput failing reopens the transport choice, not Q4. | Separates "some networks can't connect" from "the transfer is broken". | 20 |

**Correction to the map:** confirm-before-coding item 3 says "from a signed,
notarized daemon". Releases are signed with a self-signed Localbox identity and
are not notarized (`SECURITY.md:160-161`). Private API use needs no
notarization; spike 17 proves `_VZVNCServer` from a release-signed build.

## Alternatives the drafts raised

Four blind drafts (fewest-slices, risk-first, seam-quality, proof-harness; two
models) shaped this ladder. Calls taken against a draft:

- **12 slices instead of 26** (fewest-slices): its build slices each spanned three
  or more owners (store, journal, freeze lane and Convex in one), so a failure
  couldn't be pinned to one seam. Its spike split of map item 3 was kept (P11).
- **Durable operations after image save and macOS build** (risk-first): save and
  build are themselves long operations, so the journal comes first (26).
- **A new harness slice 00** (proof-harness): the harness exists
  (`scripts/proof/run.ts`); only tier `m` is new, added in 16.
- **Simulated hole punching on one Mac** (proof-harness): NAT can't be faked
  meaningfully without network tooling; loopback proves the transfer, tier `x`
  proves the punch.
- **Freeze/thaw as frames on the request lane** (fewest-slices): rejected for a
  separate port (P10).
- **Persist the guest job table across agent swaps** (seam-quality): rejected for
  deferring the swap (P5).

## Single-owner invariants (end state)

The end state must read as designed today, not bolted onto one template per Mac.

| Concept | Owner | Never owned by |
| --- | --- | --- |
| Image record, holders, account default | Convex `images.ts` | daemon (reports holdings), CLI |
| Image files on a Mac (disk, boot store, manifest) | Swift `ImageStore` | `SandboxHost`, `SandboxRecord` |
| Boot store (EFI variable store; macOS auxiliary storage plus hardware model) | Swift `BootStore`, inside `VMSpec` | release scripts after install |
| VM configuration | `VMSpec` → one translator to `VZVirtualMachineConfiguration` | anything else (`SandboxArtifacts` and the launchd template variables are deleted) |
| Long host work (build, copy, capture, create-with-copy) | Swift `HostOperationStore` (journal, resumers); Convex `imageHolders.state` is a projection the connector reports | `SandboxHost` actor, relay memory |
| Transfer bytes, AEAD, resume | SwiftPM target `ImageTransfer` (no `HostDaemonCore` import) | connector, Convex |
| Copy rendezvous | Convex `copies` | Vercel, the daemon directly |
| Op routing and executor | explicit per-op table in `packages/contract` | prefix defaults |
| Placement, including image holders and OS compatibility | `packages/placement` `place()` (pure) | relay ad hoc, daemon |
| Guest control lane (freeze, thaw, agent update) | `packages/guest-gateway` control module and its Swift twin | request lane, mutation journal |
| Guest agent binaries and version | `apps/guest-agent` build | images (they carry a copy, the host's is authoritative) |
| vsock-to-socket forwarding in the guest | socat (Linux), `localbox-vsock` (darwin) | the agent process |
| Private Apple API | `RecoveryVNC.swift` only | everything else |
| Convex speaker on a Mac | `apps/connector` | daemon, CLI |

## Firewalls

- Spikes 15–20 touch only `localbox-vmlab`, `localbox-punchlab`, `localbox-vsock`,
  `RecoveryVNC.swift`, spike build flags in `packages/vm-image`, `scripts/proof/run.ts`
  (tier `m`) and probe files. The rest of `HostDaemonCore`, the contract and Convex
  change from 21 on.
- `ImageTransfer` never imports `HostDaemonCore`; `place()` stays I/O-free;
  `SandboxHost` never does image file I/O.
- One short-lived seam, named: slice 23 feeds `VMSpec` from today's
  `SandboxArtifacts` through `BootStore.linuxDirect` so the daemon keeps booting;
  slice 24 deletes `SandboxArtifacts`, the `VZLinuxBootLoader` path and
  `linuxDirect` (which stays only if 15 failed and the user accepted the fallback).
  Slice 25 deletes the three launchd template variables. No other dual path.
- No slice edits README, site, `llms.txt`, the skill, SECURITY.md or
  positioning.md before 40.

## Visual gate

Slice 40 rewrites the site. Its slice file requires
[screenshot-critique](../../.agents/skills/screenshot-critique/SKILL.md) as the
last check on every site shot, and
[compare-screenshots](../../.agents/skills/compare-screenshots/SKILL.md) against
the current site captures it replaces.
