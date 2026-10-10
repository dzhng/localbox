# Host daemon status model

`HostStatusStore` is the app/daemon seam for first-run, starting, ready,
disconnected, paused, and reset states. Lifecycle controls delegate to the
catalog client and registry; this model carries status only and adds no policy.

`HostDaemon` is the only VM lifecycle owner. `AuthenticatedLocalIPC` is the
local CLI boundary: it checks the injected Keychain token and forwards the
envelope to `HostDaemon.request` without duplicating lifecycle state.

`UnixDomainSocketServer` is the launchd-compatible local transport around that
seam. It creates the configured socket path (expanding `~`), refuses to replace
an unrelated file, applies owner-only `0600` permissions, and serves one
big-endian length-prefixed JSON request per connection. The response carries
`envelope` on success or a stable `error` code (`unauthorized`, `malformed`,
`frame_too_large`, or `unavailable`). The listener is non-blocking while
accepted connections use blocking reads on detached tasks, so a slow CLI
cannot stall other clients. `stop()` cancels the listener and removes the
socket path; launchd packaging can own process startup and call the same
server lifecycle in the signed product bundle.

`AppleVirtualizationBackend` configures a named virtio-console port and attaches
the framed `GuestService` channel after VM start; a hardware run still must
prove that the published guest kernel/initrd and service actually boot and emit
readiness. Destructive reset requires an immutable template disk and replaces
the persistent disk from that template, so a failed or interrupted reset never
leaves an empty disk image attached to the VM.

The `localbox-hostd` executable is the launchd process boundary. It reads
the VM image paths and an owner-only IPC token file from environment variables,
starts the same `HostDaemon` and `UnixDomainSocketServer` used by tests, and
stops both on `SIGTERM`/`SIGINT`. The checked-in
`Resources/com.localbox.hostd.plist` is a bundle template; an installer
must materialize its paths, create the token file with mode `0600`, load it with
`launchctl`, and unload it before replacement.

The repository installer does that materialization in a versioned release root:
`scripts/install-release.sh` verifies the manifest before extracting, points
launchd at the atomic `releases/active` app, and leaves prior verified trees in
place for `scripts/rollback-release.sh`. It also installs
`com.localbox.updater`, a six-hour launchd job that runs the bundled updater;
the updater verifies the signed GitHub manifest before replacing the active
release and refreshes a managed global skill afterward. An automatic install
leaves that updater job loaded while it switches the active release, so the
updater cannot terminate its own installer. `scripts/uninstall.sh`
removes both launchd registrations and the CLI link by default, so the VM disk
and token are not deleted during an ordinary uninstall.
