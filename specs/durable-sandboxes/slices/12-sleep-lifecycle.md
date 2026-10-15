# 12 Sleep lifecycle

**Unlocks:** sandboxes hibernate when idle, wake on use, optionally delete
themselves, and survive host sleep, shutdown and power loss (map Q5, Q5b, L6).
Removes seam T7.

## Seam

- `IdlePolicy` in `SandboxHost` with an injected clock: idle means no request in
  flight and `guest.activity.running_jobs == 0`. `sleepAfter` defaults to 30 min;
  `deleteAfter` is opt-in (`sandbox create --delete-after <dur>`); `--sleep-after
  <dur>` is per sandbox, so probes use real short times without a global clock
  knob.
- Any operation on a sleeping sandbox wakes it first and reports `woke` (S2).
- Host power: `IORegisterForSystemPower` (will-sleep, will-power-off) hibernates
  every running sandbox; on start the daemon restores saved ones. With no save
  file after a crash or power loss the sandbox cold-boots and the next result
  reports `cold_booted` once.
- Idle deletion removes the sandbox locally and its Convex row, with a reason.
- Dev-only socket operation `host.simulate_power {event}` accepted only with
  `LOCALBOX_DEV=1`.
- Delete `packages/recovery`, `localbox recovery probe`, and the recovery cases in
  `tests/recovery-registry-release.test.ts` (release cases move to a release-only
  test file).

## See it

`npm run proof -- 12 --tier l,v`: tier l with `--sleep-after 5s` sees the sandbox
asleep by 7 s and the next `shell exec` report `woke`; a 10 s background job keeps
it awake; `--delete-after 10s` removes it from the Convex list with a reason;
`simulate_power will_sleep` hibernates all. Tier v repeats the first with a PID
survival check, and `kill -9` of the daemon followed by a relaunch reports
`cold_booted`. Opt-in `--real-sleep` runs `pmset relative wake 90 && pmset
sleepnow` and checks restore after wake.

## Gates

`HostDaemonCoreTests.testIdleSleepsAfterTimeout`, `testRunningJobKeepsAwake`,
`testDeleteAfter`, `testPowerNoticeHibernatesAll`, `testColdBootReportedOnce`.

## Delegated

Power-notification plumbing; restore order on start.

## Feedback that would change it

Defaults and flag names.

## Built (2026-10-15)

- `IdlePolicy` and `SandboxHost.idleTick()` (run every second by `localbox-hostd`), the
  `asleep` lifecycle, wake-on-use for guest operations, `SystemPowerMonitor`
  (`IORegisterForSystemPower`), `host.simulate_power`, and `sandboxes:removeIdle`
  for idle deletion. `packages/recovery` and `recovery probe` are gone (T7).
- **Interim, awaiting the user (Q5b):** this Mac's screen is locked, so saves fail.
  Sleep then pauses the VM in memory (RAM kept, reported "paused in memory:
  hibernate needs an unlocked screen"); admission may stop a paused VM for room.
- Results carry host actions in `result.actions` (object results) or a top-level
  `host_actions`. The rest of the decisions are in [choices](../choices.md).
- Proof: `npm run proof -- 12 --tier s,l,v`. Tier v proved the locked fallback
  (PID survives the pause; `kill -9` + relaunch reports `cold_booted` once); its
  hibernate branch and `--real-sleep` have not run on this Mac.
