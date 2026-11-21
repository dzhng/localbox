# 18 macOS TCC and desktop helper spike (go/no-go)

**Unlocks:** Q12 on macOS. With SIP off, writing the TCC databases lets a process
in the auto-login session capture the screen and post input with no prompt, and
the grant survives replacing the binary (P4, P6). Confirm item 4.

## Seam

- On 17's provisioned base, over SSH: install a probe binary at the darwin agent's
  final path `/usr/local/localbox/localbox-agent` in two roles (P4): a root
  LaunchDaemon and a LaunchAgent for user `localbox` started with `--desktop`.
- Write rows for `kTCCServiceScreenCapture`, `kTCCServiceAccessibility` and
  `kTCCServicePostEvent` naming that path, in the system database and the user's
  live database (macOS 27 moved it; find it from the files `tccd` holds open, as
  cirruslabs' `update-tcc-database.sh` does).
- The `--desktop` role: capture the screen with ScreenCaptureKit, post a click with
  CGEvent on a known control, read the effect back.
- Replace the binary with a rebuilt one (same path, new bytes) and repeat.
- `localbox-vmlab macos-tcc --json`; probe `18-macos-tcc-spike.ts`, tiers `m`.

## See it

`npm run proof -- 18 --tier m`: the screenshot the helper took, the before/after of
the click, preflight results for all three services, before and after the binary
replace.

## Gates

All three services granted with no prompt, before and after the replace. If only
the replace fails, P6's fallback applies (the agent rewrites its rows as root
after each swap); record it here and in slice 32, and the spike passes.

## Stop rule

Grants not taking effect at all: Q12 reopens, a user decision. Stop and ask.

## Delegated

The probe binary's language, the exact SQL, which control is clicked.

## Feedback that would change it

The user dropping desktop operations on macOS.
