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
readiness.
