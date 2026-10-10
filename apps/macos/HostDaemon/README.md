# Host daemon status model

`HostStatusStore` is the app/daemon seam for first-run, starting, ready,
disconnected, paused, and reset states. Lifecycle controls delegate to the
catalog client and registry; this model carries status only and adds no policy.
