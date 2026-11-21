# 19 darwin vsock forwarder spike (go/no-go)

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
