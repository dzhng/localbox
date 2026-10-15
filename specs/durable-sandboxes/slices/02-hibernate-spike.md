# 02 Hibernate spike (go/no-go)

**Unlocks:** the answer to whether Q5b (sleep = hibernate, processes resume)
works with our configuration, and the configuration rules that later slices
inherit. Closes map item L5.

## Seam

`vmlab hibernate`, `vmlab net`, `vmlab clone` on `AppleVirtualizationBackend`,
which gains:

- NAT network: `VZNATNetworkDeviceAttachment` plus a persisted
  `VZMACAddress.randomLocallyAdministered()` (map L1; today the network device has
  no attachment, `AppleVirtualizationBackend.swift:36`).
- A persisted `VZGenericPlatformConfiguration.machineIdentifier`.
- `validateSaveRestoreSupport()`, `save(to:)` (pause → `saveMachineStateTo` →
  stop) and `restore(from:)` (`restoreMachineStateFrom` → resume). State files are
  written atomically (temp, flush, rename).
- An in-band host→guest `hello {channel_epoch, wall_clock_ms, hostname}` frame.
  The guest agent adopts the epoch monotonically (today it is fixed at boot from
  an env var, `apps/guest-agent/src/index.ts:21`) and steps its clock (plan
  decision D2).

## See it

`npm run proof -- 02 --tier v` on `minimal`:

1. Boot. Start a `node -e` counter server on `:8080`; record its PID.
2. NAT works (`curl -sI https://deb.debian.org`); the guest MAC equals the
   persisted one.
3. Hibernate: record save ms, state-file bytes, and the host memory drop.
4. Restore: same PID, counter still increasing, curl works, guest clock within
   2 s of the host after `hello`, frames flow on the new epoch.
5. Restart the daemon process between save and restore (cross-process restore).
6. Configuration-identity sweep: restore after changing the command line, CPU
   count, MAC and machine identifier, one at a time; record which break restore.
7. The guest channel is already the virtio socket (slice 01: guest-to-host
   bytes never arrived on the named console port). Confirm the vsock connection
   is re-established after restore; the console-port alternative is gone.
8. Repeat once with the screen locked.

## Output

`specs/durable-sandboxes/evidence/02-hibernate.json` plus a decision note in
this file:

- **Channel:** vsock is in use; record whether the connection survives restore or
  must be re-dialled, and the cost of a re-dial.
- **Restore identity:** which fields must never change while a save file exists.
  Slice 10 relies on this for "resize cold-restarts" and "rename never touches the
  kernel command line".
- **Measured** save and restore times and file sizes; slice 12 uses them for its
  sleep budget.

## Gates

The probe; Swift test for `hello` epoch adoption on the host side;
`tests/guest-service.test.ts` new case "adopts newer epoch from hello, rejects
older".

## Delegated

vmlab internals and the counter-server script.

## Stop rule

If save/restore fails for every channel option, stop the build here and report.
Falling back to stop-instead-of-hibernate is a product decision (Q5b), not the
implementer's.

## Findings before the decision (2026-10-15)

- **Built:** NAT with a persisted MAC, a persisted machine identifier,
  `validateSaveRestoreSupport()`, atomic `save(to:)` and `restore(from:)` on
  `AppleVirtualizationBackend`, the in-band `hello` (the guest adopts newer epochs,
  steps its clock and sets its hostname; a fixture guest never touches the host's
  clock or hostname), and `localbox-vmlab hibernate` (save in one process, restore
  and an identity sweep in another). Probe: `npm run proof -- 02 --tier u,v`.
- **Channel:** vsock (slice 01). The backend re-dials it after restore and waits
  for the guest's ready frame before sending.
- **Locked screen:** `saveMachineStateTo` fails with "permission denied" while the
  console session is locked. Apple's VM service creates the saved-state encryption
  key with `SecKeyCreateRandomKey`, which returns `errSecInteractionNotAllowed`
  then (`evidence/02-locked-save.log`). Signing identity is not the cause. So a
  Mac whose screen is locked (most headless Macs) cannot hibernate sandboxes. This
  feeds Q5b: on a locked Mac, sleep must fall back to keeping the sandbox running
  or stopping it, which is the user's product decision.
- **Pending (needs an unlocked screen):** the save/restore run (PID survives,
  counter, NAT, clock within 2 s), save and restore times and file sizes, and the
  restore-identity sweep. The probe's unlocked check reports `blocked:` until then.

## Decision (2026-10-15): go, with an unlocked session

- **Result:** with the screen lock off (the user changed the setting on this Mac
  mini), `npm run proof -- 02 --tier v` passes twice in a row: save about 450 ms,
  a 117 MB state file, restore in a new process about 285 ms, the background Node
  server keeps its PID and its counter keeps counting, the guest clock is within
  4 ms of the host's. Evidence: `evidence/02-hibernate.json`.
- **Requirement:** hibernation needs an unlocked, logged-in session; the saved
  state's encryption is Apple's and cannot be turned off. Headless Macs are set
  up with automatic login and no screen lock; `localbox host check`, `localbox
  status` and the installer report whether a Mac hibernates and which settings
  to change. Where it cannot, idle sleep pauses in memory (Q5b, kept).
- **Guest agent:** the first unlocked run showed processes dying on restore. The
  image ran the agent as `socat VSOCK-LISTEN … EXEC:node` without `fork`, so any
  dropped host connection (a restore, a daemon restart) stopped the systemd unit
  and killed every process it had started. The agent is now a persistent service
  on `/run/localbox/agent.sock` (`KillMode=process`), and a separate unit runs
  `socat VSOCK-LISTEN:1024,fork UNIX-CONNECT:…`; jobs, their processes and the
  agent's mutation replay outlive host connections.
- **Restore identity:** changing the CPU count, MAC address or machine
  identifier makes restore fail ("invalid argument"); the kernel command line
  does not matter. Slice 10's resize discards the save file; MAC and machine
  identifier never change.
- **Open:** the restored guest's internet took about 7 s to answer again
  (`nat_ready_ms`); a follow-up should renew the guest's network on the
  post-restore `hello`.
