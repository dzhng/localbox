# 19 darwin vsock forwarder spike (go/no-go)

**Outcome 2026-11-21: go.** Evidence: [19-darwin-vsock.json](../evidence/19-darwin-vsock.json).

- `localbox-vsock` (a Swift target, `AF_VSOCK` listener per port, one thread pair
  per connection) carried 10,016 frames (10,000 up to 64 KiB plus sixteen of
  8 MiB, 461 MB) byte for byte on port 1024 while a second stream ran on 1025;
  29 MB/s echoed each way in a debug build.
- The host dropped and re-dialled both ports: the forwarder kept its PID and the
  echoes kept answering.
- A connection from inside the guest to its own port 1024 was closed by the
  forwarder (peer CID not 2).
- A clone of the provisioned base answered SSH 9.5 s after boot, far inside the
  120 s first-boot wait (E9 needs no longer wait for a booted base; slice 35 still
  measures the agent's own first connection).
- The first run deadlocked in the test, not the forwarder: the host wrote a whole
  8 MiB frame before reading its echo. The round trip now writes on its own
  thread.

**Unlocks:** the darwin guest channel. A native forwarder in a macOS guest listens
on `AF_VSOCK` ports 1024 and 1025 and hands each connection to a Unix socket, so
the host reaches the agent through `VZVirtioSocketDevice.connect(toPort:)` exactly
as on Linux (P9, P10). Confirm item 5.

## Seam

- New executable target `localbox-vsock` in `apps/macos/HostDaemon/Package.swift`
  (builds for the guest; same arm64 macOS). Behaviour mirrors the Linux socat unit
  (`packages/vm-image/Dockerfile.arm64:132`): `VSOCK-LISTEN:<port>,fork` to
  `UNIX-CONNECT:<socket>` with retry, for `1024 → /var/run/localbox/agent.sock` and
  `1025 → /var/run/localbox/control.sock`. Bind with `VMADDR_CID_ANY` and accept
  only peer CID 2 (the host), because any local guest user could otherwise reach
  the agent (Tart guest agent issue #83).
- Installed over SSH on 17's provisioned base as a root LaunchDaemon, with an echo
  server behind each socket.
- `localbox-vmlab macos-vsock --json`; probe `19-darwin-vsock-spike.ts`, tiers `m`.

## See it

`npm run proof -- 19 --tier m`: 10,000 framed round trips of up to 8 MiB on 1024
with byte-exact echoes (checking for Tart's dropped-output bug, issue #1347), a
concurrent stream on 1025, then the host drops and re-dials both: the echo servers
keep their state, the forwarder doesn't exit.

## Gates

Zero dropped or reordered bytes; reconnect without restart; a connection from a
non-host CID is refused.

## Stop rule

`AF_VSOCK` unusable in the guest: record and continue with the fallback "the
forwarder listens on the guest's NAT address instead, and the host connects by
TCP to the address learned as in slice 17". The agent and channel seams don't
change.

## Delegated

Socket permissions, logging, buffer sizes.

## Feedback that would change it

None expected; this is transport.
