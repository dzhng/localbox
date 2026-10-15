# 03 Fixture machine

**Unlocks:** two machines on one Mac (tier l), with real guest semantics, so
every control-plane slice can be proven without booting VMs.

## Seam

- `ProcessFixtureBackend: VMBackend, GuestChannelProvider` in `HostDaemonCore`:
  spawns `node apps/guest-agent/src/index.ts` with `LOCALBOX_ROOT=<sandbox dir>/root`;
  stdin/stdout carry exactly the framed protocol the virtio channel carries.
  Sleep is `SIGSTOP`/`SIGCONT` and counts as freed memory.
- Selected only with `LOCALBOX_VM_BACKEND=process-fixture`; refused without it
  and in signed release builds ("never silently fall back to a fixture").
- Host capacity overrides `LOCALBOX_DEV_HOST_MEMORY_BYTES` and
  `LOCALBOX_DEV_HOST_CPUS` are read only by this backend.
- `main.swift` reads explicit paths from its environment (slice 00) and refuses
  to start without them.
- Still one VM per daemon here (transitional seam T1, removed in 10).
- `stack up --machines a,b` starts one daemon per machine root.

Topologies: **L-L** (both fixture) for control-plane work; **V-L** (A real,
B fixture) for slices 11 and 12. Two real daemons on one Mac would double-count
RAM, so only the real two-Mac test (tier x) is V-V.

## See it

`npm run proof -- 03 --tier l`: both machines run `shell exec -- echo`;
distinct guest roots; A's IPC token refused on B's socket; killing B's daemon
leaves A working and B's CLI reports `guest_unreachable` naming the socket.

## Gates

`HostDaemonCoreTests.testProcessFixtureBackendRoundTrip`,
`testFixtureBackendRefusedWithoutOptIn`.

## Delegated

Child-process supervision details.
