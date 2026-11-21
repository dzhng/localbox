# Host daemon

`SandboxHost` is the only owner of this Mac's sandboxes. Each lives in its own
directory under `LOCALBOX_SANDBOXES` (`machinePaths().sandboxes/<id>/`):
`sandbox.json` (the catalog identity, mirrored read-only, plus the runtime the
daemon owns; its fields are
[`SandboxRecord`](Sources/HostDaemonCore/SandboxRecord.swift)'s), `disk.img` (an
APFS clone of its image's disk; a copy where cloning is unsupported, which the
create report says), its own copy of the image's boot store and its save file
while hibernated. Each sandbox has its own
`SandboxRuntime`: its backend, guest channel, channel epoch and lifecycle.
Every sandbox-scoped request is routed by `sandbox_id`; an id with no
directory, or one the account catalog no longer lists, is refused
`sandbox_not_found`. It routes on `HostOperation`, which
`npm run generate:snapshots` writes from the contract catalog; every other
operation goes to that sandbox's guest.

The connector's `sandbox.mirror` push (`source: catalog` with its
`machine_id`, the signed-in machine's subscription) follows the catalog's names
and records which machine's catalog listed each sandbox. A sandbox this
machine's catalog listed before and no longer does (deleted while this Mac was
offline) is deleted here, disk included, and reported; one it never listed
(created and not yet listed, or listed by an earlier sign-in) is only hidden. `localbox logout` pushes `source: signed_out`, which
hides every sandbox and deletes nothing. A push never creates a directory.

A VM is described by a pure `VMSpec` (platform and machine identifier, boot
store, CPUs, memory, disk, MAC, devices from `GuestPlatform`), built from the
record and the sandbox's directory alone, and `SandboxConfigurationBuilder` is
the one translator from it to a Virtualization configuration: every VM the
package boots, sandbox, macOS build or lab, goes through it, so a device or
boot setting changes in one place. Nothing in a spec
comes from the environment, so a saved state always restores into the
configuration it was saved under. Linux boots EFI firmware from the sandbox's
own variable store, with GRUB and the kernel on its disk, so there is no kernel
command line and an `apt` kernel upgrade takes effect on the next boot. The
guest learns its identity from the `hello` frame (sandbox id and name); a rename
sends a new `hello`. A resize of a running sandbox
restarts it and reports the processes that ended.

On SIGTERM the daemon saves every running sandbox and the next start restores
it (`woke`). Where saving fails (the screen is locked and its lock asks for a
password) or the backend cannot save (the process fixture), it stops the sandbox
and records why; the next start cold-boots it and reports `cold_booted` with
that reason.

