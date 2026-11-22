# Spike verdicts

One section per spike. Each full write-up, with commands and evidence, is in
`spikes/NN/verdict.md` and `evidence/NN/`.

## 01 · Hands-off first launch and login item: go (real SSH leg unproven)

Run 2026-11-22 with the screen locked throughout.

- `open -g` of a self-signed, un-notarized `LSUIElement` app in
  `~/Applications` works, and `SMAppService.mainApp.register()` returned
  `.enabled` with no prompt (a banner only), on first launch, on relaunch, and
  after the bundle was replaced by a re-signed build.
- Localhost SSH has no key auth here, so the SSH leg ran as an approximation:
  a detached shell with a stripped environment. This launch command worked and
  is what `installation.md` uses:
  `/bin/launchctl asuser $(id -u) /usr/bin/open -g "$HOME/Applications/Localbox.app"`.
  A real SSH run stays on the manual runbook.
- A quarantined bundle is held by a Gatekeeper dialog, and while that dialog
  is open every launch from that path hangs. The install procedure must never
  leave the quarantine attribute on the app (curl does not set it).
- `SMAppService.mainApp` matches by bundle id, not path.

No fallback needed.

## 02 · VMs under an app-supervised child: go

`npm run proof -- 40 --tier v` (the spike's probe; slice 06 replaced it with
a regression). The daemon, as the child of an `LSUIElement`
app launched with `open -g`, booted, hibernated and restored real Linux VMs,
including when signed with a self-signed identity inside a bundle.

| VMs × memory | Saved | Hibernate | Restore |
| --- | --- | --- | --- |
| 1 × 2 GiB | 1.4 GiB | 0.9 s | 1.4 s |
| 2 × 2 GiB | 2.8 GiB | 1.6 s | 1.4 s |
| 4 × 2 GiB | 5.6 GiB | 3.2 s | 3.0 s |
| 1 × 8 GiB | 6.1 GiB | 3.4 s | 6.1 s |
| 2 × 8 GiB | 12.3 GiB | 8.5 s | 20.6 s |
| 4 × 4 GiB | 12.5 GiB | 8.3 s | 14.3 s |

(24 GiB Mac under load; the last row is scaled down from 4 × 8 GiB.)

What this changes:

- Hibernation stays well under a minute, but 4 × 2 GiB ranged 3.2–10.7 s over
  20 cycles, so a fixed 4 s + 2 s stop window is too short. Slice 08's
  unbounded wait for the daemon stands.
- An orphaned daemon (app killed with `kill -9`) keeps running with its VMs
  and its socket. Slice 06's stdin-EOF stop is needed.
- One restore in about 40 fell back to a cold boot ("guest channel is
  unavailable", after 125 s). Cause unknown; slice 06 owns finding it.
- `open -g` failed once in about 70 launches, on a relaunch 100 ms after
  exit. The CLI's quiet launch retries (slice 07).

## 04 · Built-in image fetch: go

- Resume after a cut, fail-closed on a truncated part, a flipped byte and a
  bad signature, and peak disk of parts plus image (1.35% over) all held.
- `Range` works through GitHub's release redirect (206, correct
  `Content-Range`, resumed bytes identical).
- **Staging moves to `<root>/downloads/`.** `ImageStore.sweepTemps` at daemon
  start would delete `<images>/.linux.fetch/`.
- Slice 11 also inherits: `expandImage` has no progress hook and leaves a
  pid-named temp after a crash; a daemon start can sweep
  `.linux.installing-<pid>` mid-install; `verifyRelease` can't check a
  parts-only directory; the published v0.1.1 manifest is an older shape, so
  the real-release run needs a new release first.

## Shared finding: the scratch signing identity

`codesign` with the keychain's "Agent Computer Local" identity blocks on a
keychain dialog nobody can click in an unattended run. Spikes and probes make
their own throwaway identity in a temporary keychain instead.
