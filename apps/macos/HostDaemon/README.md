# Host daemon

`SandboxHost` is the only owner of this Mac's sandboxes. Each lives in its own
directory under `LOCALBOX_SANDBOXES` (`machinePaths().sandboxes/<id>/`):
`sandbox.json` (the catalog identity, mirrored read-only, plus the runtime the
daemon owns: image and OS, size, MAC, machine identifier, a macOS hardware
model, lifecycle, a pending cold boot), `disk.img` (an APFS clone of its
image's disk; a copy where cloning is unsupported, which the create report
says), its own copy of the image's boot store (`efi-vars`, or `aux.img` for
macOS) and `state.vzsave` while hibernated. Each sandbox has its own
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
the one translator from it to a Virtualization configuration. Nothing in a spec
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

`ImageStore` is the only code that touches image files on a Mac:
`LOCALBOX_IMAGES` (`machinePaths().images/<id>/`) holds `image.json` (id, OS,
size, a macOS hardware model and minimum version, the agent version it
carries), `disk.img` and `boot/`. An image is written into a dot-prefixed
temporary directory and committed by one rename, so nothing ever reads half an
image, and each start sweeps the temporaries a crash left. A sandbox is
provisioned from an image off the `SandboxHost` actor and keeps its own disk
clone and boot store, so deleting the image never breaks it; `SandboxHost`
itself does no image file I/O and learns free disk only through capacity.

`HostOperationStore` is the only owner of long host work (an image build, copy
or capture), separate from `SandboxHost` so that work never queues behind a
sandbox request or holds one up; each work runs detached, off both actors. Its
journal is `LOCALBOX_OPERATIONS` (`machinePaths().operations/<mutation_id>.json`),
written before the work starts and at every checkpoint the work reports. The
mutation id is the key: a replay returns the record already there, running or
finished, and never starts the work again. Callers poll with `wait`, which
answers when the work finishes or after at most 120 s with the record as it
stands, so a pending state is an answer, not a timeout. Each kind registers one
resumer at daemon start; an unfinished record continues from its last
checkpoint, and one whose kind is no longer registered fails.

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
