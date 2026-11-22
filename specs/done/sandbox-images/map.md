# Sandbox images: unknowns map

The completed explore-unknowns walk (2026-11-21) for repositioning Localbox
around "sandboxes on the computers you already own" and letting people make
their own sandbox images: Linux or macOS, saved from a sandbox, copied between
their Macs. It is the input to the spec in this folder; decisions here are
givens the spec carries verbatim.

Scope: the `image` command group, macOS guest sandboxes, direct Mac-to-Mac
image copy, guest-agent self-update, per-image boot, and the positioning,
README, site, `llms.txt`, skill and SECURITY.md rewrite once the CLI ships.
Out of scope: agent-builder positioning and per-app OAuth scopes (descoped),
building images from Dockerfiles or arbitrary Docker images, a paid copy relay.

**No backward compatibility.** Localbox is unlaunched with no users. No data
migrations, record schema versions, compat paths for existing sandboxes, or
rollback handling; change formats outright.

## 1. Known knowns (settled ground)

- One template per Mac, from `LOCALBOX_KERNEL`, `LOCALBOX_INITRD` and
  `LOCALBOX_TEMPLATE_DISK` in the launchd plist (`scripts/install-release.sh:167-169`,
  read once in `apps/macos/HostDaemon/Sources/localbox-hostd/main.swift:55-56`).
  Every sandbox disk is an APFS clone of it (`AppleVirtualizationBackend.swift:27`,
  `SandboxRecord.swift:109`).
- No image field anywhere on the request path: `sandbox.create` takes `name`,
  `placement`, `cpus`, `memory_bytes`, `sleep_after_ms`, `delete_after_ms` with
  `additionalProperties: false` (`packages/contract/src/index.ts:79`); nor the
  relay (`apps/relay/src/ops.ts:174-216`), Convex `sandboxes`
  (`packages/state/convex/schema.ts:15`) or `SandboxRecord`.
- The default image is Docker → `docker export` → `mke2fs -d` into an 8G ext4
  `template.img`, with kernel and initrd copied from `/boot`
  (`packages/vm-image/scripts/build-boot-artifacts.ts:74-124`); released as signed
  zstd parts (`scripts/release.sh:227`, `scripts/release.ts:15,86`).
- Linux-only boot: `VZLinuxBootLoader`, `console=hvc0 root=/dev/vda rw`,
  `VZGenericPlatformConfiguration`, in the one configuration builder, which calls
  `validateSaveRestoreSupport()` (`AppleVirtualizationBackend.swift:41-74`).
- Guest contract: systemd, Node 24 running `/opt/localbox/dist/...`, socat from
  vsock 1024 to the agent socket, DHCP on `en*`; full profile adds Xvnc, XFCE and
  Chrome with CDP (`packages/vm-image/Dockerfile.arm64:125-140`). The host reads only
  `channel_epoch` from the guest's ready frame (`FramedGuestChannel.swift:72`).
- The guest agent does shell, jobs, files, browser, desktop, identity and clock,
  and idle reporting (`packages/guest-gateway/src/index.ts:199`). It regenerates
  machine-id and SSH host keys the first time a disk serves a new sandbox id
  (`apps/guest-agent/src/identity.ts:18`), so sandboxes cloned from a saved disk
  already get distinct identities.
- Placement sees memory only (`packages/placement/src/index.ts:5-12,45-79`).
- `localbox-hostd` is a LaunchAgent in the user's GUI session (`gui/$UID`,
  `install-release.sh:211`).
- No peer-to-peer networking exists (no WebRTC, STUN, Bonjour, `NWListener` or
  QUIC anywhere).
- OAuth has one scope, `account` (`apps/relay/src/repository-oauth.ts:22`), and an
  unused `constraints: v.null()` on tokens (`schema.ts:24`). Unchanged by this work.
- Test host: macOS 27.0.1.

## 2. Known unknowns (decision ledger)

Closed by **U** (user), **T** (territory) or **A** (agent on the user's behalf,
under the delegation below).

