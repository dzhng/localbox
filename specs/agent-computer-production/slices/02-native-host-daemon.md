# Slice 02 — Native macOS HostDaemon and local transport

## Contract unlocked

A signed-capable macOS host owns one durable VM lifecycle and provides a local CLI transport to the real guest.

## Seam

`HostDaemon` is the only owner of `VZVirtualMachine`, persistent disk lock, image verification, virtio NAT/entropy/block devices, virtio-serial `GuestChannel`, readiness, pause/resume, stop, reset, and status. The Swift probe reports real evidence from this owner; it never silently selects the fake backend. A small authenticated local Unix socket/launchd IPC adapter exposes the same operation envelopes to the CLI.

The existing JSON registry stays a local disk-path cache; lifecycle transitions and recovery events are emitted by the daemon. VM reset requires the contract confirmation from slice 00.

## Human runnable artifact

On Apple Silicon: `agent-computer status`, `vm start`, `vm pause`, `vm resume`, `vm stop`, and `invoke shell.exec ...` operate against a real Linux guest. A JSON probe report records cold/warm boot, guest readiness, persistence, pause/resume, reconnect, and clean-stop evidence.

## Verification

- Real cold and warm boot; persistent marker survives restart; guest channel reconnects after sleep/network change.
- Pause/resume, explicit reset, clean stop, disk/socket/process leak checks, and host-path isolation.
- Local CLI operation matrix covers all catalog operations against the real/fake backend seam.
- Swift tests and existing JS tests remain green; unsupported is returned only on non-macOS or missing image, never as a fake fallback on macOS.
