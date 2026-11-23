# Sandbox images

Localbox runs sandboxes from the user's own images on the Macs they already
own. Any sandbox can be saved as an image (`image create --from`); a Mac on
macOS 27 builds a macOS base from Apple's IPSW with no human step
(`image create --macos`); images copy directly between the user's Macs; and any
sandbox starts from any image (`sandbox create --image`, or the account default,
initially the built-in `linux`). Linux guests boot EFI firmware with the kernel
on their own disk. The guest agent is one binary per OS that the host keeps
current. The product's headline is "Stop renting sandboxes. You already own
them."

- The decisions this rests on: the [unknowns map](map.md) (the user's Q1–Q12,
  the agent's L1–L6, sharp edges E1–E14) and the [plan decisions](#plan-decisions)
  below (P1–P13).
- Every further choice the build made, and its verdict: the
  [choices ledger](choices.md). Its **Needs your call** entries (N2–N9; N1 is resolved) are
  live trade-offs the user owns, and its **Provisional** entries (V1–V6) are each
  waiting on something named.
- There is no backward compatibility: Localbox was unlaunched, so formats
  changed outright and nothing migrates.
- Out of scope: agent-builder positioning and per-app OAuth scopes, building
  images from Dockerfiles or arbitrary Docker images, a paid copy relay,
  snapshots ([placeholder](../../sandbox-snapshots/README.md)) and shared
  folders ([placeholder](../../shared-folders/README.md)).

Everything is built and proven at the tiers the work named. One verification
is still open: the [two-Mac run on different networks](#open-verification).

## Why it works this way

**Images come from sandboxes.** An image is made by setting up a sandbox and
saving it (Q1), not from a Dockerfile, a Docker image or an ISO. One path covers
Linux and macOS alike, needs no build language, and is how Xcode reaches a macOS
image at all: Xcode needs an Apple ID and can't be redistributed (L5), so the
agent installs it in a macOS sandbox with the user's Apple ID or a `.xip` they
share, then saves that sandbox. An image is the disk plus its boot store, never
memory (Q7), so every sandbox from it cold boots and gets a fresh identity.
Saving freezes a Linux guest's filesystem (a macOS guest only syncs) for well under a second and APFS-clones
the disk, so the source sandbox keeps running (Q8).

**An image is files, the same for both OSes.** Before this work every Mac had one
template, and the kernel and initrd shipped in the app while `/lib/modules`
lived on each disk. A release with a new kernel left older disks without a
matching vsock module, so their guests never answered. Linux now boots
`VZEFIBootLoader` from the sandbox's own EFI variable store, with GRUB and the
kernel on the disk like a normal computer (L1). That removes the drift,
makes an `apt` kernel upgrade work, and makes a Linux image the same shape as
a macOS one: `disk.img` plus a boot store (an EFI variable store, or auxiliary
storage plus a hardware model). A copy is then just files. GRUB reads a fixed
config that loads the `/boot/vmlinuz` and `/boot/initrd.img` symlinks, and
`update-grub` is disabled, so no kernel upgrade ever regenerates boot config.
The built-in `linux` image ships in every release and lives on every Mac
(P1), so it has no Convex row and is never copied.

**The macOS base is built on the user's Mac, with SIP off, with no human step.**
Localbox redistributes nothing macOS (Q3): the build downloads Apple's IPSW and
Google's signed Chrome installer (P12) on the Mac that runs it. The
no-human-step setup is a chain of public API plus one private screen:

1. `VZMacGuestProvisioningOptions` (macOS 27 host and guest, L2) creates the
   user, turns on auto-login and Remote Login, and skips Setup Assistant.
2. The build reaches the guest over SSH with a random password made for each
   provisioning run that lives only in the builder's memory (P3). It installs the agent, the vsock
   forwarder, the desktop helper and Chrome. No vsock agent exists yet at that
   point, and SSH is the one channel the public API offers.
3. It restarts into Recovery and types `csrutil disable` through
   Virtualization's private VNC server. `RecoveryVNC.swift` is the only file
   that touches private Apple API, so a macOS update that breaks it breaks one
   file.
4. The password is gone once SIP is off. Through the agent's root shell the build
   switches off notification banners, writes the agent's TCC rows (screen
   capture, accessibility, event posting) into the system and user databases,
   waits for macOS to record the screen-capture approval, then turns Remote Login
   off.

SIP off inside the guest is the price of an agent that can see and drive the
desktop without a person clicking a permission dialog. The guest is already one
trust domain under a root agent, and the VM is the boundary
([SECURITY.md](../../../SECURITY.md#macos-guests-run-with-sip-off)). Apple's
licence limits macOS VMs to development, testing and personal use, so the product
never implies offering macOS sandboxes to other people (E12). macOS allows two
running macOS VMs per Mac, and a build's VM counts against that limit too
(choice S59).

**Long work is a durable host operation.** A macOS build, a copy and a create that
waits on a copy outlast a request's 120 s ceiling (an image save can), and all must
survive a daemon or connector restart. Each is a journaled host operation keyed by
its mutation id (L3): a replay returns the same record, an unfinished one resumes
from its checkpoint (a capture retakes its clone; a macOS build interrupted in `bootstrap`
or `sip` (before SIP is off) restarts from `provision`), and callers poll with `image wait`, shaped like `job
wait` (at most 120 s per call). A pending state is an answer, not a timeout.

**Freeze runs on its own lane.** The request lane serializes requests with no
timeout and journals mutations to the guest's disk. A freeze queued behind a
request would stall, and a thaw that journaled would write to the disk it froze.
So `freeze`, `thaw` and `agent.update` travel on a separate control lane, vsock
port 1025 (P10), and the guest thaws itself if the host never does. macOS has no
`fsfreeze`, so a darwin freeze is `sync` only.

**The guest agent is one binary that the host pushes.** Old images ran whatever
Node they were built with, and macOS has no Node. The agent is compiled into one
self-contained executable per OS (L4), and the host app carries both. The host is
the authority on the version: a guest whose ready frame names another version
gets the host's binary over the control lane and swaps it in place, and the
sandbox never stops (Q11). An update waits while a job runs, because the job
table lives in the agent's memory (P5). On darwin the binary runs in two roles
(P4), because only a process in the GUI session can capture the screen and post
input. Node can't open `AF_VSOCK`, so darwin gets a small native forwarder
(`localbox-vsock`) that plays socat's part on Linux (P9).

**Copies go directly Mac to Mac, with STUN only for addresses.** Image bytes
never pass through cloud storage, Convex or Vercel (Q4), and there is no paid
relay or Tailscale fallback (Q5). A copy tries local-network candidates first,
then UDP hole punching. If both fail, it fails with every path tried and what to
do next. Each Mac learns its public address from Cloudflare's public STUN
server, because hole punching needs a UDP server that echoes the observed
address, and Vercel can't host one (L6). STUN sees addresses, never data. The
two Macs meet at a Convex `copies` row carrying a one-time key, and every
datagram is sealed with that key. Who else could read that key is a recorded
trade-off (choice N7).

**Placement prefers Macs that hold the image.** Automatic placement picks among
holders with room, and copies only when none fits (Q6). A named `--machine`, or
no flag at all (the caller's own Mac, P7), always gets a copy when it lacks the
image. A macOS image only lands on a Mac running at least its guest's major macOS release
(`min_macos`).

**The positioning changed because the product did.** Saved setups, macOS
sandboxes and durability are what rented cloud sandboxes lack: those are
disposable, set up from scratch each time, and Linux only. So the cloud-sandbox
comparison now opens the pitch, and reach across your Macs and the SSH
comparison follow it ([positioning](../../../positioning.md)). A sandbox is "a
whole computer, Linux or macOS". The audience stays individual developers, and
there is no agent-builder story.

## Plan decisions

Taken while planning, under the user's "your call on all these", and still in
force. The [choices ledger](choices.md) records where the code made a further
choice inside one of them.

| # | Decision | Why |
| --- | --- | --- |
| P1 | The built-in `linux` image is not a Convex row. `images:list` synthesizes it with every live machine as a holder. It is never copied; each Mac uses the build its release shipped. | `linux` is on every Mac by definition; holder rows for it would only drift. |
| P2 | Saving an image from a sleeping sandbox wakes it through admission first, then freezes. A stopped sandbox is cloned without a freeze. | A sleeping sandbox's unwritten data is in memory or its save file, not on disk. |
| P3 | The macOS build installs its agent over SSH, with Remote Login on and a random per-build password, then turns Remote Login off and discards the password before saving. | No vsock agent exists at that point, and SSH is the one channel the public provisioning API offers. |
| P4 | The darwin agent is one binary in two roles: a root LaunchDaemon (shell, files, jobs, control lane) and a LaunchAgent in the auto-login session (`--desktop`) for desktop and browser operations, linked by a root-owned local socket. | ScreenCaptureKit and CGEvent posting need a process in the GUI session. |
| P5 | An agent update waits while any job runs and is retried on the next connect or idle tick. | The job table lives in the agent's memory; deferring is simpler than persisting it. |
| P6 | TCC rows name the agent binary by its install path, and the agent rewrites them as root after every swap. | Releases are self-signed, so a stable designated requirement isn't guaranteed, and a replaced binary measurably loses its screen-capture grant. |
| P7 | A create with no placement flag (the caller's own Mac) copies the image there when missing, like a named `--machine`. | The local default is an implicit named machine. |
| P8 | Proof tier `m` runs real macOS guests, with the IPSW and installed base cached. | A macOS install breaks tier `v`'s budget. |
| P9 | darwin gets a native forwarder, `localbox-vsock`, mirroring socat on Linux. | Node can't open `AF_VSOCK`; the agent stays one portable program. |
| P10 | The control lane (vsock 1025) carries only `freeze`, `thaw` and `agent.update` (and its chunks); 1024 stays the request lane. | The request lane serializes with no timeout and journals mutations to disk (E2). |
| P11 | The macOS risk was proven in two parts: install, identity and suspend; then provisioning and `csrutil`. | The two risks had different owners and different fallbacks. |
| P12 | The macOS base downloads Chrome from Google's official installer during the build. | Localbox redistributes nothing macOS-side. |
| P13 | A failed hole punch alone is acceptable; failed resume or throughput would reopen the transport choice. | Separates "some networks can't connect" from "the transfer is broken". |

The map's confirm-before-coding item 3 said private API would run "from a
signed, notarized daemon". Releases are signed with a self-signed Localbox
identity and are not notarized
([SECURITY.md](../../../SECURITY.md#releases-and-updates)). Private API use needs
no notarization, and the VNC driver runs from a release-signed build.

## Principles and invariants

The single-owner rules are documented where the code lives, and this record
doesn't repeat them:

- [Host daemon README](../../../apps/macos/HostDaemon/README.md): `ImageStore` is
  the only code that touches image files, and it alone answers "how much disk is
  free". `HostOperationStore` is the only owner of long host work. Every VM is
  described by a pure `VMSpec`, with one translator to a Virtualization
  configuration. `SandboxHost` admission is the one owner of the two-macOS-VM
  count. `RecoveryVNC.swift` holds all private API. The control lane and
  `freezeAndClone` are covered there too. `ImageTransfer` never imports
  `HostDaemonCore`, and `ImageCopyTransfer` is the one adapter between them.
- [DEVELOPMENT.md, How a request reaches a sandbox](../../../DEVELOPMENT.md#how-a-request-reaches-a-sandbox):
  every operation routes through the contract's explicit table, with no default
  by name. `place()` is pure and holds every placement rule. The image record
  lives in Convex `images.ts`. The connector is the only process on a Mac that
  talks to Convex. [Images](../../../DEVELOPMENT.md#images) and
  [Proofs](../../../DEVELOPMENT.md#proofs) cover building images, tier `m`, and
  why sweeps run from a short worktree under `$HOME`.
- [Guest agent README](../../../apps/guest-agent/README.md): the host is the
  authority on the agent's version, the darwin roles and their socket, and TCC
  rewritten after a swap.
- [SECURITY.md](../../../SECURITY.md): SIP off in macOS guests, images, and what a
  direct copy exposes ([direct image copies](../../../SECURITY.md#direct-image-copies)).

The invariants this work added, which would break silently if violated:

- **Nothing in a `VMSpec` comes from the environment.** A saved state restores
  only into the configuration it was saved under, so every field restore depends
  on comes from the sandbox's record and directory (`VMSpecTests`).
- **A sandbox never depends on its image after creation.** Its disk is its own
  APFS clone and its boot store its own copy, so deleting or replacing an image
  never breaks a sandbox. A clone that fell back to a full copy says so.
- **Nothing reads half an image.** Images are written into a dot-prefixed
  temporary directory and committed by one rename. Temporaries are swept at
  start, except those of an operation still running.
- **Every image write checks free disk first** and refuses with `disk_full`,
  with the numbers, before starting. Placement and the receiving Mac use one
  rule for whether a copy fits (choice S60).
- **A third macOS VM is never Virtualization's raw error.** Admission sleeps the
  least recently used idle macOS sandbox (`made_room`), or answers
  `machine_full` with the reason.
- **Nothing on the freeze path writes to the guest's disk**: freeze and thaw only
  `sync` and `fsfreeze`, and an `agent.update` is refused while the guest is
  frozen. Thaw, resume and unlock run on every path of `freezeAndClone`.
- **An agent swap is never a lost guest.** An `updated` answer marks the next
  request-lane close as expected. An unexpected close still stops the sandbox.
- **Each macOS sandbox gets a new `VZMacMachineIdentifier`** and its own copy of
  the auxiliary storage (E10). Save files are encrypted per Mac and never travel.
- **The copy key is never journaled**, so a resumed copy waits for its Convex row
  again.
- **The macOS desktop helper changes only with a new macOS base.** Self-update
  moves the agent binary, not `localbox-desktop`, so a change to the helper's
  interface reaches users only through a rebuilt base and newly saved images
  (choice V5).
- **Every `image` command reports at the map's output standard:** what it changed,
  the freeze duration, where the image lives, copy size, duration and path, and
  the next command.

## Where to look

- Contract and routing: `packages/contract/src/index.ts` (`image.*`,
  `ImageOperationState`, the routing table); `tests/catalog-routing.test.ts`.
- Account side: `packages/state/convex/images.ts` (images, holders, `copies`,
  the account default); `apps/relay/src/image-ops.ts`,
  `apps/relay/src/sandbox-ops.ts`; `tests/images-convex.test.ts`,
  `tests/image-catalog.test.ts`, `tests/copy-rendezvous.test.ts`,
  `tests/image-copy-relay.test.ts`, `tests/sandbox-create-copy.test.ts`,
  `tests/macos-build-relay.test.ts`, `tests/image-capture-relay.test.ts`.
- Placement: `packages/placement` `place()`; `tests/placement.test.ts`.
- On the Mac (`apps/macos/HostDaemon/Sources/HostDaemonCore`): `VMSpec.swift`
  (`VMSpec`, `BootStore`, `GuestPlatform`), `ImageStore.swift`,
  `HostOperationStore.swift`, `ImageCapture.swift`, `MacBaseBuilder.swift`,
  `MacProvisioning.swift`, `IPSWCache.swift`, `RecoveryVNC.swift`,
  `VNCClient.swift`, `ImageCopy.swift`, `SandboxCreateAfterCopy.swift`,
  `ControlChannel.swift`, `GuestAgentUpdater.swift`, `ImageHost.swift`. Tests in
  `Tests/HostDaemonCoreTests` (`VMSpecTests`, `ImageStoreTests`,
  `HostOperationStoreTests`, `FreezeLockTests`, `ImageCaptureTests`,
  `MacBaseBuilderTests`, `AgentUpdaterTests`, `ImageCopyTests`,
  `SandboxCreateAfterCopyTests`).
- Transfer: SwiftPM targets `ImageTransfer` (`TransferManifest`, `ResumeBitmap`,
  `PathSelector`, `UDPSocket`, `Sender`, `Receiver`) and `ImageCopyTransfer`;
  `Tests/ImageTransferTests`, `Tests/ImageCopyTransferTests`.
- Executables: `localbox-vsock` and `localbox-desktop` run inside darwin guests;
  `localbox-punchlab` drives a transfer by hand; `localbox-vmlab` holds the macOS
  labs (`macos-install`, `macos-provision`, `macos-tcc`, `macos-vsock`).
- Guest: `apps/guest-agent` (`src/tcc.ts`, `src/capture-prompt.ts`,
  `src/desktop-link.ts`, `darwin/`), `packages/guest-gateway/src/control.ts`,
  `packages/desktop/src/macos.ts` and `x11.ts`, `scripts/build-guest-agent.ts`;
  `tests/agent-binary.test.ts`, `tests/guest-control.test.ts`,
  `tests/guest-self-update.test.ts`, `tests/desktop-backends.test.ts`,
  `tests/capture-prompt.test.ts`, `tests/guest-identity.test.ts`.
- The Linux image: `packages/vm-image/scripts/build-boot-artifacts.ts` (the GPT
  disk), `scripts/release/build.ts`, `scripts/release.ts`; `tests/release.test.ts`.
- Probes: `scripts/proof/probes/15-*` through `39-*`, named by the build step
  they prove (`npm run proof -- NN --tier …`). Steps 21, 22, 25, 31, 33, 36 and 37
  have no probe of their own; their unit tests above prove them. The tiers are
  in [DEVELOPMENT.md](../../../DEVELOPMENT.md#proofs).

The ledger's **When** fields (a build step number, or `review` for choices made in
the closing review), the probe names and the evidence files use the build step
numbers:

| # | Built | # | Built |
| --- | --- | --- | --- |
| 15 | EFI Linux boot (spike) | 28 | `image create --from` |
| 16 | macOS install, clone identity, suspend (spike) | 29 | `sandbox create --image`, image already here |
| 17 | macOS provisioning and SIP (spike) | 30 | image catalog commands |
| 18 | macOS TCC and the desktop role (spike) | 31 | single-binary guest agent |
| 19 | darwin vsock forwarder (spike) | 32 | agent self-update |
| 20 | hole punch and transfer (spike) | 33 | darwin guest agent |
| 21 | catalog routing and image operations | 34 | macOS base build |
| 22 | Convex image records | 35 | macOS sandboxes |
| 23 | `VMSpec` and boot store | 36 | placement with images |
| 24 | image store on the Mac | 37 | transfer library |
| 25 | the `linux` image ships as an image | 38 | `image copy` |
| 26 | durable host operations | 39 | create with copy |
| 27 | control lane and freeze | 40 | positioning, docs and security |

## Dead ends and divergences

What the build found that the plan didn't predict, so nobody walks it again.

**Linux boot and images**

- `sgdisk` has no quiet flag. An unknown flag makes it exit 0 after writing an
  empty partition table, so the disk build checks for the EF00 partition
  afterwards (`build-boot-artifacts.ts`).
- The EFI configuration still refuses a restore after a changed CPU count, MAC
  or machine identifier, as direct boot did. A changed kernel command line no
  longer matters, because there is none.
- The planned short-lived `BootStore.linuxDirect` seam and the per-image-kernel
  fallback were never needed. EFI held, so `SandboxArtifacts`, the
  `VZLinuxBootLoader` path and the three launchd template variables are gone.
- Free disk joined the capacity report, and it changes by a few bytes all the
  time. The connector reports every capacity change to Convex, so idle Macs
  started making about 16 calls a minute and broke the idle-silence promise. The
  reported figure now moves only once it is a gibibyte off, and fixture daemons
  in proofs report a fixed free disk (`LOCALBOX_DEV_FREE_DISK_BYTES`).

**macOS build**

- Virtualization's VNC server traps unless the client advertises the
  DesktopSize pseudo-encoding (`VNCClient.swift`). It also listens on every
  interface, so `RecoveryVNC` always sets a one-time VNC password and the client
  speaks VNC authentication (choice N4).
- On macOS 27, `csrutil disable` asks `[y/n]` and then the only admin's password
  directly, with no user-name prompt. The script accepts either order.
- Recovery's `halt` doesn't power the VM off. The build waits, then stops the VM
  itself; the SIP policy is already written by then.
- The window-picker prompt: even with the TCC rows written, macOS 27 puts up
  "localbox-agent is requesting to bypass the system private window picker" over
  captures. Apple's `forceBypassScreenCaptureAlert` restriction, written as a
  managed preference, suppressed it until the build rebooted the guest. macOS
  then dropped it on a Mac not enrolled in device management, and the prompt came
  back on every capture. What shipped (choice N5): a guard in the desktop role
  presses Allow through the Accessibility API (`localbox-desktop
  guard-capture-prompt`). The desktop role takes one throwaway capture at start
  so the prompt appears and is answered before any real screenshot
  (`settle-capture-prompt`). macOS draws the prompt over a session's first
  captured frame, which is why a guard alone wasn't enough. The build's `tcc`
  step also waits for macOS to record the approval in
  `ScreenCaptureApprovals.plist`, which it keeps for 30 days.
- Notification banners ("App Background Activity", Chrome's notification
  requests) covered every screenshot's top right. Per-app `com.apple.ncprefs`
  settings are rewritten by macOS's notification daemon, and an MDM profile
  can't be installed on an unenrolled Mac. The build therefore disables
  Notification Center's banner agent with SIP off (choice N2). Chrome's profile
  is seeded with sign-in and site notifications off, so it opens on one tab with
  no first-run prompt.
- Four real builds found four bugs the fakes couldn't: a TLS read error on the
  in-guest Chrome download (curl now retries every error and resumes), a step
  deadline over the agent's 120 s cap, `shell.exec` sent without a sandbox id,
  and Apple's catalog failing on a second fetch inside the daemon (a build now
  falls back to the newest release cached whole).
- The 60 GB disk the plan named became 50 GB, because the build Mac's free space
  fell during the pass. The size is now chosen per image and per sandbox (choice N1).
- An uncached build, including the 25.6 GB IPSW download, was never measured
  end to end on a real Mac: the build Mac lacked the free disk. The resumable
  download is proven on a fake HTTP layer, and tier `m` seeds the IPSW cache by
  APFS clone.

**darwin guest**

- TCC grants are lost on a binary swap. A replaced binary loses the
  screen-capture grant, while accessibility and event posting survive. So P6's
  fallback is the design: after every swap the agent rewrites all three rows
  (`rewriteDarwinTccGrantsAfterSwap`). TCC holds the agent responsible for the
  helper it spawns, so one set of rows covers both.
- ScreenCaptureKit returns nil (`SCScreenshotManager`) whenever a menu is open.
  `desktop.screenshot` captures one frame from a running `SCStream` instead,
  which works with a menu open.
- The gateway's default journal path `/.localbox` is on macOS's read-only system
  volume. darwin keeps its state under `/var/db/localbox`.
- A restored macOS guest closes the first vsock connection at once, and a dial a
  second later attaches. Before the fix, every wake cold-booted the sandbox and
  lost its processes. Opening a guest lane now dials again when it closes before
  the ready frame, within the same 120 s
  (`testGuestLaneDialsAgainWhenTheGuestClosesBeforeReady`).
- Spike 19's first run deadlocked in the test harness, not the vsock forwarder:
  the host wrote a whole 8 MiB frame before reading its echo.
- `nohup` exits at once under the darwin agent, which has no console session.
  `(cmd &)` starts a process that survives.
- The first-boot wait stayed one 120 s for both OSes (choice S2). The plan
  expected macOS to need longer, but measured macOS sandboxes answer 19–22 s after create
  (`35-macos-sandboxes.json`).

**Transfer**

- The throughput gate was restated (choice N3). On one Mac the LAN address
  routes through loopback, so `iperf3` measured the kernel, not a network, and
  the transfer reached only 40–61% of it in the run that restated the gate (about
  54–67%, 65% median, in the recorded run). Network.framework delivers each datagram through a
  callback and tops out near 270k datagrams per second here,
  below the kernel socket path `iperf3` uses. The gate now compares the transfer
  with bare Network.framework datagrams on the same path, and requires at least
  70% of that and at least 1 Gbps. It reached 93% (2.73 of 2.93 Gbps) in the recorded run, faster
  than gigabit Ethernet or Wi-Fi, so on a real link the link sets the speed. BSD
  sockets (about 1.35× faster) and QUIC with a pre-shared key were the
  alternatives weighed; only 10 GbE would expose the difference.
- A live flow to the STUN server on the shared port blocked every later flow
  from that port, so STUN flows are cancelled after gathering.
- On APFS, `fsync` blocks concurrent `pwrite` to the same file and stalled the
  window. The resume bitmap is saved without fsync and is only a hint: a resume
  re-hashes every chunk it claims.
- An unpaced sender collapses Network.framework's receive rate. The sender
  paces at a rate steered by the receiver's loss feedback.
- The UDP punch/listen race: a restarted receiver says HELLO as the sender's
  punch toward its new port lands. When the inbound packet wins, the listener
  accepts a flow for that peer, and the sender's own outgoing flow to the same
  address waits forever on `EADDRINUSE`, swallowing every HELLO. 4 of 6 resumes
  failed that way. `UDPSocket` now sends on the accepted flow (choice S12, gated
  by probe 38).

**Docs and positioning**

- Two of the site critique's should-fix items are art direction and were left
  for a person: the black character plays a different role in each drawing, and
  the hero's sandbox is a tray of sand beside the computers rather than one of
  them (choice S19).
- Marketing still describes shared folders, which [SECURITY.md](../../../SECURITY.md)
  says aren't built.

## Open verification

**The user's two-Mac run on different networks (tier `x`)** is the one check not
yet run. It is step 8 of the
[two-Mac runbook](../../durable-sandboxes/two-mac-runbook.md#8-copy-an-image-across-networks):
copy an image between two Macs on different networks, resume it mid-copy, and
report the NAT each side's STUN answers suggest if the punch fails. Its timed copy
shows the real link's speed against the restated gate (choice N3) and settles the copy
transport's tuning (choice V1). Probe 20 and probe 38 at tier `x` exit 2
(blocked) until it runs. A failed punch alone is accepted (P13): the copy fails
with why and what to try.

## Visual provenance

The images in [`evidence/`](evidence/) are what each visual claim was held to.
The JSON beside them is each probe's verdict and measurements from its recorded
run (18's and 20's JSON are later reruns than the shots and numbers first quoted
for them). The macOS shots are real 1440×900 captures taken inside guests on this
build's Mac (17 over the VNC screen; 18 by spike 18's in-guest probe through
ScreenCaptureKit; 33–35 by the agent's own `desktop.screenshot`). The standard was the map's: an agent sees the real desktop, with no
dialog, banner or Setup Assistant between it and the work.

| Image | What it is | Standard it was held to |
| --- | --- | --- |
| `17-desktop.png` | The provisioning boot of a fresh clone, captured over VNC before Recovery: the auto-logged-in desktop. | No Setup Assistant and no human step (L2). The `csrutil` result is in `17-macos-provision.json`. |
| `18-menu-opened.png` | A click posted by spike 18's stand-in for the desktop role (`localbox-tccprobe`), captured in the guest by the probe's ScreenCaptureKit capture with the menu open: the Apple menu open (the host watched over VNC but missed the menu that run, so the probe retried). The window-picker prompt and the legacy Screen Recording alert are both visible. | Grants written to TCC take effect with no click. This shot is where the window-picker prompt was first seen. |
| `33-menu-open.jpg` | The real darwin agent's one-frame `SCStream` capture, taken with a menu open. The prompt is still up. | A capture works while a menu is open. The prompt was left to the base build. |
| `34-prompt-after-reboot.jpg` | The managed preference's failure: after the build rebooted the guest, the window-picker prompt was back. | Dead-end record for `forceBypassScreenCaptureAlert`. |
| `34-prompt-before-guard.jpg` | The prompt cross-fading over the Screen Recording alert, before the guard pressed Allow. | Dead-end record: what a screenshot showed with nothing answering the prompt. |
| `34-menu-open-guarded.jpg` | The guard's first version: the window-picker prompt is gone, but the legacy Screen Recording alert remains. | Why a guard alone wasn't enough: the settle at start and the recorded approval shipped after it. |
| `34-desktop.jpg`, `34-browser.jpg` | A sandbox from a freshly built base: the plain desktop, and Chrome on example.com. | The quiet desktop the final review asked for: no banners, one browser tab, no sign-in prompt. An unprimed screenshot critique accepted it. |
| `35-desktop.jpg`, `35-menu-open.jpg`, `35-browser.jpg` | The end-to-end macOS sandbox run: the desktop, the Apple menu open, and the browser. | Real, complete frames with no prompt, also with a menu open. An unprimed critique judged all three real and complete (sharp, 1440×900, menu fully captured, page loaded). |
| `40-site/before/` | The site built at `dfa1d49`, before the rewrite: headline "Give your agents all your computers." | The baseline [compare-screenshots](../../../.agents/skills/compare-screenshots/SKILL.md) measured against. |
| `40-site/after/` | The final site: headline "Stop renting sandboxes. You already own them.", at desktop, laptop, tablet and mobile widths, with a mixed open/closed FAQ. | compare-screenshots found the first rewrite moved every pair by copy only, with no layout regressions. The critique's fixes then moved the mobile hero (stacked art) and the desktop features (trimmed drawings). A fresh agent's [screenshot-critique](../../../.agents/skills/screenshot-critique/SKILL.md) passed it on round 3 with nits only, after rounds 1 and 2 failed (a contradicting headline, 4–6 px drawing labels on phones, jargon, FAQ answers that contradicted shared folders). |

All captures are light scheme: the site has no dark theme, and dark captures
were pixel-identical. Dropped at close, as intermediate: `40-site/pre-critique/`
(the first rewrite the critique started from), `40-site/crops/` (the zooms the
critique read), the two compare-metrics JSON files (numbers for pairs whose
middle side is gone; the verdicts are above), and `17-csrutil.png` (an all-black
frame of Recovery's screen, saved after `csrutil disable` reported and before
`halt`). The slice files that were the
build plan are gone too; what they found is folded into this record.
