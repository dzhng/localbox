# Host daemon

`SandboxHost` is the only owner of this Mac's sandboxes. Each lives in its own
directory under `LOCALBOX_SANDBOXES` (`machinePaths().sandboxes/<id>/`):
`sandbox.json` (the catalog identity, mirrored read-only, plus the runtime the
daemon owns: size, MAC, machine identifier, lifecycle, a pending cold boot),
`disk.img` (an APFS clone of the template; a copy where cloning is
unsupported) and `state.vzsave` while hibernated. Each sandbox has its own
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
hides every sandbox and deletes nothing. A push never creates a directory. `SandboxConfigurationBuilder` is the only place a VM configuration is
made, from the record and the shared boot artifacts, so a saved state always
restores into the configuration it was saved under. The guest learns its
identity from the `hello` frame (sandbox id and name), never from the kernel
command line; a rename sends a new `hello`. A resize of a running sandbox
restarts it and reports the processes that ended.

On SIGTERM the daemon saves every running sandbox and the next start restores
it (`woke`). Where saving fails (the screen is locked and its lock asks for a
password) or the backend cannot save (the process fixture), it stops the sandbox
and records why; the next start cold-boots it and reports `cold_booted` with
that reason.

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
the boot artifact paths, the sandboxes and operations directories and an
owner-only IPC token file from environment variables, starts the same `SandboxHost` and
`UnixDomainSocketServer` used by tests, brings back what the last run left
running, and hibernates on `SIGTERM`/`SIGINT` (the plist's `ExitTimeOut` bounds
the saves). The checked-in
`Resources/com.localbox.hostd.plist` is a bundle template; an installer
must materialize its paths, create the token file with mode `0600`, load it with
`launchctl`, and unload it before replacement.

`scripts/install-release.sh` does that materialization in a versioned release
root; the [development guide](../../../DEVELOPMENT.md#installing-rolling-back-and-uninstalling)
covers install, rollback and uninstall.