| # | Decision | By |
| --- | --- | --- |
| Q1 | An image is made from an existing sandbox: `image create --from SANDBOX`. No Dockerfile or arbitrary-Docker-image path. | U |
| Q2 | macOS sandboxes ship in the first release, alongside Linux. | U |
| Q3 | The macOS base is built on a Mac from Apple's IPSW, fully automated with no human step, and every macOS image runs with SIP disabled in the guest. Nothing macOS is redistributed. | U |
| Q4 | Images copy directly Mac to Mac in the first release; never through cloud storage. | U |
| Q5 | Copies are direct only: local network first, then UDP hole punching. If both fail, the copy fails with why and what to try. No paid relay, no Tailscale fallback. | U |
| Q6 | Copying is automatic. Auto placement first picks among Macs holding the image with room; only if none fits does it pick another Mac and copy first. A named `--machine` without the image is always copied to. Results report the copy (size, duration, path taken). | U |
| Q7 | An image is the disk (plus boot store) only, never memory; sandboxes from it cold boot. | T |
| Q8 | Saving an image: the guest agent syncs and freezes the filesystem, the host pauses the VM, APFS-clones the disk, resumes, and the guest thaws. About a 1 s stall, reported in the result. | U |
| Q9 | `sandbox create --image NAME`. No flag uses the account default, initially the built-in `linux`; `image default NAME` changes it. `linux` is on every Mac and updated each release. `macos` is reserved for the account's macOS base; if none exists the error names `image create --macos`. | U |
| Q10 | Commands: `image create --from SANDBOX [--name]`, `image create --macos [--name]`, `image list`, `image rename`, `image copy NAME --to MACHINE`, `image default NAME`, `image delete NAME --confirm NAME [--machine M]`. Generated names when `--name` is omitted. Deleting an image never affects sandboxes made from it; `linux` can't be renamed or deleted; deleting the default resets it to `linux` and says so. | U |
| Q11 | The host pushes the current guest agent to any guest that connects with an older version; the agent swaps itself and restarts without the sandbox stopping. | U |
| Q12 | A macOS sandbox supports every operation, including `browser.*`; Chrome is preinstalled in the macOS base. | U |
| L1 | Linux boots with `VZEFIBootLoader`; the kernel lives on the disk like a normal computer, and apt kernel upgrades work. An image is a disk plus a boot store (EFI variable store for Linux, auxiliary storage plus hardware model for macOS), so images look the same for both OSes and a copy is just files. Kernel and initrd leave the app bundle. Gated on the first confirm-first item. | A |
| L2 | macOS sandboxes require macOS 27 on the host and in the guest. Setup Assistant is skipped with the public `VZMacGuestProvisioningOptions` (user, password, auto-login). The only private API is `_VZVNCServer` keystrokes for the one Recovery screen that runs `csrutil disable`. Linux sandboxes keep the macOS 14 minimum. | A |
| L3 | Long work (macOS build, copy, image save, create-with-copy) is a durable host operation keyed by mutation id and resumable after a daemon or connector restart. Calls return at once with a state (`building`, `copying`, `ready`, `failed`, with progress). `image wait NAME [--timeout]` mirrors `job wait`: at most 120 s per call, call again. Sandbox operations on a sandbox whose image is still copying return `sandbox_not_ready` with the progress. | A |
| L4 | The guest agent becomes one self-contained binary per OS (linux-arm64, darwin-arm64), so images don't depend on Node. Pushed in chunks on version mismatch through a reconnect path that isn't treated as the guest dying. The ready frame carries the agent version. | A |
| L5 | The macOS base ships without Xcode (it needs an Apple ID and can't be redistributed). The skill tells the agent to install Xcode in a macOS sandbox, with the user's Apple ID or a `.xip` the user shares, then save it as an image. | A |
| L6 | Hole punching discovers each Mac's public address and port with Cloudflare's public STUN server. STUN only reflects addresses; no image bytes go through it. Vercel can't host a UDP server. | A |

### Delegation

- Stages 1–3: the user declined the preference checkpoint and answered every
  question themselves.
- Stage 4: the user said "your call on all these" and "feel free to change
  whatever answer" for the landmine decisions (L1–L5). The agent also closed L6,
  a new finding in the same area, under that delegation. Correct any **A** row
  and it reopens.
- Inferred preferences behind the **A** answers: full scope in the first release;
  no human steps (the agent does everything alone); no recurring cost, and no
  third party touches data; convenience over hardening inside the guest; reuse
  what exists; no backward compatibility.

| # | Why the agent chose it |
| --- | --- |
| L1 | Without compat, nothing forces the per-image kernel pinning (the old option A). EFI makes images uniform with macOS, copies trivial, and kernel upgrades a normal `apt` step. |
| L2 | The public provisioning API removes the most fragile automation (per-version Setup Assistant scripts). It keeps the no-human-step promise, with private API used for one scripted screen. |
| L3 | Reuses the `job wait` shape agents already know, without adding an operations concept; bounded polling stays well under 500 requests a day (a 60-minute build is about 30 calls). |
| L4 | One mechanism for both OSes; no frozen Node version holding the agent back. |
| L5 | The only option with no Apple ID handling in Localbox, and it matches Q1 (images come from sandboxes). |
| L6 | Address discovery needs a UDP server that echoes the observed address; using a public one beats running infrastructure, and no data goes through it. |

## 3. Unknown knowns (what was extracted)

- **Headline:** "Stop renting sandboxes. You already own them." This reverses two
  rules in `positioning.md`: the cloud-sandbox comparison now opens the pitch
  rather than supporting it, and reach (all your Macs) plus the SSH comparison
  move below it. `positioning.md` is rewritten to match.
- **Subhead:** "Localbox turns every Mac you own into sandboxes for your agents:
  Linux or macOS, set up your way, and still there next week. Free."
- **Audience:** unchanged, individual developers running coding agents.
  Agent builders (products using people's Macs as their sandbox backend) were
  raised and then descoped: no builder positioning, no per-app access.
- **macOS sandboxes are for** building and testing iOS and Mac apps in Xcode, and
  using Mac apps through the desktop. This makes the macOS desktop operations
  core, not optional.
- **Output standard:** every line of the sample `image create`,
  `sandbox create --image` and `image list` output was kept: what was saved, the
  freeze duration, where the image lives, the next command, copy size, duration
  and path, identity regeneration, and per-image OS, size, source, holders and
  default marker. Every `image` command reports at that level.
- **Shipped means:** the CLI and skill first, then the README, site and
  `llms.txt` rewritten together.
- **"Any image"** means any setup saved from a sandbox, Linux or macOS. It does not
  mean arbitrary Docker or ISO images.

## 4. Unknown unknowns (landmines)

Sweep: the host daemon (VM backend, records, runtime, host, guest channel, IPC,
entry point), contract, client, relay ops, Convex schema/relay/sandboxes/
machines/accounts, connector, placement, CLI, guest gateway and agent, image
Dockerfile, release and install scripts, SECURITY.md, positioning.md, the skill
and contract tests; plus primary Apple sources (API docs, WWDC23 10007, WWDC26
224, macOS 27 and Xcode licences) and the Tart and cirruslabs template sources.

**Decided** (see L1–L6 above):

- **Kernel and modules drift (a bug in the product as it ships today).** The
  kernel and initrd come from the current release while `/lib/modules` lives on
  each disk, and `linux-image-generic` is unpinned (`Dockerfile.arm64:34`). A
  release with a new kernel leaves older disks without a matching vsock module,
  so the guest never answers (120 s timeout, `AppleVirtualizationBackend.swift:194`).
  → L1.
- **macOS automation.** Setup Assistant is skippable with public API only on
  macOS 27 host and guest; `csrutil disable` asks for confirmation plus username
  and password in Recovery on every version. → L2.
- **Request ceilings.** `deadline_ms` max 120 s (`contract/src/index.ts:71`), 50 s
  per HTTP call (`ops.ts:303`); a replay returns a stored timeout forever
  (`packages/state/convex/relay.ts:39-43`); a connector restart re-runs claimed work
  (`relay.ts:55-67`). → L3.
- **Agent runtime.** Old images run old Node; macOS has none; an agent restart
  today counts as the guest dying and stops the VM (`SandboxRuntime.swift:164-170`).
  → L4.
- **Xcode.** Needs an Apple ID (xcodes); Xcode licence §2.7 forbids
  redistribution. → L5.

**Sharp edges** (givens the builder follows):

- E1. Freeze-clone gets its own lifecycle state and a per-sandbox operation lock.
  Today `.paused` means asleep: any request wakes it (`SandboxHost.swift:360`),
  admission can save it (`SandboxHost.swift:561`), shutdown resumes and saves it
  (`SandboxRuntime.swift:213`).
- E2. Thaw bypasses the mutation journal and isn't queued behind a guest request;
  both would write to the frozen disk (`guest-gateway/src/index.ts:85`;
  `FramedGuestChannel.swift:31` serializes requests with no timeout). The guest
  thaws itself after a timeout. macOS has no fsfreeze: `sync` only.
- E3. Free disk space is reported in capacity, and image create, copy and macOS
  build refuse before starting when it won't fit. Nothing checks disk today
  (`SandboxHost.swift:528`).
- E4. Copy, clone and build work runs off the `SandboxHost` actor, writes to a temp
  name, renames on completion and is swept at startup. Today provision blocks the
  actor (`SandboxHost.swift:502`).
- E5. `image.*` is classified explicitly: account-scoped in the relay, not a
  sandbox-scoped guest op (catalog defaults, `contract/src/index.ts:134-139`), and
  `image list` shows the whole account, not the local Mac
  (`apps/cli/src/index.ts:169,180`). `--machine` is a CLI control flag
  (`apps/cli/src/index.ts:27`); `image delete --machine` must use it as routing on
  purpose.
- E6. Images are Convex rows (image → holder machines) plus an account default
  field. Machine removal drops its holder rows (`machines.ts:22-36`). New tables join
  `relayStateSchema` (`schema.ts:36-41`). Machine names aren't unique; `--to`
  resolves like `--machine` (`placement/src/index.ts:33`).
- E7. Placement takes image holdings from Convex rows, not the capacity blob, and
  filters macOS images to Macs whose macOS is at least the guest's.
- E8. Direct copy rewrites SECURITY.md ("The Mac opens no inbound port",
  `SECURITY.md:125-127`). Rendezvous is a Convex row carrying a one-time per-copy
  key; the transport is encrypted and authenticated with it.
- E9. macOS sandboxes use their own suspendable device set (no entropy or audio
  device; `VZMacKeyboard` and `VZMacTrackpad`, per Tart's `--suspendable`).
  Sleep files are hardware-encrypted per Mac, so they never travel. The
  vsock-accept wait exceeds 120 s on a macOS first boot.
- E10. Each macOS sandbox gets a new `VZMacMachineIdentifier` and a copy of the
  image's auxiliary storage; Apple calls duplicate identifiers running at once
  undefined behavior.
- E11. Admission counts running macOS VMs, at most 2 per Mac
  (`VZError.virtualMachineLimitExceeded`). A third gets sleep-for-room or
  `machine_full` with the reason, never a raw Virtualization error.
- E12. Apple's licence allows macOS VMs for software development, testing and
  personal non-commercial use, and forbids service-bureau use. Marketing never
  implies offering macOS sandboxes to other people.
- E13. Contract lockstep: bump the catalog count (`tests/contract.test.ts:15`), run
  `npm run generate:snapshots`, add sample inputs for parity tests, add
  `--confirm` checks in the relay (`ops.ts:269`). The skill, README, SECURITY.md
  and positioning.md change only once the CLI ships (`skill-commands.test.ts`
  runs `--help` on every command they name).
- E14. IPSWs are 17–26 GB; a macOS VM uses about 22–35 GB of a 50 GB disk; a build
  takes about 20 minutes plus download (third-party report, unmeasured).

**Correction on the record:** the L3 card said an "existing `--wait` style". No CLI
`--wait` flag exists; the existing pattern is the client's `{continue}` long-poll
(`packages/client/src/index.ts:76`) and `job wait` (`contract/src/index.ts:94`).
L3 is written against those.

## Confirm before coding

> Superseded by the plan: each item is now a spike with a pass/fail gate and a
> written fallback, build steps 15–20 in the [README](README.md#where-to-look). Item 3
> was split into steps 16 and 17 (plan decision P11), and its "signed, notarized
> daemon" premise is corrected in the [README](README.md#plan-decisions): releases are self-signed and not notarized
> (`SECURITY.md:160-161`).

1. A Linux guest under `VZEFIBootLoader` plus `VZGenericPlatformConfiguration`
   passes `validateSaveRestoreSupport()` and hibernates and restores. If not,
   L1 reverts to per-image kernel and initrd travelling with the image, and the
   user is told.
2. A macOS guest with a new `VZMacMachineIdentifier` and copied auxiliary storage
   boots, and the suspendable device set saves and restores.
3. `VZMacGuestProvisioningOptions` gets a 27 guest to an auto-logged-in desktop
   with no Setup Assistant, and Recovery `csrutil disable` can be driven through
   `_VZVNCServer` from a signed, notarized daemon.
4. With SIP off, writing the system and user TCC databases grants Screen
   Recording, Accessibility and PostEvent to the darwin agent binary (macOS 27
   moved the user TCC database; see cirruslabs' `update-tcc-database.sh`).
5. A darwin guest process can listen on `AF_VSOCK` and the host reaches it with
   `VZVirtioSocketDevice.connect(toPort:)` (Tart's agent does; check for its
   dropped-output bug on 27).
6. Hole punching between two Macs on different networks via Network.framework
   UDP, and that a chunked, resumable transfer reaches local-network speed.

## Open

None.
