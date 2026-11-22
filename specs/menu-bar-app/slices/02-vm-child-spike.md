# 02 · Spike: VMs under an app-supervised child

No dependencies. Throwaway code under `specs/menu-bar-app/spikes/02/`, plus a
probe `scripts/proof/probes/40-app-child.ts` at tier `v` that slice 06 keeps as
a regression.

**This spike is the plan's kill switch.** Decision 1 (the app owns everything)
only works if its answer is yes.

## Question

Does `localbox-hostd`, spawned as a child of an `LSUIElement` app that was
launched with `open -g`, boot, hibernate and restore real VMs? And how long does
hibernation take, since quit, logout and update must all wait for it?

## Probe

A throwaway supervisor app (bundle id `sh.localbox.spike.child`) that spawns the
dev-signed daemon (`scripts/proof/lib/sign-dev.sh`) with the same environment
`scripts/proof/lib/real-daemon.ts` builds, in a scratch root, with a pipe on the
child's stdin. The probe talks to the daemon's socket exactly as `realDaemon()`
callers do.

## Checks

1. Create a Linux sandbox, run `shell.exec`, start a marker process (a loop
   writing a counter).
2. `sandbox.sleep` writes the saved state and frees the VM's memory; wake keeps
   the marker alive with its counter still climbing.
3. The app sends SIGTERM to the child and waits with no deadline. The
   sandbox's record says hibernated. Relaunch the app: the daemon's recovery
   reports `woke` and the marker is alive.
4. **Timing table:** hibernate wall time for 1, 2 and 4 VMs, at 2 GB and at
   8 GB with memory dirtied first. This sets the budgets slices 08 and 15 use.
5. `kill -9` the app. Record what the orphaned daemon and its VMs do (today
   nothing ties the daemon to a parent; slice 06 adds stdin EOF).
6. `kill -9` the daemon mid-save. The next start reports `cold_booted` and the
   disk boots.
7. `host.simulate_power` (`LOCALBOX_DEV=1`) still hibernates and wakes in the
   child.
8. Repeat check 3 with the daemon signed by the scratch self-signed identity
   instead of ad hoc, since the release is self-signed.

## Verdict

**Go:** checks 1–3 and 8 pass. Check 4's table is recorded either way.

**No-go:** the virtualization entitlement or the saved-state key is not
available to an app's child. Stop. Write the evidence to `spikes.md` and return
to the user: the alternatives are keeping the daemon a launchd job (which Bento
found macOS refuses after a binary changes, under a self-signed identity) or
running the VMs inside the app process. Neither is in this plan.

## What the human can see

`spikes.md` section "02": the eight checks, the timing table, and one sentence
on what an orphaned daemon does.

## Delegated to the implementer

How the supervisor app is built; how memory is dirtied; the probe's check names.

## Must stay green

`swift test`; probes 10 and 12 at tier `v` (they share the daemon binary).

## Feedback that would change this slice

A no-go on check 3 with the screen locked only (hibernation needs an unlocked
session today): that is existing behaviour, not a no-go; record it and re-run
unlocked.
