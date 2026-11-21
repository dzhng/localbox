# 33 darwin guest agent

**Unlocks:** Q12 in code. The darwin agent answers every catalog operation the
Linux one does, in the two roles of P4.

## Seam

- `apps/guest-agent`: on darwin the binary runs as a root LaunchDaemon (default
  role: request lane `/var/run/localbox/agent.sock`, control lane
  `/var/run/localbox/control.sock`, both forwarded by `localbox-vsock`) or with
  `--desktop` as a LaunchAgent in the auto-login user's session, connected to the
  root role over `/var/run/localbox/desktop.sock` (root-owned, group-readable by
  the `localbox` user only).
- `packages/desktop` splits into backends behind the existing handler set:
  `x11` (today's xdotool and ImageMagick, `packages/desktop/src/index.ts:166-335`)
  and `macos` (ScreenCaptureKit capture, CGEvent move, click, scroll, key and type).
  On darwin the root role forwards `desktop.*` to the `--desktop` role.
- `browser.*` keeps Chrome over CDP on `127.0.0.1:9222`; on darwin the `--desktop`
  role launches Chrome in the user session.
- Identity and clock (`apps/guest-agent/src/index.ts:39`, `identity.ts`): the
  `process.platform === "linux"` gate becomes a per-platform implementation.
  darwin: `scutil --set` for `HostName`, `LocalHostName` and `ComputerName`;
  regenerate SSH host keys if present; step the clock with `date`; no machine-id.
- Shell runs through `/bin/sh -c` with process-group kills, unchanged
  (`packages/guest-gateway/src/index.ts:64,132,270`).
- The display is whatever the Mac graphics device presents; `desktop.screenshot`
  reports its real size rather than assuming 1440×900.

## See it

Tier `u` only here; the real run is slice 35.

## Gates

Tier `u`: `tests/desktop-backends.test.ts` (each `desktop.*` op maps to the right
macOS calls through a fake runner), `tests/guest-identity.test.ts` new darwin cases,
`tests/agent-binary.test.ts` runs the darwin binary under the fixture for
`system.info` and `shell.exec`.

## Delegated

How the native macOS calls are reached from the agent (a small bundled helper or a
native addon inside the single binary); socket permissions within the stated owner
and group.

## Stays green

`tests/desktop.test.ts` on the x11 backend; `tests/guest-identity.test.ts` Linux
cases.
