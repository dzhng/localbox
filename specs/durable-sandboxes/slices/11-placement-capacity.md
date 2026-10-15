# 11 Placement and capacity

**Unlocks:** creates land on the right machine, and a full machine makes room by
sleeping its least recently used sandboxes and says so (map Q4, L9).

## Seam

- `packages/placement`: pure `place({flags: {machine?, placement?},
  callerMachineId?, machines: [{id, name, online, roomBytes, totalBytes}]})` →
  `{machineId, reason}` or `{error, machines}`. Called only by the create route
  in Convex (D8). Rules: default is the caller's own machine; `--machine <name>`;
  `--placement auto` (local and remote, most room); `--placement remote` (remote
  only). With no local machine and no option, the error lists every machine with
  its room. Offline machines are skipped by `auto`/`remote` and named in the
  reason.
- Capacity: `CapacityReport {machineId, totalBytes, reservedBytes, roomBytes,
  running, revision}` from `SandboxHost`, where `roomBytes` is reservation-based
  (75% of RAM minus running reservations), not live free memory. `revision`
  changes only on lifecycle events; the connector writes it to Convex only then.
- Admission in `SandboxHost.admit(start)`: if a start or wake would exceed 75% of
  RAM, sleep least-recently-used running sandboxes (never one with a running job)
  until it fits; report each in `made_room`. If nothing can be slept, fail with
  `machine_full` listing what holds the memory.

## See it

`npm run proof -- 11 --tier u,l,v`: tier u table-tests `place`; tier l (A set to
8 GB, B to 16 GB) shows a default create from A landing on A, `--placement auto`
landing on B, a CLI with no local daemon failing with both machines listed, and a
start on a full A naming the slept sandbox; tier v (V-L) starts a fourth default
sandbox on the real A, sleeps the least recently used one, and measures its RAM
released.

## Gates

`tests/placement.test.ts`, `HostDaemonCoreTests.testAdmitSleepsLeastRecentlyUsed`,
`testRunningJobIsNeverSleptForRoom`.

## Delegated

Tie-breaking between equal machines.

## Feedback that would change it

The auto policy; the 75% knob.
