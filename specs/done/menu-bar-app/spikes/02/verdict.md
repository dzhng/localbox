# Spike 02 verdict: VMs under an app-supervised child

Run 2026-11-22 05:26–06:07 PST on macOS 27.0.1 (26A434), Apple M6, 24 GiB RAM,
at commit f9a6d0f, from a short worktree (`~/lb40`, since removed). The screen
lock asks for no password (`sysadminctl -screenLock status`: off) and the
session read `CGSSessionScreenIsLocked=Yes` throughout; hibernation worked, as
`host-check.ts` says it does with no password on the lock.

**Verdict: go.** Checks 1, 2, 3 and 8 pass, and so do 5, 6 and 7. The
virtualization entitlement and the saved-state key are both available to a
daemon that is the child of an `LSUIElement` app launched with `open -g`.

Command: `npm run proof -- 40 --tier v` (add `--full-table` for the 8 GiB
cells). The all-pass run is `evidence/02/run4-default-all-pass/` (113 s, exit
0); every number below without another source is from its `40-app-child.json`.

## Deviations, read these first

1. **Check 8 did not use "Agent Computer Local".** `codesign --sign "Agent
   Computer Local"` blocked on a keychain access dialog (`SecurityAgent`) and
   never returned; I killed my `codesign` after about ten minutes (run 2). Check
   8 then ran with a throwaway self-signed code-signing identity, "Localbox
   Spike 02 Scratch", made by `scratch-identity.sh` in a scratch keychain that
   is never in the search list and is deleted when the probe ends. It is
   self-signed and untrusted, like the release identity, but it is not the
   identity the task named. `LOCALBOX_PROOF_40_IDENTITY="Agent Computer Local"`
   re-runs check 8 with the keychain identity once someone can click Allow; the
   probe reports "blocked" rather than hanging if it cannot sign in 20 s.
2. **The 4 × 8 GiB cell was scaled to 4 × 4 GiB.** The daemon admits 75 % of
   RAM (18 GiB here); 4 × 8 GiB does not fit. 1 × 8 and 2 × 8 ran as specified.
3. **The Mac was shared.** Other agent sessions and a Colima VM (started
   05:26:47, not by this spike) ran throughout, and swap grew from 1.5 MB to
   about 6.9 GB used during the 8 GiB cells. Timings are a loaded machine's.

## The supervisor

`spikes/02/main.swift` + `Info.plist` + `build.sh`: an AppKit app, bundle id
`sh.localbox.spike.child`, `LSUIElement` true, activation policy accessory. It
reads a JSON config (path from `LOCALBOX_SPIKE_CONFIG`, passed with
`open -g … --env`), spawns the daemon with its own environment plus the
config's (the six variables `realDaemon()` sets), a `Pipe` on the child's
stdin, and its output appended to a log. On SIGTERM, SIGINT or an AppKit quit
it sends SIGTERM to the child and waits with no deadline, then exits.

## Checks

