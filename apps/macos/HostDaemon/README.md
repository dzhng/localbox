# Host daemon status model

`HostStatusStore` is the app/daemon seam for first-run, starting, ready,
disconnected, paused, and reset states. Lifecycle controls delegate to the
catalog client and registry; this model carries status only and adds no policy.

`AuthenticatedLocalIPC` is the local CLI boundary. The eventual launchd Unix
socket uses the same request shape and an injected Keychain token; it
authenticates before calling `HostDaemon.request`, so it does not become a
second lifecycle owner. The in-process implementation is covered by Swift
tests and is the seam for the macOS socket transport.
