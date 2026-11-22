# Sandbox images: choices ledger

The decisions the agents made on the user's behalf while building this plan,
checked against the shipped code at the end of the build. The user's decisions
(Q1–Q12 and the agent's L1–L6 in the [unknowns map](map.md), P1–P13 in the
[README](README.md#plan-decisions)) are not repeated here. An entry restates one of
them only where the code made a further choice inside it, or where it is a
trade-off the user now owns.

This ledger replaces the one appended pass by pass during the build. Entries that
a later pass reversed are gone. Merged entries describe only what shipped. "Provisional, revisit in slice N"
verdicts now say how slice N settled them. Narration about gates, evidence and probes is
gone too.

**How to read it.** Entries are grouped by verdict:

- **Needs your call:** a trade-off only the user can make. Each one names the
  provisional call that ships now and how to reverse it.
- **Unsound:** a choice that breaks a given. Each one names the decision to redo it from.
- **Provisional:** sound for now, but waiting on something named (the two-Mac run,
  growth over time).
- **Sound:** the architecture the user now owns.

Within each group the least confident entry comes first. **Confidence** means how
sure the audit is that the user would have made the same call. **When** gives the
slice or slices that made the choice (`review` means the whole-spec review at the
end). Slice files and the README cite choices as "choice NN", which means the
entries whose **When** includes slice NN. ⚠ marks a choice that stretches or contradicts
a decision in the map.

**Review these first:** N1 (the macOS disk may be too small for Xcode), N2 (macOS
notifications are switched off in every guest), N3 (the copy-speed gate was
restated) and N4 (the VNC server listens on every interface during the build).
Nothing is unsound any more: the two unsound choices were redone and are now S59
(a macOS build takes its VM slot through admission) and S60 (one copy-fits rule).

---

## Needs your call

### N1. macOS sandboxes get a 50 GB disk, and the base already fills about 30 GB of it

**When:** 34 · **Owner:** `MacBaseBuilder.diskBytes` (`HostDaemonCore/MacBaseBuilder.swift`)

Say you run `image create --macos`. The build makes one 50 GB virtual disk
(50 × 10⁹ bytes; sparse, so the Mac stores only the blocks written to it) and
installs macOS, Chrome and the agent on it. That uses about 30 GB, so every macOS
sandbox made from the base starts with about 20 GB free. The map says macOS
sandboxes are mainly for building iOS and Mac apps in Xcode. An expanded Xcode
plus one iOS simulator runtime, and the `.xip` while it expands, can easily take
most of those 20 GB. Nothing can make a sandbox's disk bigger: `sandbox.resize`
changes only CPUs and memory. Before the build starts, it requires the whole
50 GB to be free (plus whatever part of the IPSW, Apple's macOS installer file, is
still to download), so that a build never fills the Mac halfway through.

- **Gap:** the slice delegated a size between 50 and 80 GB, and its text said 60 GB.
  50 GB was taken because this Mac's free space fell during the pass.
- **Reach:** the size is fixed into every macOS base and into every image saved
  from a sandbox of it. A bigger disk later means building a new base.
- **Verdict:** needs your call. **Provisional call:** keep 50 GB until someone
  installs Xcode in a real sandbox and sees whether it fits. To reverse it, raise
  `diskBytes` (to 80 GB, say). That affects only bases built afterwards. It also
  raises the free space a build demands up front, unless the check is changed to
  count expected use instead of the full size. Alternatives: 60 GB as the slice
  said; a disk-size option on `image create --macos`.
- **Confidence:** low.

### N2. Notification banners are switched off in every macOS guest

**When:** review · **Owner:** `MacBaseBuilder` `tcc` step (`launchctl disable gui/<uid>/com.apple.notificationcenterui.agent`)

Picture an agent taking screenshots of a macOS sandbox. macOS shows banners in
the top right ("App Background Activity" when a launch item is added, Chrome
asking to show notifications) that cover part of every shot. The build therefore
disables Notification Center's banner agent for the sandbox's user. Turning off a
system agent needs SIP (System Integrity Protection) off, so this runs in the
`tcc` step, after the step that disables SIP. The catch: no app in the
sandbox can show a notification banner either, including an app you are building
and testing in Xcode. The other options either didn't stick or couldn't run
unattended. `com.apple.ncprefs` per-app settings are rewritten by macOS's
notification daemon, and an MDM profile can't be installed on a Mac that isn't
enrolled in device management.

- **Gap:** the plan said nothing about how quiet the desktop should be. The review
  wanted clean screenshots.
- **Reach:** every macOS base and every image saved from one. Testing an app's
  notifications needs the agent turned back on inside the sandbox
  (`launchctl enable` + `bootstrap`; SIP is off, so it can).
- **Verdict:** needs your call. **Provisional call:** keep banners off, and
  have the skill tell the agent how to turn them back on when it is testing
  notifications. To reverse it, delete that one line from the `tcc` script and
  build a new base.
- **Confidence:** low–medium.

### N3. The copy-speed gate compares against the best the transport layer can do, not against `iperf3`

**When:** 20 (restated), still waiting on the two-Mac run · **Owner:** `scripts/proof/probes/20-punch.ts` (`THROUGHPUT_GATE`, `MIN_GBPS`)

The map asked that a direct copy reach about local-network speed, and the slice
set "at least 70% of `iperf3`" (`iperf3` is the standard network speed tool). On
one Mac, though, the Mac's own LAN address routes through loopback, a path inside
the kernel that never touches a network. So `iperf3` measured memory-copy speed
(4.4 Gbps over UDP, 78 Gbps over TCP), and the transfer reached only 40–61% of
it. The gate now compares the transfer with bare datagrams sent through the same
Network.framework socket layer on the same path (UDP packets with no protocol on
top, the most this transport could ever do). It passes when the transfer reaches
at least 70% of that and at least 1 Gbps. It reached 95% (2.37 of 2.50 Gbps),
which is faster than gigabit Ethernet or Wi-Fi, so on a real link the link sets the speed.
`iperf3` is still run and recorded, but it no longer decides the result.

- **Gap:** the slice's baseline couldn't measure a network on one Mac.
- **Reach:** this is what "the copy is fast enough" means until two Macs run it.
  On 10 GbE the Network.framework layer, not the link, may be the limit.
- **Verdict:** needs your call. **Provisional call:** keep the restated gate, and
  let the two-Mac, two-network run (the README's open TODO) confirm it on a real
  link. To reverse it, gate on `iperf3` UDP again, which would reopen the
  transport choice (P13). Alternatives the spike measured or named: BSD sockets
  (about 1.35× faster here, which matters only on 10 GbE); QUIC with a pre-shared key.
- **Confidence:** low–medium.

### N4. During a macOS build, a VNC server listens on every network interface behind a one-time password

**When:** 17, 40 (documented) · **Owner:** `RecoveryVNC.swift`

Disabling SIP needs `csrutil disable` typed at a Terminal in macOS Recovery, and
nothing but the screen can drive that Terminal. So for that one step the build
attaches Virtualization's private VNC server (`_VZVNCServer`; VNC is a
remote-screen protocol) to the guest and types into it. That server binds to
every interface of the host Mac (`INADDR_ANY`) on a free TCP port. During those
few minutes, another machine on the same network could connect to it if it guessed
the password. The build makes a fresh 8-character password each time (VNC's
maximum; 31 possible characters, about 40 bits), and the server closes when the
step ends. SECURITY.md documents it.

- **Gap:** spike 17 proved the server works. Nobody chose how exposed it may be.
- **Reach:** every `image create --macos` on every Mac, for a few minutes.
- **Verdict:** needs your call. **Provisional call:** keep it, password-protected
  and short-lived. To reverse it, find out whether `_VZVNCServer` accepts a
  loopback-only address, or block the port with the macOS application firewall for
  the step's duration.
- **Confidence:** low–medium.

### N5. The agent clicks Allow on macOS 27's screen-capture prompt by itself

**When:** 34, 35 · **Owner:** `localbox-desktop guard-capture-prompt` / `settle-capture-prompt`, `apps/guest-agent/src/capture-prompt.ts`, the build's `tcc` step

When a process captures the screen, macOS 27 can show "localbox-agent is
requesting to bypass the system private window picker" over the very frame it
captures. A screenshot taken then shows the prompt instead of the desktop.
Localbox answers the prompt itself in three layers:

1. The desktop role (the agent's process inside the user's session) runs one
   `localbox-desktop guard-capture-prompt` child at all times. Once a second it
   looks for the prompt through the Accessibility API and presses Allow.
2. When it starts, the desktop role takes one throwaway capture
   (`settle-capture-prompt`) so that the prompt appears and is answered within
   5 s. `desktop.screenshot` waits up to 30 s for that first answer.
3. The build's `tcc` step waits up to 25 s for macOS to record the approval
   (`ScreenCaptureApprovals.plist`). macOS keeps the record for 30 days, so a
   sandbox made in that window never sees the prompt at all.

Apple's own switch for this (`forceBypassScreenCaptureAlert`, a managed
preference) worked once in the lab, but macOS deleted it across the build's
reboots on a Mac that isn't enrolled in device management.

- **Gap:** the plan granted capture through TCC (macOS's privacy permission
  database). It didn't expect a second prompt.
- **Reach:** a guest process clicks through a macOS privacy prompt, using only
  public APIs. This is part of the SIP-off trade-off (convenience over hardening
  inside the guest, one of the map's inferred preferences). A future macOS that
  changes the prompt's text or buttons breaks screenshots until the guard learns it.
- **Verdict:** needs your call. **Provisional call:** keep it. It is the only way
  found to make screenshots work with no human step. To reverse it, drop the
  guard. Every fresh sandbox's first screenshot then needs a person to click Allow.
- **Confidence:** medium.

### N6. ⚠ `image delete` doesn't require `--confirm` (Q10 writes it as part of the command)

**When:** 21 · **Owner:** `packages/contract` (`image.delete` input `{ image, confirm? }`), `apps/relay/src/image-ops.ts`

Q10 gives the command as `image delete NAME --confirm NAME`. In the shipped
contract `confirm` is optional, exactly as `sandbox delete`'s already was. If it
is given, it must equal the image's name (otherwise `invalid_input`). If it is
left out, the delete goes ahead. The skill and every next step printed by the
product always write `--confirm NAME`, so agents following the docs confirm. A
caller that leaves it out isn't stopped.

- **Gap:** E13 said to add `--confirm` checks in the relay. It didn't say whether
  the flag is mandatory.
- **Reach:** every destructive image command. The same pattern covers sandboxes.
- **Verdict:** needs your call. This **contradicts the wording of Q10**. **Provisional
  call:** keep it optional, consistent with `sandbox delete`. To reverse it, make
  `confirm` required in the `image.delete` schema (and `sandbox.delete`'s, for
  consistency), then regenerate snapshots.
- **Confidence:** medium.

### N7. Convex's operators could read a copy's key while the copy runs

**When:** 38, 40 (documented) · **Owner:** Convex `copies.key` (`packages/state/convex/images.ts` `transferKey`)

When Mac A copies an image to Mac B, the relay writes a `copies` row in Convex
with a fresh random 32-byte key. Only A's and B's machine credentials can read the
row through Convex's API. Both Macs seal every datagram with that key
(ChaCha20-Poly1305 encryption), so nobody on the network can read the image bytes
or inject any. But anyone who can read the Convex deployment directly, such as
its operators or a leaked deploy key, could read the key during the copy's
lifetime (at most 24 h). With the key and a position on the network path, they
could decrypt the stream. SECURITY.md says so plainly. The image bytes never pass
through Convex, Vercel or any cloud storage (Q4).

- **Gap:** E8 said the rendezvous row carries a one-time key. It didn't say who
  else could read it.
- **Reach:** the copy's trust boundary includes Convex. Changing that is a
  protocol change on both Macs.
- **Verdict:** needs your call. **Provisional call:** keep it, as documented.
  To reverse it, each Mac publishes an ephemeral X25519 public key in the row and
  the two derive the copy key themselves (Diffie–Hellman), so Convex only ever
  sees public halves.
- **Confidence:** medium.

### N8. ⚠ While its image copies, a sandbox answers `status` normally, and refuses every other operation, `delete` included (L3 said every operation refuses)

**When:** 39 · **Owner:** `apps/relay/src/sandbox-ops.ts`

Say you run `sandbox create --image rails --machine attic` and attic doesn't have
`rails` yet. The create answers at once with the sandbox `copying`. L3 said that
operations on such a sandbox return `sandbox_not_ready` with the copy's progress.
Shipped: `sandbox status` answers successfully, with state `copying`, the progress
and `next_step: localbox image wait rails`, because status is a read and its job
is to show progress. Every other operation, including `delete` and `rename`,
answers `sandbox_not_ready` (retryable) with the progress. So you can't cancel a
slow copy by deleting the sandbox. The copy always ends, though: a side waits
120 s for a silent peer, a stalled receiver gives up, and copy rows expire after a day.

- **Gap:** L3 named the error but didn't say whether status counts, or how to
  cancel.
- **Reach:** there is no way to cancel a copy. A large image over a slow internet
  path holds the sandbox for as long as the copy takes.
- **Verdict:** needs your call. **Provisional call:** keep it. To reverse it, let
  `delete` cancel the chained create and its copy (`images:cancelCopy` plus a
  daemon cancel path, which doesn't exist yet).
- **Confidence:** medium.

### N9. ⚠ When no Mac has room, automatic placement makes room on a Mac that holds the image instead of copying it elsewhere (extends Q6)

**When:** 36 · **Owner:** `packages/placement` `place()`

Q6 says automatic placement first picks among Macs that hold the image and have
room, and only if none fits picks another Mac and copies first. Two cases go
beyond that. (1) A copy goes only to a non-holder that has both free memory and
the free disk for the image. It is never sent to a Mac that would then also have
to sleep sandboxes to make room. (2) When no holder has room and no other Mac
could take the copy and fit the sandbox, a holder makes room, as before this
work (it sleeps idle sandboxes, or answers `machine_full`). Example: a 30 GB
image on Mac A, which is full. Mac B is also full. Copying 30 GB to B and then
sleeping sandboxes there is worse than sleeping sandboxes on A.

- **Gap:** Q6 didn't cover the case where nothing fits anywhere.
- **Reach:** how `sandbox create` behaves on a busy fleet.
- **Verdict:** needs your call (likely what you'd want). **Provisional call:**
  keep it. To reverse it, follow Q6's text literally (copy to the roomiest
  non-holder with disk, whether or not it fits).
- **Confidence:** medium–high.

---

## Unsound

None remain. The final review found two, and both were redone from their
corrected decisions: a macOS build that ignored the two-VM limit in one direction
(now S59) and two owners of the copy-fits rule (now S60).

---

## Provisional

### V1. The copy transport's tuning waits on a real two-network run

**When:** 20, 37 · **Owner:** SwiftPM target `ImageTransfer` (`Receiver.Options`, `Sender`, `Transport.swift`)

A direct copy splits each file into 1 MiB chunks and sends each chunk as
1400-byte UDP datagrams (1372 bytes of payload each, small enough for an Ethernet
MTU, the largest packet a link carries, with room for a tunnel header).
Each datagram is sealed on its own, so one lost datagram means resending 1400
bytes, not a whole chunk. The sender paces itself: it raises its rate 25% every
20 ms until the first loss, then 10% at a time, and only while the receiver keeps
up. Loss above 1% cuts the rate by 15%. A local-network path uses two UDP flows,
which measurably cut loss. A punched internet path uses one, because every extra
port needs its own NAT mapping. Only IPv4 is used. All of this was tuned on one
Mac, where the "network" is loopback.

- **Gap:** congestion control and sizes were delegated, and the only real link
  available was loopback.
- **Reach:** speed and reliability of every copy across networks. IPv6-only
  networks can't copy.
- **Verdict:** provisional. Revisit after the two-Mac, two-network run
  (README TODO). Watch for fragmentation, which would mean using 1200-byte
  datagrams, and for loss under real queues. Alternatives: fixed rate, or BBR
  (a model-based congestion control); IPv6 candidates.
- **Confidence:** low–medium.

### V2. Copy peers announce their addresses once per start and wait for each other up to two minutes

**When:** 38 · **Owner:** `ImageCopy.swift`, `ImageTransferCopyTransport.swift`

Each side of a copy publishes its candidate addresses into the copy's Convex row
when its transport starts. A side that restarts publishes again, and the peer sees
the new set through its subscription. Nothing republishes on a timer. A side waits
120 s for the copy row and 120 s for the peer's first candidates, then fails with
`copy_unreachable`. Once the first candidates have arrived, it watches for a
restarted peer's new set for as long as the transfer runs. The sender quits after
120 s with no request (the library's default is 60 s), so a receiving Mac that
restarts has time to bring its daemon, connector and rendezvous back. The
receiver restarts path selection after 60 s without bytes, and fails on a second
stall at the same byte count.

- **Gap:** refresh and wait times were delegated.
- **Reach:** whether a copy survives a NAT mapping expiring or a Mac rebooting
  partway through.
- **Verdict:** provisional. Revisit on the two-network run, where a NAT may expire
  a mapping that a once-only announcement can't recover. Alternative:
  republish every 30 s while waiting (idle Convex writes).
- **Confidence:** medium.

### V3. Downloaded macOS installers are kept forever

**When:** 34 · **Owner:** `IPSWCache.swift`, `ImageStore.ipswDirectory` (`images/.ipsw/`)

A macOS build downloads Apple's IPSW (the macOS restore image, 17–26 GB) into
`images/.ipsw/`. The download resumes if interrupted, and it is kept so that the
next build skips it. The daemon's startup sweep never touches that folder.
Nothing ever removes an IPSW, not even when a newer macOS release replaces it, so
each release you build from leaves about 25 GB behind. When Apple's catalog can't
be reached, a build uses the newest IPSW cached whole. The cache records which
release each file is (`<name>.ipsw.json`) every time the catalog names it, and the
catalog fetch is tried four times, five seconds apart.

- **Gap:** eviction was delegated, and nobody decided it.
- **Reach:** free disk on any Mac that builds macOS bases.
- **Verdict:** provisional. **Recommended:** when a build finishes, keep only the
  IPSW it used and delete older ones. Alternatively, report the cache in
  `system.info` so users can see it.
- **Confidence:** medium.

### V4. Host operation journals are never pruned

**When:** 26 · **Owner:** `HostOperationStore.swift` (`LOCALBOX_OPERATIONS`)

Every long piece of host work (image capture, macOS build, copy,
create-after-copy) is journaled as a JSON record so it can resume after a restart
and answer a late replay of the same request. Finished records are never deleted.
A record has to outlive the relay's replay window, and when this was built nobody
had said how long that window is. Each record is small, so this is slow growth,
not a leak that bites soon.

- **Gap:** retention wasn't specified.
- **Reach:** the size of the operations folder, and how long the daemon's start
  takes to load it.
- **Verdict:** provisional. Prune finished, reported records older than the
  relay's dedupe window (a day) at start, once usage shows how fast they pile up.
- **Confidence:** medium.

### V5. The macOS desktop helper changes only with a new macOS base

**When:** 33 · **Owner:** `apps/guest-agent/darwin/install.sh`, `localbox-desktop`

On macOS, screenshots, clicks and keys go through a small Swift helper,
`localbox-desktop`. It ships inside the image next to the agent and the vsock
forwarder. When the host pushes a newer agent into a guest (Q11), only the agent
binary moves. The helper stays whatever the base was built with. So a change to
the helper's arguments or behaviour reaches users only after they build a new
macOS base and save new images from it. The README warns about this.

- **Gap:** self-update (slice 32) was scoped to one binary per OS.
- **Reach:** every helper change after launch.
- **Verdict:** provisional. Keep the helper's interface small and stable. If it
  starts changing, push it over the control lane alongside the agent (a second
  file in the same chunked update).
- **Confidence:** medium.

### V6. The guest agent is compiled with Bun 1.4.4, which CI doesn't have

**When:** 31 · **Owner:** `scripts/build-guest-agent.ts` (`BUN_VERSION`), `tests/agent-binary.test.ts`

The guest agent is a TypeScript program compiled into one self-contained binary
per OS with `bun build --compile` (Bun is a JavaScript runtime that can produce
standalone executables). One Mac cross-compiles both the linux-arm64 and the
darwin-arm64 binaries. The same sources and Bun version give byte-identical
output, so the build refuses any other Bun version, because a different compiler
would change every digest and therefore the agent's version. Bun is a tool you
install on PATH, not an npm dependency: npm 11 won't run the `bun` package's
install script without approval. The release-checks CI job has neither Bun nor
Docker, so the agent-binary test skips there and says why. The binaries are also
built with `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`, so the
agent never picks up a `.env` file from its working directory and passes it on to
every command it runs.

- **Gap:** L4 chose one binary per OS. It didn't choose the compiler.
- **Reach:** a dependency the user owns: bumping Bun changes every agent version.
  CI doesn't build the agent.
- **Verdict:** sound for the pin, provisional for CI. Add `oven-sh/setup-bun` at
  the pinned version so CI builds and tests the binary. Alternative compiler: a
  Node single executable application (needs a bundler, `postject`, a pinned linux
  Node download and separate darwin signing).
- **Confidence:** medium.

---

## Sound: trade-offs and shapes you now own

These implement a decision the user made, or a given. They are listed because the
user owns the consequences.

### O1. Two public input fields are filled in by the agent API only

**When:** 28, 29, 39 · **Owner:** `packages/contract` (`image.create` `image`, `sandbox.create` `image` and `after_copy`), relay refusals in `image-ops.ts` and `sandbox-ops.ts`

The relay validates every request it forwards to a Mac against the public catalog
schema, which forbids unknown fields. To hand a Mac what only Convex knows, the
relay uses fields the public schema lists:

- `image.create` input `image`: the reserved image's id, so the Mac journals the
  capture under that id. The relay refuses `image` from a caller.
- `sandbox.create` input `image`: always sent as the resolved id. Callers may
  pass a name or an id.
- `sandbox.create` input `after_copy`: the copy the Mac must wait for. The relay
  refuses it from a caller.

So `help`, the MCP tool list and the skill all show fields described as "set by
the agent API; callers leave it out".

- **Alternative:** an envelope-level field for relay-only data, which would be a
  second request shape.
- **Verdict:** sound, but it's a visible wart in the public schema. **Confidence:** medium.

### O2. Every macOS guest runs with SIP off, a root agent, and TCC grants written straight into the database

**When:** 17, 18, 33 (Q3, P4, P6) · **Owner:** `MacBaseBuilder` (`sip`, `tcc` steps), `apps/guest-agent/src/tcc.ts`

Q3 chose SIP off in every macOS guest. Here is what the build does with that. In
Recovery it types `csrutil disable`. It installs the agent as a root
LaunchDaemon (shell, files, jobs) plus a LaunchAgent in the auto-login user's
session (desktop and browser). Then, as root, it writes rows into the system and
user TCC databases (macOS's privacy permission store) that grant the agent Screen
Recording, Accessibility and synthetic input. Spike 18 showed that a replaced
binary loses its grants, so P6's fallback is live: after every agent self-update
the agent rewrites its own rows (`rewriteDarwinTccGrantsAfterSwap`, the same code
as `localbox-agent --grant-tcc`). If that rewrite fails, it is logged rather than
raised, because the new binary is already in place. Anything running as root in
the guest can do what the agent does.

- **Reach:** the guest is a convenience environment, not a hardened Mac. This
  matches the map's "convenience over hardening inside the guest".
- **Verdict:** sound (implements Q3). **Confidence:** high.

### O3. Private Apple API lives in one file and fails soft

**When:** 17 (L2) · **Owner:** `RecoveryVNC.swift`

The only private API is `_VZVNCServer`, reached by name through the Objective-C
runtime. If a future macOS removes the class or changes its initializers,
`RecoveryVNC` answers `unsupported` ("…the macOS image build cannot disable SIP")
instead of crashing the daemon. Nothing else in Localbox touches private API.
Releases are self-signed and not notarized, and private API needs neither.

- **Reach:** a macOS update can break `image create --macos`, and only that.
- **Verdict:** sound. **Confidence:** high.

### O4. macOS sandboxes need macOS 27 on the host; Linux sandboxes still need only macOS 14

**When:** 34, 40 (L2) · **Owner:** `packages/placement` `MACOS_IMAGE_MINIMUM = "27"`, `buildTarget()`; site, README, `llms.txt` requirements

A Mac on macOS 26 still runs Linux sandboxes, but it can't build a macOS base or
run a macOS sandbox. The relay refuses `image create --macos` for a Mac whose
reported version is older than 27 (or that never reported one) before reserving
anything, and placement never puts a macOS image on such a Mac. The site and
`llms.txt` say "macOS 14 or newer (macOS 27 for macOS sandboxes)". The README adds
the same line and a "sandboxes: Linux · macOS" badge. The install steps tell the
agent to mention it when the Mac is older.

- **Verdict:** sound. Hiding the 27 requirement until a build fails would be a
  surprise. **Confidence:** high.

### O5. Each Mac learns its public address from Cloudflare's STUN server, on ports 3478 and 53

**When:** 20, 37 (L6) · **Owner:** `PunchedUDPTransport` (`Transport.swift`)

For a copy across networks, each Mac asks `stun.cloudflare.com` which public
address and port its NAT gave it. It asks from the transfer's own UDP port,
retrying every 400 ms for up to 2.5 s. STUN is a tiny echo service that sees only
the request, never image bytes. Asking on both 3478 and 53 shows whether the NAT
maps one port the same way for every destination (punchable) or differently per
destination ("symmetric", usually not). The flows to STUN are closed afterwards,
because a live one blocked later flows from the same port. Local addresses are
tried at once, and the punched path after 0.3 s.

- **Reach:** a third-party dependency for internet copies, though no data passes
  through it.
- **Verdict:** sound. **Confidence:** high.

### O6. The Linux kernel version is pinned in one constant

**When:** 15, 25 · **Owner:** `packages/vm-image/src/pins.ts` (`LINUX_IMAGE_GENERIC_VERSION = "6.8.0-151.151"`)

The built-in `linux` image boots through EFI with GRUB, and its kernel lives on
its own disk (L1). To make rebuilds reproducible, the image build installs exactly
`linux-image-generic` 6.8.0-151.151, passed into the Dockerfile as a build
argument that has no default. Ubuntu drops superseded versions from its indexes,
so a stale pin fails the build loudly instead of drifting. Someone has to bump it
on purpose. A kernel upgraded with `apt` inside a sandbox still works, as on any
computer. GRUB reads a fixed config that points at `/boot/vmlinuz`, the link
Ubuntu's kernel packages update, and `update-grub` is replaced with `true` so
that it can't rewrite that config with device-specific entries.

- **Alternatives:** systemd-boot (would need every kernel copied onto the EFI
  partition); snapshot.ubuntu.com (it pinned the amd64 archive but not the arm64
  ports).
- **Verdict:** sound. **Confidence:** high.

### O7. Convex gains three image tables and new sandbox and account fields

**When:** 22, 26, 38, 39, review · **Owner:** `packages/state/convex/schema.ts`, `images.ts`

- `images` holds one row per account image: `imageId`, `name`, `os`,
  `sizeBytes` (absent until a Mac reports the image ready), `source`
  (`{ kind: sandbox | ipsw, sandboxName?, ipswVersion? }`), `minMacOS`,
  `createdAt`, `createMutationId`.
- `imageHolders` holds one row per (image, Mac): `state`
  (`building | copying | ready | failed`), `operationId`, and `error
  { code, message, nextStep }`, which is set only while failed.
- `copies` holds one row per copy: the two machines, the key, each side's
  candidates, `state` (`waiting | copying | copied | failed`), the result, and an
  expiry 24 h out.
- `accounts.defaultImageId`. Absent means `linux`, so `image default linux`
  clears it rather than storing a second spelling of the same state.
- `sandboxes` gains `imageId`, `os`, `minMacOS`, `copyOperationId`, `pending`
  (`copying | failed`) and `pendingError`.

The built-in `linux` image is never a row (P1). `images:list` makes it up, with
id `linux`, source `release`, no size and no creation time. `images:reserve`
writes the building Mac's holder row in the same mutation, so a reserved image
never lists without a holder. The validators live in `schema.ts` because
`images.ts` imports a module that imports the schema.

- **Verdict:** sound. These are the shapes future work builds on. **Confidence:** high.

### O8. A sandbox row stores its image's OS and minimum macOS itself

**When:** review (replaces 28's "every capture is linux") · **Owner:** `sandboxes:create`, `images:reserve`

When a sandbox is created, Convex copies the image's `os` and `minMacOS` onto the
sandbox row. Saving an image from that sandbox reserves the new image with the
sandbox's own values. The reason: the source image can be deleted while sandboxes
made from it live on, and a sandbox's OS never changes. Without this, saving an
image from a macOS sandbox whose base was deleted would have no way to learn it
was macOS.

- **Alternative:** read the OS from the source sandbox's image row, which fails
  once that image is gone.
- **Verdict:** sound. **Confidence:** high.

### O9. The image files on a Mac, and what `image.json` says

**When:** 23, 24, 30 · **Owner:** `ImageStore.swift`, `SandboxRecord.swift`

Each image is a folder `images/<id>/` holding the disk (`disk.img`), the boot
store (`boot/efi-vars` for Linux; auxiliary storage `aux.img` plus the hardware
model for macOS), and `image.json`. `image.json` has snake_case keys like
`sandbox.json` and the wire contract: `image_id`, `os`, `size_bytes`,
`hardware_model`, `min_macos`, `agent_version`. `size_bytes` counts allocated
bytes, not apparent length. The Linux disk is 8 GiB sparse, and what a copy or a
free-disk check cares about is what is actually stored. A `listed-by` file next to
the manifest records which account listed this image on this Mac. It is account
state, not part of the image, so a copy must not carry it. A sandbox's
`sandbox.json` stores its image id, OS and macOS hardware model, but no boot-store
path: the file name follows from the OS, and the hardware model is kept because a
restore needs it after the image may be gone.

- **Verdict:** sound. **Confidence:** high.

### O10. New daemon settings and where installs put things

**When:** 25, 26, 32 · **Owner:** `scripts/install-release.sh`, `rollback-release.sh`, `localbox-hostd/main.swift`

The daemon gets every path explicitly from its launchd plist, never derived from
another path. `LOCALBOX_OPERATIONS` is the operation journals. `LOCALBOX_IMAGES`
is the image store. `LOCALBOX_GUEST_AGENT` is the active app's
`Contents/Resources/guest-agent/`, the agent build the host pushes into guests.
When `LOCALBOX_GUEST_AGENT` is unset, guests keep the agent their image carries.
An install expands the shipped Linux image under `releases/<v>/images/linux/`.
Install and rollback then make an APFS clone of it at `images/linux`, assembled
under a dot name and then swapped in. A rollback therefore brings back the older
image with the older host, and the second copy costs no disk. The old
`LOCALBOX_KERNEL`, `LOCALBOX_INITRD` and `LOCALBOX_TEMPLATE_DISK` are gone.

- **Verdict:** sound. **Confidence:** high.

### O11. A release ships the Linux image as three kinds of signed file

**When:** 25 · **Owner:** `scripts/release.ts` (`ReleaseImage`, `packImage`, `installLinuxImage`)

The image ships as `localbox-linux-<v>.disk.img.zst.NNN` (zstd parts),
`localbox-linux-<v>.efi-vars` and `localbox-linux-<v>.image.json`, each with its
own checksum in the signed manifest. The manifest now lists every file except
`release.json` and `SHA256SUMS`, where before it skipped every `.json`. The small
files are copied verbatim, so `image.json`'s `size_bytes` is what the build
measured. The installed disk's allocation can differ slightly, which matters only
as a placement estimate. Compression uses the `zstd` CLI, which runs on every
core, and the splitting is done in Node. `release.sh` takes a built image directory
(`LOCALBOX_IMAGE`) instead of building one, so packaging doesn't need Docker. It
no longer checks that the image carries the release's own agent, because the host
now pushes its agent into every guest (slice 32).

- **Alternative:** a tar of the image folder (would need a tar reader in the installer).
- **Verdict:** sound. **Confidence:** high.

### O12. New internal daemon requests between the connector and the daemon

**When:** 26, 30, 38 · **Owner:** `ImageHost.internalOperations`, `apps/connector`

The connector (the one process on a Mac that talks to Convex) and the daemon now
exchange five internal requests over the local socket. None is in the public
catalog.

- `host.operations`: the daemon's outbox of finished operations.
- `image.mirror`: the account's image list for this Mac.
- `image.copy_rendezvous`: a copy's key and role.
- `image.copy_outbox`: local candidates going out.
- `host.begin_operation`: dev daemons only.

The outboxes are long polls acknowledged by generation, so an idle Mac makes no
Convex calls. Convex reaches the Mac only through subscriptions
(`images:forMachine`, `images:copiesForMachine`).

- **Verdict:** sound. **Confidence:** high.

### O13. The Chrome in the macOS base comes from Google's enterprise installer, signature-checked

**When:** 34 (P12) · **Owner:** `MacBaseBuilder.chromeInstaller`

The build downloads
`dl.google.com/chrome/mac/universal/stable/gcem/GoogleChrome.pkg`. It checks with
`pkgutil --check-signature` that the package is signed "Developer ID Installer:
Google LLC", and installs it with `installer`, which avoids mounting a disk image.
Each build gets whatever Chrome is current.

- **Verdict:** sound. **Confidence:** high.

### O14. The macOS build reaches the guest over SSH with a password that is thrown away

**When:** 17, 34 (P3) · **Owner:** `MacProvisioning.swift`, `GuestSSH.swift`, `MacBaseBuilder`

Apple's provisioning options create the user `localbox` with auto-login and a
random per-build password, and turn on Remote Login. The build SSHes to the
guest's NAT address with that password. It waits up to 5 minutes for the desktop
session before running `install.sh`, and in the `tcc` step up to 90 s before
`--grant-tcc`. Then, through the agent's root shell, it turns Remote Login off
with `launchctl disable system/com.openssh.sshd` plus `bootout`, which persists
across boots. (`systemsetup` would need Full Disk Access.) The password dies with
the build process. A resumed build therefore restarts provisioning from a fresh clone of the
installed disk. The finished image carries no sandbox identity (the marker
`/var/db/localbox/sandbox-id` is deleted), so every sandbox makes its own on first
connect.

- **Verdict:** sound. **Confidence:** high.

---

## Sound: medium confidence

Sound calls a reasonable user might have made differently: medium confidence first, then medium–high.

### S1. Placing a macOS image compares only the macOS major release

**When:** 34 · **Owner:** `MacBaseBuilder.minMacOS` (`"<major>.0"`), `packages/placement` `atLeast`

A macOS base records the oldest host macOS it may run on (`min_macos`), and
placement only puts the image on Macs at that version or later (E7). The build
stores the IPSW's major release as `"27.0"`, not its full version. Apple gives a
Mac the newest restore image it supports, which here was 27.2.1 on a 27.0.1 Mac.
Storing the full version would have kept the image off the very Mac that built
it, even though that Mac runs it fine. Versions are dotted strings compared
number by number, so "27.10" beats "27.9".

- **Reach:** E7 says "at least the guest's". This reads it as the major release,
  which is what the host actually needs.
- **Alternative:** the building host's own version, which would refuse equally
  capable 27.0 Macs.
- **Verdict:** sound. **Confidence:** medium.

### S2. One 120-second first-boot wait for both operating systems

**When:** 35 · **Owner:** `AppleVirtualizationBackend` (vsock accept wait)

E9 expected a macOS guest's first boot to need more than the 120 s the host
waits for the agent to connect over vsock (the host–guest socket). Spike 19 found
a clone of the macOS base answering 9.5 s after boot, so both OSes keep the one
120 s wait. A longer macOS wait would only delay reporting a dead guest.

- **Verdict:** sound. The given's premise didn't hold. **Confidence:** medium.

### S3. A guest that hasn't answered a request 30 s after its deadline counts as lost

**When:** review · **Owner:** `FramedGuestChannel` (`answerGrace = 30`)

The request lane (vsock port 1024) carries one request at a time. The agent caps
every request at its deadline (at most 120 s). If no answer has come 30 s after
`deadline_ms`, the host closes the lane and treats the sandbox as lost. An agent
that misses its own deadline is wedged, and a late answer would be read as the
answer to the next request. A request with no deadline waits as before. This
replaced a timeout that applied only to the macOS build's guest.

- **Reach:** a guest busy beyond its own deadline gets restarted rather than waited on.
- **Verdict:** sound. **Confidence:** medium.

### S4. Freezing a guest: the guest thaws itself after 10 s, and nothing else thaws it

**When:** 27 · **Owner:** `packages/guest-gateway/src/control.ts` (`DEFAULT_SELF_THAW_MS`, `MAX_SELF_THAW_MS`), `SandboxRuntime.freezeAndClone`, `ControlChannel`

Saving an image (Q8) freezes the guest's filesystem, clones the disk, then thaws.
If the host dies in between, the guest would stay frozen, so the freeze carries a
timer. The guest thaws itself after 10 s by default and refuses a timer longer
than 30 s. A second freeze restarts the timer without freezing again. A dropped
control connection does *not* thaw: the timer is the single guarantee, and a
thaw-on-disconnect would be a second path whose timing depends on the transport.
The host waits 60 s for "frozen", because `sync` may flush a lot, and 15 s for
"thawed". If the guest doesn't confirm a thaw after a good clone, the clone is
still kept, and the miss shows up in the status detail. If the clone failed, the
host resumes the VM and sends a thaw on a fresh connection. On macOS there is no
filesystem freeze, only `sync` (E2).

- **Verdict:** sound. 10 s covers an APFS clone with a wide margin. **Confidence:** medium.

### S5. Deleting an image while a Mac is still working on it

**When:** 30 · **Owner:** `ImageHost` (`image.delete`), `apps/relay/src/image-ops.ts`

Say a copy of `rails` to attic is running and you delete `rails`. Convex drops
the image row first. Attic's daemon refuses to remove files under running work
(`conflict`), so the relay reports attic's refusal. The files go at attic's next
mirror push (see S17) after the copy ends. Cancelling a build or copy outright
isn't built. The relay reports a Mac's files as removed whenever the Mac answered
`image.delete` successfully, even if the Mac says it had nothing to remove,
because the Mac's own mirror push can remove them a moment before the relayed
delete arrives. Deleting an image also deletes its copy rows. Removing a machine
leaves its copies to fail when the peer's 120 s wait runs out, and to expire.

- **Verdict:** sound. **Confidence:** medium.

### S6. A failed create-with-copy stays listed until you delete it

**When:** 39 · **Owner:** `apps/relay/src/sandbox-ops.ts`, Convex `sandboxes.pending` / `pendingError`

If the copy behind a `sandbox create` fails (for example `copy_unreachable`), the
sandbox row stays in `sandbox list` as `failed`. It carries the reason and the
next step: the copy's own advice, then `sandbox delete S --confirm S` and create
again. That failure stays visible in `sandbox list`, `sandbox status` and a
replay of the create. Deleting the row needs nothing from the Mac, which never
created the sandbox (it answers `sandbox_not_found`). If a create is refused after
its copy row was made (a taken name, say), the copy is cancelled before any Mac
hears of it. If the target Mac refuses the chained create, the sandbox is
released but the copy keeps running, because the image will still be useful on
that Mac.

- **Alternative:** drop failed rows in the daily cleanup, which would lose the reason.
- **Verdict:** sound. **Confidence:** medium.

### S7. The macOS desktop link: a root-owned socket that only the `localbox` user can open

**When:** 33 · **Owner:** `apps/guest-agent/src/desktop-link.ts`, `index.ts`

On macOS the agent is one binary in two roles (P4): a root system role and a
desktop role inside the logged-in user's session. The system role forwards every
`desktop.*` and `browser.*` request to the desktop role, so one process owns
Chrome and its focused tab. The system role listens on
`/var/run/localbox/desktop.sock`, mode 0600 and owned by root, plus an ACL entry
(`chmod +a "user:localbox allow read,write"`), and the desktop role dials in. A
group wouldn't work, because the provisioned user's only group is `staff`, which
every account shares. If the desktop role connects twice, the newest connection
wins. After an agent update only the system role restarts. The desktop role
notices at its next redial that its binary file has a new inode (a rename always
makes one), so it exits and launchd starts the new build.

- **Alternative:** a dedicated `localbox` group created by the build.
- **Verdict:** sound. **Confidence:** medium.

### S8. Chrome on macOS: started on demand, its own profile, sign-in off

**When:** 33, review · **Owner:** `packages/desktop/src/macos.ts` (`macChromeLauncher`, `MAC_CHROME_PROFILE`), `browser.ts`

On a macOS sandbox, the first `browser.*` call that finds Chrome's debugging port
(CDP on loopback 9222) down starts Chrome with
`open -n -a "Google Chrome" --args … --no-startup-window`. Chrome becomes an
ordinary app of the user that outlives the agent. It runs on its own profile
under `~/Library/Application Support/Localbox/Chrome`, because Chrome refuses
remote debugging on the default profile. The first time, that profile is seeded
with sign-in disallowed and site notifications blocked. A managed-policy plist was
ignored on the unenrolled guest, and Chrome resets one sign-in key from the other
at every start, so both are written. `--no-startup-window` keeps the launcher from
opening a stray blank tab. `desktop.status` lists tabs only if CDP already
answers, and never starts a browser. A dead CDP is `guest_unreachable`, not a raw
fetch error.

- **Alternative:** a LaunchAgent that keeps Chrome always running.
- **Verdict:** sound. **Confidence:** medium.

### S9. macOS screenshots are in points, at 1440×900

**When:** 23, 33 · **Owner:** `AppleVirtualizationBackend.macDisplay`, `localbox-desktop`

A macOS guest gets a 1440×900 display at 80 ppi with no window on the host, the
same size as the Linux desktop, so desktop operations see one size on both.
`desktop.screenshot` reports `width` and `height` as the display geometry. macOS
captures and coordinates are in points, the units CGEvent clicks take, so a
screenshot at scale 1 maps pixel for pixel onto click coordinates.

- **Alternative:** Tart's 1920×1200, or native pixels plus a scale factor.
- **Verdict:** sound. **Confidence:** medium.

### S10. The darwin agent binary keeps Bun's ad-hoc signature

**When:** 31 · **Owner:** `scripts/release.sh`, `scripts/build-guest-agent.ts`

The macOS guest agent binary is signed only with the throwaway signature Bun's
linker gives it. The release's `codesign --deep` on the app seals
`Contents/Resources/guest-agent/` as resources without rewriting those bytes, so
the digests in `agent-version.json` stay true. The binary runs inside a SIP-off
guest whose TCC rows name it by path (O2), so it never needs a Developer ID.

- **Alternative:** sign it with the release identity before hashing.
- **Verdict:** sound. **Confidence:** medium.

### S11. A copy's report: what the last attempt moved, how long the whole copy took

**When:** 37, 38 · **Owner:** `ImageTransferCopyTransport`, `ImageCopy`

A finished copy reports `copied image NAME from A to B (SIZE, DURATION, local
network | internet)`, then the next command
(`sandbox create --image NAME --machine B`). Durations read `9.5 s`, `3 min 5 s`,
`1 h 2 min`. `bytes` is what the final attempt fetched, so a resume shows how
much it saved. The duration is the whole copy, measured from the operation's first
start across daemon restarts, because that is how long the person waited. The
sending Mac reports the receiver's path: "local network" when the peer it served
came from one of the receiver's published interface addresses, otherwise
"internet".

- **Alternative:** both numbers from the last attempt, which reports a resumed
  10-minute copy as taking seconds.
- **Verdict:** sound. **Confidence:** medium.

### S12. `UDPSocket` sends on a flow its listener accepted

**When:** 38 · **Owner:** `ImageTransfer/UDPSocket.swift`

Network.framework models UDP as flows, one per peer address. When a receiver
restarts, it says HELLO at once, while the sender's punch toward its new port
lands at about the same moment. If the inbound packet wins, the listener accepts a
flow for that peer, and the sender's own outgoing flow to the same address waits
forever on `EADDRINUSE`, swallowing every HELLO. The socket therefore sends on the
accepted flow and drops its outgoing one. Before this fix, 4 of 6 resumes failed
in that setup. No unit test pins it, because the race needs real flows connecting
at the same time. Probe 38 is its gate.

- **Alternative:** treat a waiting flow as failed and rebuild it, which collides
  with the accepted flow again.
- **Verdict:** sound. **Confidence:** medium.

### S13. Copy rows expire after a day in the existing daily sweep

**When:** 38 · **Owner:** Convex `images.ts` (`COPY_TTL_MS`, `expireCopies`), `relay:cleanupExpired`

Every function treats a copy row older than 24 h as gone. The daily
`relay:cleanupExpired` sweep deletes such rows and fails any receiver still
`copying`. A scheduled delete per copy (`scheduler.runAfter`) would have kept the
Convex test harness's timer alive, so the suite hung.

- **Reach:** a copy can't take longer than a day.
- **Verdict:** sound. **Confidence:** medium.

### S14. A reservation is released according to where a failure came from, not its error code

**When:** review (replaces per-operation code lists from 28, 29, 34, 38) · **Owner:** `apps/relay/src/relay-wait.ts` (`Relayed.from`), the create/capture/copy handlers

`sandbox create`, `image create` and `image copy` first reserve rows in Convex,
then ask a Mac. If the Mac answers with *any* failure, the relay's dedupe keeps
that answer as final for the mutation id, so the reservation is released. The
same happens when the relay itself answered on a first call because no Mac
took the request. The reservation is kept only when the relay lost track of the
answer (`operation_uncertain`, "replay with the same mutation id") or the answer
is still pending. A replayed create releases only on the Mac's own answer.
`Relayed` carries `from: "machine" | "relay" | "lost"` to tell the cases apart.
Before this, each operation listed the codes that released, and leaked a
reservation for every code it forgot.

- **Verdict:** sound. **Confidence:** medium–high.

### S15. Create-with-copy is one host operation that follows the copy to the end

**When:** 39 · **Owner:** `SandboxCreateAfterCopy.swift`, kind `sandbox.create_after_copy`

`sandbox create --image rails --machine attic` (attic has no `rails`) makes the
target Mac journal a `sandbox.create_after_copy` operation. It is keyed by the
create's mutation id M, starts a copy keyed `M-copy`, and its subject is the
image. `image wait rails` on attic follows the image's most recent operation,
which is the create, so the wait shows the copy's progress (checked every 250 ms,
journaled only when it moved) and answers only once the sandbox exists and is
usable. A second create of the same image on the same Mac joins the running copy
instead of starting another (`images:startCopy` with `join`). The relay's
`image wait` keeps asking attic while a sandbox there is still `copying`, even
after the holding turned ready, because the copy finishes before the create does.

- **Alternative:** subject = the sandbox id, so `image wait` would end when the
  copy ends while the sandbox is still being laid down.
- **Verdict:** sound. **Confidence:** medium–high.

### S16. Pushing a new agent into a running guest

**When:** 32 (P5, Q11) · **Owner:** `SandboxRuntime` (agent update), `GuestAgentUpdater`, `ControlChannel`

On every connect and every idle tick, the host compares the guest's agent version
(from its ready frame) with its own build. On a mismatch it takes the sandbox's
operation lock and asks `guest.activity`. If any job is running, it defers, and
the guest also answers `deferred` if a job started meanwhile, since the host's
look and the push aren't atomic. Otherwise it sends the binary over the control
lane in 4 MiB chunks, each answered before the next one (30 s per answer, 60 s
for the last). The guest checks the digest, swaps the file and exits, and its
supervisor (systemd, or launchd on macOS) restarts it. The host redials the
request lane every 200 ms for up to 60 s until an agent answers *with the pushed
version*, because for a moment the old one still accepts connections. No answer
at all means the guest is lost. A refused push, or an agent that comes back on
another version, isn't pushed again until the next boot, so a fault that a retry
can't fix doesn't get tens of MiB resent every tick. The sandbox's next result
reports `agent_updated`, and host `system.info` reports `agent_version`. The host
re-reads `agent-version.json` whenever its modification time changes.

- **Verdict:** sound. **Confidence:** medium–high.

### S17. A Mac removes image files only if this same account listed them there before

**When:** 30 · **Owner:** `ImageHost` (`image.mirror`), `ImageStore` (`listed-by`), Convex `images:forMachine`

The connector subscribes to `images:forMachine`, the images this account says
this Mac holds, with each one's state, and pushes the list to the daemon
(`image.mirror`). The daemon removes an image only if this same machine id listed
it before (its `listed-by` mark), and never one with running work. Images it
doesn't recognise are reported `unknown`. Signing out removes the machine from the
account, and signing in again creates a new machine id. A plain "delete
whatever isn't listed" would therefore erase every image on a re-login.
`sandbox.mirror` follows the same rule. The list includes state, so that
`building → ready` re-sends it once the files exist and they get marked. An empty
list from a successful subscription does delete, because an account can delete its last image.

- **Verdict:** sound. **Confidence:** medium–high.

### S18. Where image instructions live, and how Xcode gets into a sandbox

**When:** 40 (L5) · **Owner:** `skills/localbox/SKILL.md`, `skills/localbox/references/images.md`

SKILL.md, the always-loaded part, gets a short Images section, the `--image`
line, and the new action and error codes. Saving, copying, deleting, macOS and
Xcode live in `references/images.md`, which is read only when needed. The Xcode
steps offer two ways in. Either the user signs in to Apple's developer download
page in the sandbox's browser themselves, or the user shares a `.xip` that the
agent serves once from the Mac on the sandbox network (bound to the sandbox's
gateway address) and fetches with `curl`. Then: `xip --expand`, accept the
licence, first launch, sign out, delete the `.xip`, save the image. Shared folders
aren't built, and this is the only way to get a file into a sandbox without a new
command. The skill also tells the agent to clear secrets before saving any image.
It has no kernel caveat, because EFI boot passed (L1).

- **Alternative:** `xcodes` with the Apple ID in environment variables, which puts
  the password in the agent's hands.
- **Verdict:** sound. **Confidence:** medium–high.

### S19. The site's new story is told with the existing drawings

**When:** 40 · **Owner:** `apps/site/content.mjs`, `.github/readme/header.png`, `apps/site/og.png`

The headline and subhead are the map's. The comparison table is titled "Better
than renting, safer than SSH", puts "Cloud sandbox" first, and has no macOS or
custom-image row, because some cloud sandboxes do offer those and the table
claims only what holds against the whole category. Images join the durable
feature ("Set up your way, still there next week"; eyebrow "saved setups"), and
macOS joins the boundary feature. The first feature is "Every Mac you own, already
paid for". Shell and Files merge into one capability card so the Images card keeps
the grid at six. The old tagline was painted out of the header art and the social
card, and the wordmark moved under the drawing's orange delivery curve. Phones get
stacked cuts of the wide drawings, served by a `<picture>` that the build adds for
any `<name>-mobile.png`. The README, which can carry text-only sections, also gets
"Set up your way" and "macOS sandboxes" sections.

- **Open for human review:** the mascot's role differs between drawings, and the
  hero's "sandbox" is a tray of sand. Fixing either needs new art.
- **Verdict:** sound. **Confidence:** medium–high.

---

## Sound: high confidence

Entries the user would almost certainly have chosen the same way. They are kept
because future work inherits them. Grouped by area.

### Catalog, routing and the relay

#### S20. Every `image.*` operation is an account operation, routed by an explicit per-operation table

**When:** 21, review · **Owner:** `packages/contract` (catalog routing column), `apps/relay/src/ops.ts` (`ACCOUNT_HANDLERS`, `CONTINUED`)

Convex owns the image record, so the CLI always sends image operations to the
agent API, never straight to its own daemon. `image.create`'s source sandbox
travels as input `from`, because the operation is about an image, not about acting
on that sandbox. Each operation names its route in the catalog: `ACCOUNT`
(answered from Convex alone), `ACCOUNT_THEN_MACHINE`, `ACCOUNT_THEN_HOLDERS`
(`image.delete`), or `ACCOUNT_THEN_SANDBOX`. One table, `ACCOUNT_HANDLERS`, keyed
by operation id, answers every account-executed operation. Anything else is
relayed unchanged to its sandbox's Mac or the resolved one. `image.wait` goes to
the one Mac whose holding (or chained create) is active. `image delete --machine`
uses the CLI's `--machine` routing flag on purpose (E5), never an input field. A
test checks the table's keys against the catalog rather than a runtime guard.
`hostOperationIds` (which operations the daemon's generated enum names) is: host
operations, plus account operations routed to machines or holders, plus
`sandbox.list` by name, because a signed-out CLI still lists local sandboxes.

- **Alternative:** a `host` executor for create, copy and wait, which would split
  ownership of the record.
- **Verdict:** sound. **Confidence:** high.

#### S21. "Exactly one of `from` and `macos`" is checked in code, not in JSON Schema

**When:** 21 · **Owner:** `packages/contract` (`ONE_OF_INPUTS`, `validateInput`)

`image create` takes either `--from SANDBOX` or `--macos`. A top-level `oneOf` in
a tool's input schema is refused by common model tool APIs that read the MCP tool
list, so the rule lives in `validateInput`, which both `validateRequest` and the
relay call. `macos` accepts only `true`.

- **Alternative:** two operations (`image.capture`, `image.build`), which renames
  commands the user chose (Q10).
- **Verdict:** sound. **Confidence:** high.

#### S22. One shape for "an image operation in progress", composed by the relay

**When:** 21, 26, 28 · **Owner:** `apps/relay/src/image-state.ts`, contract `ImageOperationState`

Calls about long image work return `ImageOperationState`, which has:

- `state`: `building`, `copying`, `ready` or `failed`.
- `progress`: phase, `done_bytes` and `total_bytes`. A phase without counts reads 0/0.
- `error`: `{ code, message, next_step }`, reusing the contract's error codes so
  the CLI renders it like any other error.
- `report`: the result lines.

The daemon owns progress (its operation record). Convex owns the name, OS and
whether a holder is `building` or `copying`. The relay combines the two, on the
first call and on every `{continue}`, so a wait that outlives one HTTP call reads
the same. When no Mac is working on the image, the relay answers from Convex
(`images:get`, which carries each holder's operation id and error), so waiting on
a failed image doesn't need an offline Mac. If a failed kind gave no next step,
the relay fills in a generic one ("delete and recreate").

- **Alternative:** the daemon composes the state, which would need the renamable
  name copied into every record.
- **Verdict:** sound. **Confidence:** high.

#### S23. A continued request finishes its answer the way its first call would have

**When:** review · **Owner:** `apps/relay/src/ops.ts` (`CONTINUED`), `relay:result`

A long call that outlives one HTTP request returns `{continue}`, and the client
calls again. The relay's stored request now comes back with its status, so the
continuation dispatches on the request's operation and rebuilds what the first
call knew from Convex: the reservation by mutation id for `sandbox.create`, the
reserved image for `image.create`, the copy row for `image.copy`. A continued
create reports with the replay's facts ("as the first create chose it").

- **Alternative:** keep the first call's facts in the relay row, a second store
  of what Convex already holds.
- **Verdict:** sound. **Confidence:** high.

#### S24. Image names: generated, reserved and resolved like sandbox names

**When:** 22, 30, review · **Owner:** Convex `images.ts` (`resolve`, `reserve`, `rename`, `setDefault`)

Without `--name`, an image gets an adjective-animal name from the same generator
as sandboxes (`sandboxName()`, e.g. `brave-walrus`), as in the map's samples.
`linux` and `macos` are built-in names: using either for an image is
`invalid_input`, and a name that is already taken is `name_conflict`. A lookup
matches the id exactly, else the name in any case, so `Rails-Dev` finds
`rails-dev`. `linux` and `macos` also match in any case. `macos` resolves to the
account's most recently built IPSW-based image. If there is none, the error says
`localbox image create --macos`. An unknown name lists the images that exist.

- **Verdict:** sound. **Confidence:** high.

#### S25. `image list` carries exactly the table's facts, and every image command says what it changed

**When:** 30 · **Owner:** `apps/relay/src/image-ops.ts`, `apps/cli` renderer, contract `ActionKind`

Each `image list` row is `{ name, os, size_bytes, from, on, default }`. `from` and
`on` are display strings (`sandbox bold-otter`, `macOS 27.0.1 IPSW`, `release`;
`attic (copying)`, `every Mac`). The text table formats sizes (`4.2 GiB`,
`-` until known) and marks the default `yes`, and a parity test checks each cell
against the JSON. Every image command takes a name, so ids and timestamps stay in
Convex. `image default` reports the default it replaced (new action
`made_default`). `image rename` reports both names. An unchanged name or default,
or a delete of an image that is already gone (a replay after the row was dropped),
answers `left_alone`, as `sandbox delete` does. The size formatter lives in the
contract (`sizeText`), so the relay and the CLI spell sizes the same way.

- **Verdict:** sound. **Confidence:** high.

#### S26. `sandbox create` says which image it used and why

**When:** 29 · **Owner:** Convex `images:get`, `apps/relay/src/sandbox-ops.ts`

`images:get` takes an optional image and, when none is given, resolves the
account default (else `linux`). The create route makes that one call and places
against the holders it returns. The result's `produced` gains `image` (the name)
and `image_reason` (`as asked` or `the account default`), and the Mac's `created`
action gains `; image NAME (REASON)`. The relay writes this because the daemon
knows only the id, and names can be renamed. `sandboxes:list` rows carry
`image_id`. Showing the image's name in `sandbox list` was left for later.

- **Verdict:** sound. **Confidence:** high.

#### S27. The macOS build's early refusals

**When:** 34, review · **Owner:** `packages/placement` `buildTarget()`, `apps/relay/src/image-ops.ts`, `MacBaseBuilder.begin`

Before reserving anything, the relay asks `buildTarget()` whether the requested
Mac can build: it must be online and report macOS 27 or later. Then the Mac
itself may refuse before journaling, with `image_incompatible` or `disk_full`,
putting the next step in `error.details.next_step`. The relay counts both as
definitive and releases the reservation. The relay can't know free disk or the
IPSW's size, but it does know the reported host version, so that refusal costs no
round trip.

- **Verdict:** sound. **Confidence:** high.

### Placement

#### S28. Placement reads image holdings from Convex rows, and is cautious when facts are missing

**When:** 29, 36, review · **Owner:** `packages/placement` (`place()`, `PlacementMachine`), contract `CapacityReport`, `BUILT_IN_IMAGE`

Each Mac's placement facts gain `holds` and `heldAt` (from its holder row) plus
`freeDiskBytes` and `macOSVersion` (from its capacity report). All of them are
optional, and an absent one reads cautiously:

- No free disk reported means no copy goes there. The error says it wasn't
  reported, and an unread free disk is `null`, never 0.
- No macOS version means no macOS image goes there.

A copy comes only from an online holder: the one whose holding changed most
recently, then by name. Offline holders only produce `machine_offline` naming
them, and no holder at all is `image_not_found`. `BUILT_IN_IMAGE = "linux"` is
spelled once in the contract, for Convex, placement and the relay. Placement no
longer counts running macOS guests: no caller ever fed it that number, and the
daemon's admission owns Apple's two-VM limit (S29).

- **Verdict:** sound. **Confidence:** high.

#### S29. Apple's two-macOS-VM limit is enforced at admission, on macOS guests only

**When:** 35, review · **Owner:** `SandboxHost` admission (`macOSRunningLimit = 2`)

A Mac may run at most two macOS VMs (E11). When a third macOS sandbox starts,
admission sleeps the least recently used *idle* macOS sandbox first, then runs
the usual memory admission on what is left. Linux sandboxes never count, because
sleeping one frees memory but not a macOS slot. A refusal names only the macOS
holders, says the limit is macOS's, and counts a running macOS build as one slot
("a macOS image build (it can't sleep)"). The other direction, a build starting
beside two sandboxes, goes through the same admission (S59).

- **Verdict:** sound. **Confidence:** high.

#### S59. A macOS image build takes its VM slot through the same admission as a sandbox start

**When:** review (redoes the unsound U1, which contradicted E11) · **Owner:** `SandboxHost.takeMacOSSlot` / `releaseMacOSSlot` (the one count, with `macOSRunningLimit = 2`), `MacBaseBuilder.takeSlot`

Apple lets one Mac run at most two macOS VMs at once, and E11 says a third gets
"sleep-for-room or `machine_full` with the reason, never a raw Virtualization
error". Say two macOS sandboxes, `a` and `b`, are running and you run
`image create --macos`. The build downloads the IPSW (Apple's macOS installer
file) first, which needs no VM. Just before its first boot (the install step),
it asks `SandboxHost`'s admission for a macOS slot, the same code a third macOS
sandbox start goes through:

```
take slot for build:
  if a and b both run nothing  -> sleep the least recently used one (say a), build proceeds,
                                  and its result says "made room for it: slept a (8 GiB) to make room"
  if both run jobs              -> the build fails machine_full:
                                  "building macOS image image_mac needs a macOS VM, and this Mac already
                                   runs 2 macOS sandboxes, the most macOS allows; none of them can sleep:
                                   a (8 GiB, 1 running job), b (8 GiB, 2 running jobs)"
```

The build holds the slot until it ends (finished, failed or stopped by a daemon
shutdown), and while it holds it a third macOS sandbox start counts it ("a macOS
image build (it can't sleep)"). `SandboxHost` keeps the only count: a set of the
builds holding a slot, next to the running macOS sandboxes. The builder keeps no
count of its own. A build that resumes after a daemon restart takes its slot again
the same way, after the sandboxes the last run left have come back. What slept for
it is kept in the build's checkpoint, so a resumed build still reports it.

- **Gap:** the review counted builds in a sandbox's admission, but a build never
  asked admission for its own slot.
- **Reach:** a failed `machine_full` build is final, like any failed build: you
  delete the failed image and build again, and the downloaded IPSW is kept. A
  build's VM takes a macOS slot but is not counted against the memory budget,
  as before.
- **Verdict:** sound (implements E11 in both directions). **Confidence:** high.

#### S60. One rule decides whether an image copy fits, and placement and the receiving Mac both use it

**When:** review (redoes the unsound U2, two owners of one rule) · **Owner:** `packages/contract` (`IMAGE_DISK_MARGIN_BYTES`, `imageDiskNeedBytes`), generated into `GeneratedOperations.swift`; used by `place()`, `ImageCopy` and `ImageCapture`

Say you create a sandbox from a 4 GiB image, and the only Mac with room for it,
B, has 4.5 GiB of free disk. A copy to B needs the image plus a 1 GiB margin,
5 GiB, so that a copy never fills the Mac. Placement checks exactly that, so it
doesn't plan the copy: it answers `disk_full` with the numbers ("B has 4.5 GiB
of free disk, and copying the image there needs 5 GiB"), or, for automatic
placement, puts the sandbox on a Mac that holds the image and lets that Mac make
room. With 5 GiB free, the copy is planned. Before this was redone, placement
checked only "free disk ≥ image size", planned the copy, and B then refused it,
leaving a failed sandbox.

The rule is written once, in the contract: `imageDiskNeedBytes(bytes)` is
`bytes + IMAGE_DISK_MARGIN_BYTES` (1 GiB). The daemon is Swift, so
`npm run generate:snapshots` writes the same constant and function into
`GeneratedOperations.swift`, next to the operation list it already generates.
The receiving daemon's check before a copy, and an image capture's check (the
source disk's allocated bytes plus the same margin), call the generated
function. Placement still sees a Mac's free disk only as of its last capacity
report, which moves only once it is a gibibyte off, so a Mac filling up between
reports can still refuse a planned copy. That refusal is the backstop, not the
rule.

- **Gap:** two slices each wrote their own "does it fit" rule.
- **Reach:** changing the margin is one edit in the contract plus a snapshot
  regeneration; the snapshot check fails if the Swift copy is stale.
- **Verdict:** sound. **Confidence:** high.

### Host operations (the journal of long work)

#### S30. One kind-agnostic journal for all long host work

**When:** 26, review · **Owner:** `HostOperationStore.swift`, `HostOperationKind`

Image capture, macOS build, copy and create-after-copy each run as an operation
in `HostOperationStore`, persisted as `HostOperationRecord` JSON under
`LOCALBOX_OPERATIONS`. A record holds a key (the mutation id), kind, subject,
state, `progress` (what callers see), and a `checkpoint`: free-form JSON holding
the kind's own resume point and any input the work needs. `begin` seeds the
checkpoint, so a restart before the first report can still resume. Kinds conform
to `HostOperationKind` and are registered with `operations.register(kind)`.
`begin` refuses a kind with no registered resumer. An unfinished record whose kind
no longer registers fails with `unsupported` at start, so a waiter isn't left
polling forever. The daemon resumes operations after `host.recover()`, because a
resumed capture may act on a sandbox, which must be back first. Timestamps are
integer milliseconds since 1970, which round-trip exactly.

- **Alternative:** an image-named record type, which would put image vocabulary
  into a generic owner.
- **Verdict:** sound. **Confidence:** high.

#### S31. An operation's subject is the image it produces, and `image wait` follows the image's newest operation

**When:** 26 · **Owner:** `HostOperationStore`, `ImageHost` (`image.wait`)

`image.wait`'s input is an image, not an operation key, and a retried copy or
build starts a new record for the same image. So every image kind begins with
`subject` set to the image id, and the daemon's `image.wait` follows that
subject's most recently started record. To prevent ties, each `begin` takes a
`started_at` later than any before it: now, or else the last one plus 1 ms.
Before that, two begins in the same millisecond made the wait follow the older one.

- **Alternative:** an `operation_id` input on `image.wait`, which every caller
  would have to carry.
- **Verdict:** sound. **Confidence:** high.

#### S32. How waiting works: bounded at 120 s, and builds also return on each phase

**When:** 26, 34 · **Owner:** `HostOperationStore.wait`, `ImageHost`, `apps/cli`

`wait` returns when the work finishes or the timeout passes. The timeout is
clamped to 0–120 000 ms rather than refused, which mirrors `job wait`, and each
answer carries the current progress. For `macos.build` only, a wait also returns
when the phase changes (the daemon asks with `untilPhaseChanges`), because a
build's phases last minutes and `image wait` should show each one. A capture's
phases last about a second, so `image create --from` doesn't answer `building`
mid-save. The daemon waits `min(timeout_ms, deadline_ms − 1 s)`. The CLI gives any
command with `--timeout-ms` a deadline of `timeout_ms + 5 s` (at most 120 s)
unless `--deadline-ms` is set, so the default 30 s deadline doesn't cut a 120 s
wait short. That applies to `job wait` too.

- **Verdict:** sound. **Confidence:** high.

#### S33. Finished operations reach Convex through an outbox

**When:** 26 · **Owner:** `HostOperationStore` (`reported_at`), connector `host.operations`

A finished record is listed to the connector on its next `host.operations` poll
until it is marked reported (`reported_at`). It is handed over again across
restarts of either the daemon or the connector, and never after it is marked.
That matters: if every outcome were re-sent on each connector start, a holder
row removed by `image delete --machine` would be brought back. An image the
account deleted meanwhile (`image_not_found`) counts as reported.
`HostOperationFailure` may carry a `next_step` (S22).

- **Verdict:** sound. **Confidence:** high.

#### S34. `HostDaemon` composes the daemon and routes requests

**When:** 26, review · **Owner:** `HostDaemon.swift`, `ImageHost.swift`, `SandboxHost.swift`

`HostDaemon` builds every part and routes each request: image operations (and the
connector's internal image requests) to `ImageHost`, the rest to `SandboxHost`.
`ImageCapture` and `SandboxCreateAfterCopy` need `SandboxHost`. Earlier,
`SandboxHost` held `ImageHost` to route to it, a cycle closed with setters. Now
every part gets what it needs at init, `SandboxHost` holds no image parts and does
no image file I/O, and it starts a create-after-copy through the journal.
`localbox-hostd`, vmlab and the tests all wire through `HostDaemon`.

- **Verdict:** sound. **Confidence:** high.

#### S35. Dev daemons can run a fake operation and fake their free disk

**When:** 26, review · **Owner:** `SleepStepsOperation.swift`, `ImageStore(freeBytesOverride:)`, `localbox-hostd` (`LOCALBOX_DEV=1`)

With `LOCALBOX_DEV=1`, the daemon registers a fixture operation kind,
`sleep_steps`, and answers `host.begin_operation`, just as `host.simulate_power`
is dev-only. Proofs use it to kill and restart a daemon mid-operation.
`LOCALBOX_DEV_FREE_DISK_BYTES` fixes the free disk that capacity, capture, copy
and build all see. It works through a closure on `ImageStore`, the single owner
of free disk (`freeBytes()`), so a test can also change the value while running.

- **Verdict:** sound. **Confidence:** high.

### Image files on a Mac

#### S36. Images are committed by one rename, and temporaries belong to the operation that runs them

**When:** 24, 34, 37, 38 · **Owner:** `ImageStore.swift` (`reserveTemp`, `resumableTemp`, `commit`, `remove`, `sweepTemps(keeping:)`, `discardTemps`)

An image is written into a dot-named temporary folder, then committed with
`renamex_np(RENAME_EXCL)`, which never replaces an existing image. A delete first
renames the image to a dot temporary and then removes it, so a crash mid-delete
leaves only a temporary, never half an image that `list()` would show. On start,
the daemon sweeps dot entries, except `.ipsw/` (V3) and every `.<subject>.*`
whose subject has a running operation (`HostOperationStore.runningSubjects()`).
A resuming build or copy therefore finds what it left, including the transfer's
resume bitmap beside the copy's temporary. A copy receives into
`.<image>.resume-<key>` and commits that folder in place. A failed operation
removes its own temporaries. A resumed capture clears its old ones and retakes the
clone from the start, because the sandbox's disk has moved on.

- **Alternative:** each kind declares its temp names, which would put kind
  knowledge into the store.
- **Verdict:** sound. **Confidence:** high.

#### S37. Making a sandbox from an image

**When:** 23, 24, 29 · **Owner:** `AppleSandboxFactory.provision`, `ImageStore.cloneForSandbox`, `SandboxHost.create`

`provision` is `async`. The `SandboxHost` actor awaits it, which leaves the actor,
so a full copy on a disk that can't clone doesn't block every other request. An
in-flight set answers `conflict` to a re-run create while the first is still
provisioning. `cloneForSandbox` returns the manifest, the boot store, and whether
the disk was cloned or copied, from a single read that can't race a delete, so a report never claims a
clone it didn't get. `provision` sets the record's OS from the manifest, and
`SandboxHost` names only the image id. A missing image throws `ImageNotHere`,
answered as `image_not_found`, which the relay treats as a definite failure and
releases the reservation. The process fixture backend (tests' fake VM) reads no
image files and just records the id.

- **Verdict:** sound. **Confidence:** high.

#### S38. The development Linux image is built and cloned like the shipped one

**When:** 24, 25 · **Owner:** `packages/vm-image/scripts` (`create-efi-vars.swift`, `--out`), `scripts/proof/lib/linux-image.ts`

The EFI variable store is created by a small script run with `swift`. Only
Virtualization writes that format, creating one needs no entitlement, and fresh
stores are byte-identical, so the image build needs no signed binary. The build
cache is `dist/vm-image/<profile>/disk.img`. `--out` assembles an image folder
from the cache by APFS clone. Proofs build the dev image once and give every
probe machine its own `images/linux` through `installLinuxImage`, the install's
own code. `stack up` wipes sandboxes and operations along with the Convex account,
but never `images/`, because image files belong to the Mac.

- **Verdict:** sound. **Confidence:** high.

### VM configuration

#### S39. One `VMSpec` and one translator build every VM

**When:** 23, 24 (replaces 15's lab closure) · **Owner:** `VMSpec.swift`, `AppleVirtualizationBackend(spec:sandboxID:name:)`, `GuestPlatform.devices(for:)`

Every VM, sandbox or lab, is described as a `VMSpec` and turned into a
`VZVirtualMachineConfiguration` by one translator. The devices come from one list
per OS (`GuestPlatform.devices(for:)`), so a rule like "macOS gets no entropy
device" (E9) is a pure assertion. The Linux direct-kernel path, `SandboxArtifacts`
and the lab-only configuration closure are gone. vmlab builds its experiments as
`VMSpec`s too, so every lab boot uses the production translator. `build` validates
the configuration. Unit tests inspect the unvalidated configuration, because
`validate()` refuses in any process without the virtualization entitlement, and
`swift test` runs unsigned.

- **Verdict:** sound. **Confidence:** high.

### Freeze and capture

#### S40. The freeze runs on its own lane and under the sandbox's operation lock

**When:** 27 (P10, E1, E2) · **Owner:** `SandboxRuntime.freezeAndClone`, `ControlChannel`

The control lane (vsock 1025) is dialled once per exclusive operation (freeze or
agent update), not held for the sandbox's life, because a held connection would
need its own reconnect handling after every restore. `freezeAndClone` takes an
async body that returns a value, so the clone runs off the runtime actor, and
status reads, the idle tick and admission see `.freezing` instead of waiting on it.
It returns `FrozenClone { value, stallMs }`. The stall is timed on the host's
clock from asking the guest to freeze until its thaw answered, because the guest's
clock stops while the VM is paused. Requests, bring-ups, stops, saves and resizes
wait for the operation lock, and `.freezing` reports state `running`. Shutdown
waits for a freezing sandbox and saves it once it thaws. The process fixture has
no control lane, so `freezeAndClone` on it answers `unsupported`.

- **Verdict:** sound. **Confidence:** high.

#### S41. Saving an image: stopped sandboxes are cloned as they lie, everything else is woken and frozen

**When:** 28 (P2, Q8) · **Owner:** `ImageCapture.swift`

A stopped (or errored) source is cloned under the runtime's operation lock
(`cloneWhileDown`), so a start can't race the clone. Any other source goes through
admission first, which wakes a sleeping sandbox and does nothing to a running one,
and is then frozen. A woken source stays running. Branching on the lifecycle
outside the lock would race a start or sleep between the look and the clone. The
first step checks free disk: the source disk's and boot store's allocated bytes
plus a 1 GiB margin, because the clone starts nearly free but can grow to the
whole disk as the sandbox writes. A failure there is a failed holder with a next
step, like any capture failure. The phases are `checking_disk`, `saving`,
`committing`, with no byte counts, since an APFS clone has no meaningful progress.
The image's `agent_version` is the running guest's, else the source image's, else
`unknown`. The host pushes its own agent anyway (S16).

- **Verdict:** sound. **Confidence:** high.

#### S42. `image create --from` usually answers `ready` in one call, with the result lines

**When:** 28 · **Owner:** `ImageHost` (`image.create`), `apps/relay/src/image-state.ts`

The daemon's `image.create` waits for the capture (until a second before the
request's deadline), so a save, which takes seconds, usually answers `ready` the
first time. A slow one answers `building` and is followed with `image wait`. The
relay writes the result lines from the record (`size_bytes`, `stall_ms`, `woke`,
`made_room`) and from Convex (name, OS, source, holder Mac). The map's four sample
lines hold word for word for a running source. A stopped source says it was saved
"as it lay, without a freeze". A woken one says it "woke from sleep, then froze
for N s". Each sandbox slept to make room gets a `made room for it:` line.

- **Verdict:** sound. **Confidence:** high.

### Guest agent

#### S43. The agent's version is the release plus a digest of both binaries

**When:** 31, 32 (32 replaced 31's rule) · **Owner:** `scripts/build-guest-agent.ts`, `agent-version.json`

`agent-version.json` is `{ version: "<release>+<12 hex>", sha256: { linux, darwin } }`.
The agent embeds its version, which it announces in its ready frame, but embedding
it changes the binaries. So the build compiles twice: first with an empty version,
whose two digests make the 12 hex characters (sha256 over
`linux:<sha>\ndarwin:<sha>\n`), then again with that version embedded. `sha256`
names the shipped, second binaries. The same sources still give the same version,
and any change to either binary or the Bun runtime makes a new one. The image build
compiles the agent before hashing its inputs, and hashes only the binary the
Dockerfile copies, so a cache hit can never be a stale agent.

- **Alternative:** a digest of the source bundle, which misses a Bun runtime change.
- **Verdict:** sound. **Confidence:** high.

#### S44. The ready frame names the agent's version and OS

**When:** 32 (L4) · **Owner:** `packages/guest-gateway`, `FramedGuestChannel`

When the agent connects, its ready frame now carries `agent_version` and
`agent_os`. The host learns which binary to push from the guest itself, rather
than threading the OS in from the backend.

- **Verdict:** sound. **Confidence:** high.

#### S45. The darwin agent: where it keeps state, and how it sets identity and the clock

**When:** 33 · **Owner:** `apps/guest-agent/src/identity.ts`, `index.ts`, `apps/guest-agent/darwin/`

macOS's system volume is sealed and read-only, so the darwin system role keeps
its mutation journal and job logs under `/var/db/localbox` (`mutations/`,
`jobs/`), next to its identity marker `/var/db/localbox/sandbox-id`. The first
real-guest run failed every mutation with `EROFS`. Linux keeps its defaults. A new
sandbox identity sets the name with
`scutil --set HostName|LocalHostName|ComputerName`. macOS has no machine-id, and
each clone already gets its own `VZMacMachineIdentifier` (E10). The clock is
stepped with BSD `date -u MMDDhhmmCCYY.SS`, which is accurate to the second.
`LOCALBOX_DESKTOP_BACKEND` picks who answers desktop calls: `x11` (Linux),
`macos` (forward to the desktop role), or unset (the test fixture). The darwin
launchd units and `install.sh` live in `apps/guest-agent/darwin`.

- **Verdict:** sound. **Confidence:** high.

#### S46. The macOS desktop is driven by a small Swift helper, one process per call

**When:** 33 (replaces spike 18's `localbox-tccprobe`) · **Owner:** `Sources/localbox-desktop/main.swift`, `packages/desktop/src/macos.ts`

ScreenCaptureKit is an async Objective-C API that a Bun binary can't reach, and
the older `CGDisplayCreateImage` is obsolete. So the desktop role spawns
`localbox-desktop` once per call (capture, move, click, scroll, key, type).
TCC holds the spawning agent responsible, so the agent's grants cover the helper.
The helper is mechanical: key names, scroll direction and encodings are decided in
TypeScript (`macKey`, `MacSurface`), and the helper takes raw key codes, wheel
values and a JPEG quality and scale. That keeps the decisions testable without a
Mac session.

- **Alternative:** a long-lived helper over stdio, or a native addon.
- **Verdict:** sound. **Confidence:** high.

#### S47. Resize on macOS lists only the sandbox's own processes

**When:** 35 · **Owner:** `SandboxRuntime` (resize report)

A resize restarts the guest, and the report lists what was running (at most 20
names). A macOS guest runs hundreds of system daemons that restart with it. So on
macOS the report leaves out Localbox's own processes (under
`/usr/local/localbox/`) and system binaries under `/System/` and `/usr/libexec/`.
Linux lists its services as before.

- **Verdict:** sound. **Confidence:** high.

#### S48. Opening a guest lane dials again if it closes before the ready frame

**When:** 35 · **Owner:** `GuestLane.open` (`FramedGuestChannel.swift`)

A macOS guest restored from saved state accepts the first vsock connection and
closes it at once, while a dial a second later attaches. A wake from sleep fell
back to a cold boot and lost every process. So, on every boot, restore and
reconnect, opening a lane dials again until the usual 120 s deadline whenever the
connection closes before the agent's ready frame. Any other failure still ends the
attach at once. Linux attaches the first time, so the rule costs it nothing.

- **Verdict:** sound. **Confidence:** high.

#### S49. One frame reader for every guest lane

**When:** review · **Owner:** `readGuestFrames` (`packages/guest-gateway`), used by the request lane, control lane and desktop link

The request lane, the control lane and the macOS desktop link all read
length-prefixed frames through one reader, each with its own frame limit (the
request lane also has a buffer limit). The control lane now checks every frame's
length, not only the first frame in a chunk.

- **Verdict:** sound. **Confidence:** high.

### Transfer library and copies

#### S50. The wire format: one seal per datagram, and the receiver drives everything

**When:** 20, 37 · **Owner:** SwiftPM target `ImageTransfer` (`Wire.swift`, `Sender.swift`, `Receiver.swift`)

Each datagram is sealed on its own with ChaCha20-Poly1305. Its clear 12-byte
header (session, kind, stream, chunk, fragment or sequence) is the nonce, so the
header is authenticated without being sent twice, and a retransmission repeats a
nonce only with byte-identical plaintext. The sender answers HELLO with the
manifest's digest and sends exactly the fragment ranges each REQUEST names. Loss
detection, retransmission, resume and verification all live in the receiver,
so the sender keeps no per-receiver state and a restarted receiver simply asks
again. All-zero chunks (found with `SEEK_DATA` plus a word-wise check) are listed
in the manifest and never sent, and the receiver `ftruncate`s files to full size so
they stay holes. The resume bitmap is saved without fsync: on APFS an fsync blocks
concurrent writes to the same file and stalled the whole window. A resume re-hashes
every chunk the bitmap claims, which also survives power loss.

- **Alternative:** seal whole 1 MiB chunks (one lost datagram costs a megabyte);
  TCP-like acknowledgement windows on the sender.
- **Verdict:** sound. **Confidence:** high.

#### S51. The transfer library's shape

**When:** 37, 38 · **Owner:** `ImageTransfer` (`Transport`, `DatagramPort`, `PathSelector`, `TransferManifest`), SwiftPM target `ImageCopyTransfer`

- `Transport` is a strategy for finding candidates over one shared
  `DatagramPort`, not a socket of its own. Both the LAN and the punched transport
  use the same port, because the STUN mapping belongs to that port and the first
  authenticated reply picks the path. `DatagramPort` is the socket boundary:
  Network.framework in production, an in-memory network in tests.
- `Sender.send` and `Receiver.receive` are async. Answers arrive as an
  `AsyncStream`, so the sender can punch toward every new answer while it serves.
- The manifest covers every regular file under the image folder, sorted by path,
  so the library knows nothing about the image layout. The receiver refuses a
  manifest path that is absolute, empty, contains `.`, `..` or empty components,
  or repeats, and a chunk list that doesn't match its file size, even though the
  manifest is authenticated.
- The receiver tries only candidates its selector has a transport for, tries a
  peer-reflexive candidate (a punch that already arrived) at once, and
  de-duplicates by address.
- Shipped code has no tamper hooks: punchlab wraps its socket in a
  `TamperingPort`, and tests tamper inside the in-memory network.
- The daemon adapter is its own target, `ImageCopyTransfer`, depending on
  `HostDaemonCore` and `ImageTransfer`. `ImageTransfer` never imports
  `HostDaemonCore`. Every daemon, dev and release, uses the real adapter, STUN
  included, and the loopback stand-in exists only in tests.

- **Verdict:** sound. **Confidence:** high.

#### S52. A copy's key and role reach each Mac through its own subscription, never in the relayed request

**When:** 38 (E8) · **Owner:** Convex `images:copiesForMachine`, connector, daemon `image.copy_rendezvous` / `image.copy_outbox`

The relay calls Convex as the caller (an agent), and the key must be readable only
with the two machines' credentials. So the relayed input stays the public
`{ image, to }`, with both resolved to ids. Each Mac's connector subscribes to
`images:copiesForMachine` and hands the key and the Mac's role (sender or
receiver) to its daemon. Local candidates go out the other way through the
daemon's outbox long poll, acknowledged by generation. That outbox also names
operations whose work has no rendezvous yet (after a daemon restart), once each.
An idle Mac makes no Convex calls.

- **Verdict:** sound. **Confidence:** high.

#### S53. What a finished copy means is decided in Convex, by the receiver's outcome

**When:** 38, review · **Owner:** Convex `images:endCopy`, `cancelCopy`, `expireCopies`

Both Macs journal a copy as kind `image.copy`, with the image as subject. The
receiver's outcome sets the copy (`copied` or `failed`) and its holding (`ready`
or `failed`). A sender's failure fails the copy so the receiver stops waiting, but
never touches a holding: a failed send must not mark the source's image failed. A
late outcome leaves alone a holding that another operation now owns (checked by
`operationId`, as `cancelCopy` and `expireCopies` do), but still writes a missing
holding, so a receiver's committed files get listed. A sender ends successfully as
soon as the row says `copied`, rather than serving until its idle timeout and
journaling a failure for a copy that worked. A copy forgets its row and progress
clock when its work ends, but keeps its unacknowledged candidates until the
account stops listing the copy, so the receiver's last candidates still reach the
sender.

- **Verdict:** sound. **Confidence:** high.

#### S54. `image copy` answers at once

**When:** 38 · **Owner:** `apps/relay/src/image-ops.ts`, `ImageCopy`

`image copy NAME MACHINE` (or `--to MACHINE`) answers immediately with the
receiver's record (`copying`), and `image wait` follows it. A replay after the
copy finished answers from the copy row. A target that already holds the image
answers `ready` ("already on M; nothing to copy") without making a copy row. If a
side never took the request, the copy is cancelled and the target's holding
dropped. An uncertain answer keeps both and names the mutation id to replay.
`linux` is never copied (P1). Before receiving, a Mac checks it has the image's
size plus a 1 GiB margin free, by the same rule placement plans with (S60).

- **Verdict:** sound. **Confidence:** high.

#### S55. A sandbox whose image is copying: who answers, and what the first answer says

**When:** 39 · **Owner:** `apps/relay/src/sandbox-ops.ts`, Convex `sandboxes` (`copyOperationId`, `pending`, `pendingError`)

Convex must answer for a sandbox whose Mac may be offline and hasn't created it
yet. So the row carries `copyOperationId`, `pending` (`copying` or `failed`) and
`pendingError`, and reads `pending` until the Mac's `sandboxes:endCreate` clears
or fails it. The relay answers `sandbox_not_ready` itself, without relaying the
operation. It reads the progress from the target's journal with a 1 ms
`image.wait`, and if the Mac doesn't claim that within 3 s it says "the copy has
not reported progress yet". The first answer to the create is a new `waiting`
action: "sandbox S on B is waiting for image X to copy (SIZE); localbox image wait
X". When it is done, `image wait X` prints the copy line, "created sandbox S on B:
…" and "run a command in it: localbox shell exec --sandbox S -- CMD". The chained
create's result carries the copy's own result, so the copy line doesn't depend on
the copy's outcome reaching Convex first. (Which operations refuse is N8.)

- **Verdict:** sound. **Confidence:** high.

### macOS build mechanics

#### S56. A macOS build resumes from its last finished phase

**When:** 34 · **Owner:** `MacBaseBuilder` (`checkpoint`, `MacBuildDirectory`)

The build's checkpoint is `{ phase, ipsw: { url, version, build, size_bytes }, made_room }`
(`made_room`: the sandboxes slept for its VM slot, S59).
It works in a fixed folder, `images/.<id>.build/`, which holds the pristine
installed disk and auxiliary storage next to the working copies, laid out like an
image so that committing is a single rename once the private files are gone. A
resume finds what the last run installed. Because the provisioning password died
with the old process, `provision` restarts from a fresh clone of the installed
disk instead of reinstalling, which would cost four minutes.

- **Verdict:** sound. **Confidence:** high.

#### S57. VNC reads during the Recovery step wait as long as the step they serve

**When:** review · **Owner:** `VNCClient.swift`, `RecoveryVNC`

Virtualization's VNC server answers a screen-update request only once the screen
changes, and says nothing during the handshake until the guest's display is up. So
a read is bounded by the wait it serves: `waitForText`'s deadline caps every read
under it, any other read waits at most 120 s, and the handshake waits up to 300 s.
A fixed 30 s cap per read broke on a static desktop and on a booting Recovery.

- **Verdict:** sound. **Confidence:** high.

### Proof harness

#### S58. How macOS and multi-daemon behaviour is proven

**When:** 16, 24, 26, 34, 35, review (P8) · **Owner:** `scripts/proof/run.ts`, `scripts/proof/lib`, `localbox-vmlab`

Tier `m` runs real macOS guests, with the IPSW and an installed base cached.
Real-VM probes drive a real daemon over its socket (`realDaemon`), not the whole
stack, because the relay path is covered at tier `u` with a fake connector.
`stack.ts restart --machines b` kills a daemon and restarts it on the state it
left. vmlab keeps `macos-tcc` and `macos-vsock`, the only proofs that an agent
update keeps its TCC grants and that the darwin forwarder survives reconnects,
and dropped commands that had no probe. `macos-tcc` installs and grants through
the build's own payload and `tccScript`, which therefore stay public.

- **Verdict:** sound. **Confidence:** high.

---

## Compressed: trivial discretion

Twelve cosmetic or internal calls, each sound at high confidence:

- The site's FAQ icon is two CSS bars with no transition.
- Page copy gets curly apostrophes at build time, while `llms.txt` and the agent
  view stay ASCII.
- Copy may carry `[label](url)` links, used once.
- The "no monthly bill" doodle was removed and the fleet drawing re-centred.
- The sign-in code reads "a 6-digit code emailed to you", and the positioning rule
  says so.
- The boundary feature's body says "a computer of its own".
- The two-Mac runbook writes its marker to `/var/tmp`.
- The transfer debug switch is `LOCALBOX_TRANSFER_DEBUG`.
- The executor test was renamed `tests/catalog-routing.test.ts`.
- The build cache is named `<profile>/disk.img`.
- `tests/agent-binary.test.ts` drives the binary over stdin and stdout.
- The admission tests stay in `HostDaemonCoreTests`.