| # | Result | Evidence |
| --- | --- | --- |
| 1 | pass | App pid 87267 has ppid 1 (LaunchServices), `ls_ui_element: true`, `activation_policy: accessory`; `ps` shows the daemon's ppid is the app; `lsof` shows the daemon's fd 0 is a `PIPE`. `sandbox.create` returned `created`, `cold_booted`; `uname` = `Linux 6.8.0-151-generic aarch64`; the marker loop (guest pid 308) counted 3 → 9. The VM service's parent is launchd (pid 1), as always with Virtualization. |
| 2 | pass | `sandbox.sleep`: "hibernated alpha-otter: saved its state and released its 2 GiB"; `state.vzsave` 163,581,952 bytes; VM service footprint 513,024 KiB awake, 0 VM services asleep; record `asleep`. The next `shell.exec` reported `woke` ("restored alpha-otter from its saved state"); counter 9 before, 20 → 26 after, same pid. |
| 3 | pass | SIGTERM to the app; the app logged `sigterm_sent` then `child_exited` (`exit`, status 0, waited 469 ms); both gone in 485 ms. Record `hibernated`, `state.vzsave` present, no VM service left. Relaunch with `open -g`: daemon log "sandbox_p40_alpha woke: restored alpha-otter from its saved state", `last_boot.kind` = `woke` 564 ms after launch; counter 26 before, 36 → 42 after. |
| 4 | recorded | Table below. |
| 5 | recorded | See "The orphaned daemon". |
| 6 | pass | 1280 MiB dirtied; SIGTERM to the app; the daemon was SIGKILLed 110 ms later while writing `.save-037B3A49-….vzvmsave` (160,455,273 bytes at the kill). The app logged `child_exited` (`signal`, status 9). Record still `running`; no VM service left. Next start: "sandbox_p40_alpha cold_booted: cold-booted alpha-otter: the daemon exited without saving it"; the first `shell.exec` carried `cold_booted`, the file synced before the kill was on disk, the old process was gone, and the partial save file had been removed. |
| 7 | pass | Daemon relaunched under the app with `LOCALBOX_DEV=1`. `will_sleep`: `slept`, "hibernated alpha-otter: saved its state and released its 2 GiB", 0 VM services, `state.vzsave` 163,581,952 bytes. `did_wake`: `woke`, "restored alpha-otter from its saved state"; counter 42 before, 53 → 59 after. |
| 8 | pass, with deviation 1 | The daemon copied into `Contents/MacOS/localbox-hostd` and signed, then the app, both `Authority=Localbox Spike 02 Scratch`, daemon identifier `sh.localbox.spike.hostd`, entitlement `com.apple.security.virtualization` true (`codesign -d` output in the evidence). Launched with `open -g`; daemon's ppid is the app. New sandbox, marker started; SIGTERM to the app: `child_exited` `exit` status 0 after 483 ms, record `hibernated`, `state.vzsave` 171,970,560 bytes. Relaunch: "sandbox_p40_beta woke: restored beta-heron from its saved state" in 549 ms; counter 3 before, 14 → 20 after. |

Checks 1–3 and 5–7 use the dev-signed daemon (`sign-dev.sh`: ad hoc, with the
entitlement) at its build path, outside the bundle, and an ad hoc signed app.

## Timing table (check 4)

Hibernate = wall time from SIGTERM to the app until the app and daemon are both
gone, with every record `hibernated`. Each guest first filled a tmpfs with
`/dev/urandom` (incompressible, really written memory): 1280 MiB in a 2 GiB
guest, 6144 MiB in an 8 GiB guest, 3072 MiB in a 4 GiB guest. After each
restore every VM reported `woke`, its counter was still climbing, and the
blob's checksum matched. Restore = `open -g` until every VM is running.
From `evidence/02/run3-full-table/40-app-child.json` (2 GiB rows agree with
runs 1, 2 and 4 to within about 1.5 s; the table shows run 3 and the range).

| VMs | Memory each | Dirtied each | Saved state, total | Hibernate | Restore |
| --- | --- | --- | --- | --- | --- |
| 1 | 2 GiB | 1280 MiB | 1.4 GiB | 0.9 s (0.8–1.6 over 4 runs) | 1.4 s |
| 2 | 2 GiB | 1280 MiB | 2.8 GiB | 1.6 s (1.6–2.7) | 1.4 s |
| 4 | 2 GiB | 1280 MiB | 5.6 GiB | 3.2 s (3.1–4.5) | 3.0 s |
| 1 | 8 GiB | 6144 MiB | 6.1 GiB | 3.4 s | 6.1 s |
| 2 | 8 GiB | 6144 MiB | 12.3 GiB | 8.5 s | 20.6 s |
| 4 | 4 GiB (scaled from 8) | 3072 MiB | 12.5 GiB | 8.3 s | 14.3 s |

The 8 GiB rows are one run each. Hibernation writes roughly 1.5–1.9 GiB/s here
and scales with the bytes saved, not the VM count: 12.3–12.5 GiB took 8.3–8.5 s
either way. An idle 2 GiB guest saves 156–164 MiB in about 0.5 s (checks 3, 8).