`ImageStore` is the only code that touches image files on a Mac; anything else
that needs an image's disk, boot store or manifest asks it.
`LOCALBOX_IMAGES` (`machinePaths().images/<id>/`) holds `image.json` (its fields
are `ImageManifest`'s, in [`ImageStore.swift`](Sources/HostDaemonCore/ImageStore.swift)),
`disk.img` and `boot/`. An image is written into a dot-prefixed
temporary directory and committed by one rename, so nothing ever reads half an
image, and each start sweeps the temporaries a crash left, except those of an
image whose operation is still running (`.<id>.*`, kept for its resume) and the
IPSW cache (`.ipsw/`). A sandbox is
provisioned from an image off the `SandboxHost` actor and keeps its own disk
clone and boot store, so deleting the image never breaks it; `SandboxHost`
itself does no image file I/O and learns free disk only through capacity.
The one exception is the built-in `linux` image, which the installer writes
([releasing](../../../DEVELOPMENT.md#releasing)); the daemon reads it like any
other.

`HostOperationStore` is the only owner of long host work (each kind is a type
with a `kind` and a resumer, such as `MacBaseBuilder` or `ImageCopy`), separate
from `SandboxHost` so that work never queues behind a
sandbox request or holds one up; each work runs detached, off both actors. Its
journal is `LOCALBOX_OPERATIONS` (`machinePaths().operations/<mutation_id>.json`),
written before the work starts and at every checkpoint the work reports. The
mutation id is the key: a replay returns the record already there, running or
finished, and never starts the work again. Callers poll with `wait`, which
answers when the work finishes or after at most 120 s with the record as it
stands, so a pending state is an answer, not a timeout. Each kind registers one
resumer at daemon start; an unfinished record continues from its last
checkpoint, and one whose kind is no longer registered fails. A macOS build's
waits also answer when it moves to its next phase, so `image wait` shows each.

`MacBaseBuilder` (kind `macos.build`) builds the account's macOS base from
Apple's latest IPSW with no human step: download (resumable, into the IPSW
cache), install, a provisioning boot with a random password and Remote Login,
the darwin agent and Chrome over SSH, `csrutil disable` in Recovery, then TCC
grants and Remote Login off through the agent's own shell. The password lives
only in the builder's memory, so a restart before SIP is off begins again from
a fresh clone of the installed disk. Every macOS VM outside a sandbox is a
`MacVirtualMachine` made from a `VMSpec`, and the provisioning steps
(`MacProvisioning`) are the ones `localbox-vmlab`'s macOS labs call. Typing
into Recovery uses Virtualization's private VNC server, and
`RecoveryVNC.swift` is the only file that touches private Apple API: a macOS
update that breaks it breaks one file, and nothing else depends on it.

Images move between Macs as host operations on both ends. `ImageCopy` is one
side of a copy: the sender serves its `ImageStore` files, the receiver writes a
resumable temporary and commits it like any other image. Each side's role and
the copy's one-time key come from its Convex row through the connector; the key
is never journaled, so a resume waits for the row again.
`SandboxCreateAfterCopy` chains a `sandbox create` to the receiving side, so a
create on a Mac without its image waits on the copy and then creates as usual. The bytes are a separate SwiftPM target, `ImageTransfer` (chunks,
sealed datagrams, resume, the LAN and hole-punched paths), which never imports
`HostDaemonCore`, so the transport is tested and driven without a daemon;
`ImageCopyTransfer` is the one adapter between them. The other executables are
`localbox-punchlab` (a transfer driven by hand, and probe 20's driver), and
`localbox-vsock` and `localbox-desktop`, which run inside darwin guests, not on
the host. What a copy exposes on the network is in the
[security model](../../../SECURITY.md#direct-image-copies).

`AuthenticatedLocalIPC` is the local CLI boundary: it checks the injected
owner-only IPC token and forwards the envelope to `SandboxHost.request` without
duplicating lifecycle state.

`UnixDomainSocketServer` is the launchd-compatible local transport around that
seam. It creates the configured socket path (expanding `~`), refuses to replace
an unrelated file, applies owner-only `0600` permissions, and serves one
big-endian length-prefixed JSON request per connection. The response carries
`envelope` on success or a stable transport `error` code; the codes live in
`Sources/HostDaemonCore/LocalIPC.swift`. The listener is non-blocking while
accepted connections use blocking reads on detached tasks, so a slow CLI
cannot stall other clients. `stop()` cancels the listener and removes the
socket path; launchd packaging can own process startup and call the same
server lifecycle in the signed product bundle.

`AppleVirtualizationBackend` runs one sandbox's VM for one boot on its own
dispatch queue and attaches the framed `GuestService` channel over vsock.
There is no reset: delete and create replace it.

A guest has two lanes. Requests travel on vsock port 1024, one at a time and
with no timeout, and the guest journals their mutations to its disk. Freeze and
thaw travel on the control lane, port 1025 (`ControlChannel.swift`, twin of
`packages/guest-gateway/src/control.ts`), dialled per operation, every answer
under a deadline, so they never queue behind a request or write to the disk
they freeze. `SandboxRuntime.freezeAndClone` holds the sandbox's operation lock
and runs lock, freeze, pause, body, resume, thaw, unlock; resume, thaw and
unlock run on every path, and the guest thaws itself after the freeze's timeout
if the host never does. While it runs the sandbox is `.freezing`: requests,
starts, stops, saves and resizes wait for the lock; admission never sleeps it
for room and the idle policy passes it by; shutdown saves it once it thaws.

`GuestAgentUpdater` holds every guest to the agent build this Mac ships
(`LOCALBOX_GUEST_AGENT`: `agent-version.json` and one binary per guest OS,
read again whenever the file changes). A guest whose ready frame names another
version gets the host's binary over the control lane, on connect and on each
idle tick, under the operation lock and only while it serves no request and
runs no job. Once the guest answers `updated` its request lane's close is
expected: the runtime dials it again instead of losing the guest, and the
sandbox never stops. A version the guest refuses is not pushed again until the
next boot; an agent that does not come back loses the guest like any other
close.

The `localbox-hostd` executable is the launchd process boundary. It reads
the sandboxes, operations and images directories and an owner-only IPC
token file from environment variables, starts the same `SandboxHost` and
`UnixDomainSocketServer` used by tests, brings back what the last run left
running, and hibernates on `SIGTERM`/`SIGINT` (the plist's `ExitTimeOut` bounds
the saves). The checked-in
`Resources/com.localbox.hostd.plist` is a bundle template; an installer
must materialize its paths, create the token file with mode `0600`, load it with
`launchctl`, and unload it before replacement.

`scripts/install-release.sh` does that materialization in a versioned release
root; the [development guide](../../../DEVELOPMENT.md#installing-rolling-back-and-uninstalling)
covers install, rollback and uninstall.
