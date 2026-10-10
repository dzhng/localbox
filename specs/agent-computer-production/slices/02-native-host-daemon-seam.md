# Slice 02 — Native HostDaemon lifecycle seam

## Contract unlocked

One Swift actor owns VM lifecycle, channel epoch, readiness, relay status, and destructive reset. A fake backend proves the lifecycle in CI; the Apple Virtualization backend owns the real VZ machine when a pinned image is supplied.

## Seam

`apps/macos/HostDaemon` defines `HostDaemon`, `VMBackend`, `GuestChannel`, and `DaemonStatus`. `HostDaemon` is the only lifecycle owner; it delegates VM mechanics to `VMBackend` and guest envelopes to `GuestChannel`. `AppleVirtualizationBackend` validates the pinned ARM64 inputs, configures VZ block/NAT/entropy devices, and owns start/stop/pause/resume. A future local Unix socket adapter must call this actor rather than duplicate state.

## Human runnable artifact

`swift test --package-path apps/macos/HostDaemon` proves start, channel attach/request, pause/resume, stop, and reset confirmation. On macOS with image artifacts, the Apple backend is selected explicitly and never silently falls back to the fake.

## Verification

- Swift package tests remain green.
- Real Apple Silicon acceptance still requires the slice 01b image and a guest readiness/channel implementation; this seam does not claim that hardware gate is complete.
- Lifecycle errors are explicit and status transitions include epoch changes after start/resume/stop/reset.