**Spread under repetition.** A soak of the 4 × 2 GiB cell
(`spikes/02/restore-soak.ts`, `evidence/02/soak-*`): 20 cycles under the app
took 3.2–10.7 s to hibernate (median 6.2 s); 12 cycles with the daemon spawned
directly, run earlier, took 3.0–6.0 s (median 3.6 s). The Mac's load differed
between the two runs, so this does not show the app makes saving slower; it
does show the same cell can take three times its best time.

No cell came near a minute. Extrapolating the write rate, a full 18 GiB
admission budget of dirty memory is about 10–12 s on an idle disk and perhaps
30 s at the soak's worst rate.

## The orphaned daemon (check 5)

After `kill -9` of the app the daemon keeps running, reparented to launchd
(ppid 1), and so does its VM: 5 s later the socket still answered
(`shell.exec` → `still-here`) and the marker counter had gone 59 → 84 → 90;
at 16.5 s both were still up. Its stdin is a pipe with no writer, which it
never reads. A SIGTERM sent to the orphan directly still hibernated the sandbox
(481 ms, record `hibernated`, no VM service left). So today an app crash leaves
a working, unsupervised daemon holding the socket; slice 06's stdin-EOF exit is
needed, and a relaunched app must expect to find one.

## Findings that are not in the checks

- **A restore can fall back to a cold boot.** In run 2, one of four VMs in the
  4 × 2 GiB cell came back `cold_booted`: "could not restore its saved state:
  guest channel is unavailable", and that start took 125 s. Its record had read
  `hibernated`. It did not recur in 20 app cycles, 12 direct cycles or the three
  other probe runs (1 in about 40 four-VM restores), and the cause is not
  established; the Mac was swapping and another session's `codesign` dialog was
  up. The memory of that sandbox was lost. The probe now fails check 4 if it
  happens.
- **`open -g` failed once** (exit 1) in about 70 launches
  (`evidence/02/soak-app-open-failed`), on a relaunch about 100 ms after the
  previous instance exited. Its stderr was not captured, and it did not recur
  in the next 20 cycles with capture on. A relauncher should retry.
- The spike app was relaunched from the same path dozens of times, ad hoc and
  self-signed, with no prompt.

## Must stay green

`swift test --package-path apps/macos/HostDaemon`: 105 tests, 0 failures.
Probes 10 and 12 at tier `v`: both pass (`evidence/02/probe-1{0,2}-tier-v.json`).

## Not proven here

- Check 8 with "Agent Computer Local" or the real release identity.
- The daemon built `-c release`; every run used the debug build.
- A daemon in the bundle under the hardened runtime (`--options runtime`); the
  spike signed without it, as `sign-dev.sh` does.
- macOS guests, a real logout or shutdown, a password-locked screen.
- 4 × 8 GiB (needs a Mac with more than 42 GiB).

## Cleanup

No `localbox-hostd`, `LocalboxSpikeChild` or probe process is running; every
sandbox was deleted and every scratch root and the scratch keychain removed;
the keychain search list is unchanged; the `~/lb40` worktree is removed.
Nothing is committed. Left alone: the Colima VM, and the keychain access dialog
for "Agent Computer Local" (`SecurityAgent`, pid 66822, started 05:24 by
another session, still on screen; my blocked `codesign` may have queued a
second one behind it). Deny it unless that session's signing should proceed.

## Files

The spike's source was removed when the spec closed; it is in git at
`d0f7bb3`, under `specs/menu-bar-app/spikes/02/`.

- `spikes/02/main.swift`, `Info.plist`, `build.sh`: the supervisor app.
- `spikes/02/scratch-identity.sh`: the throwaway identity for check 8.
- `spikes/02/restore-soak.ts`: the soak (ran as a temporary probe 98; not registered).
- `scripts/proof/probes/40-app-child.ts`: the probe, tier `v` (at commit
  6cd328f; slice 06 replaced it with the regression `40-supervised-daemon.ts`,
  which needs no app and no signing).
- `evidence/02/`: four probe runs, three soak runs, probes 10 and 12, `swift test`.
