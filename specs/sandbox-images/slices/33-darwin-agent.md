# 33 darwin guest agent

**Outcome 2026-11-21: built; tier `u` green; smoked in a real macOS 27 guest.**
Evidence: [33-darwin-agent-smoke.json](../evidence/33-darwin-agent-smoke.json),
[capture with the Apple menu open](../evidence/33-menu-open.jpg).

- Native calls go through the `localbox-desktop` Swift helper the desktop role
  spawns per call (`localbox-tccprobe` is gone); `packages/desktop` has `x11`
  and `macos` surfaces behind one handler set. launchd units and `install.sh`
  are in `apps/guest-agent/darwin`; `localbox-agent --grant-tcc` writes the rows.
- vmlab `macos-tcc` now installs the real agent, helper and forwarder and drives
  everything over vsock: shell as root, identity from the hello (`scutil`
  names, marker), capture before the grant refused, capture after it, a click
  that opens the Apple menu (one retry while the fresh grant settles), a
  capture **with the menu open** (one-frame `SCStream`), key and type. A binary
  replaced behind the agent's back loses capture; an `agent.update` keeps it
  (the swap hook rewrites the rows, the desktop role restarts itself). TCC holds
  the agent responsible for the helper it spawns.
- Found on the way: the gateway's journal default `/.localbox` is on macOS's
  read-only system volume; darwin keeps its state under `/var/db/localbox`.
- **Open for 34/35:** with the rows written, macOS 27 still puts up "localbox-agent
  is requesting to bypass the system private window picker" (also visible in
  spike 18's evidence). Captures work while it is up, but it covers the screen
  and catches clicks; the base build has to pre-approve it (not attempted here).
  Browser operations were not run: the provisioned base has no Chrome (34).

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

- **Inherited from spike 18:** `SCScreenshotManager` answers nil while a menu is
  open, so `desktop.screenshot` must not fail then: capture from a running
  `SCStream` (one frame), and prove it in slice 35 with a menu open. After every
  agent swap the root role rewrites the three TCC rows (P6; the screen-capture
  grant does not survive a replaced binary), through slice 32's
  `rewriteDarwinTccGrantsAfterSwap` hook.

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
