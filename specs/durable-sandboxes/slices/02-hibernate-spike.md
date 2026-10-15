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
7. Repeat 3–4 with the guest channel on the console port and on
   `VZVirtioSocketDevice`.
8. Repeat once with the screen locked.

## Output

`specs/durable-sandboxes/evidence/02-hibernate.json` plus a decision note in
this file:

- **Channel:** the virtio socket if it restores (it also removes the one-request-
  at-a-time limit of the console port), else the console port.
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
