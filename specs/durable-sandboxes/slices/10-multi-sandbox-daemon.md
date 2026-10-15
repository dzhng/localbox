# 10 Multi-sandbox daemon

**Unlocks:** many real sandboxes per Mac: cloned disks, internet, their own
identity, sized to the host (map L1, L4, Q6; plan decisions D2, D11). Removes
seam T1.

## Seam

- `SandboxHost` actor replaces the single-VM `HostDaemon`, holding
  `[SandboxID: SandboxRuntime]` and routing by `sandbox_id`. Host operations
  return the slice 09 result facts.
- Per-sandbox directory under `machinePaths().sandboxes/<id>/`: `sandbox.json`
  (identity mirror plus runtime: cpus, memory, MAC, machine identifier, lifecycle,
  `lastActivityAt`, `coldBootPending`), `disk.img` (APFS clone of `template.img`;
  if cloning is unsupported, copy and report `disk: copied`), `state.vzsave`.
- `SandboxConfigurationBuilder.build(record, artifacts)` is the only place a
  `VZVirtualMachineConfiguration` is made: NAT with the persisted MAC, the
  persisted machine identifier, the guest channel chosen in slice 02, and
  `validateSaveRestoreSupport()` asserted. vmlab uses it too.
- Guest identity (L4): `hello` carries the sandbox id and name; the guest agent
  regenerates `/etc/machine-id` and SSH host keys once per sandbox id (no image
  first-boot unit is needed) and takes the name as its hostname, never from the
  kernel command line (D2). `sandbox rename` sends a new `hello`.
- Sizing (Q6): pure `defaultSize(hostCpus, hostMemory)` = half the cores and a
  quarter of RAM, minimum 2 CPUs and 2 GB. `sandbox resize` cold-restarts and
  reports `restarted` with the processes that ended.
- SIGTERM hibernates running sandboxes instead of stopping them (D11); the
  launchd plist gets an `ExitTimeOut` long enough to save (measured in 02).
- `Package.swift` platforms `.macOS(.v14)`.

## See it

`npm run proof -- 10 --tier s,v` (`minimal`, machine A real): two sandboxes boot
with distinct `/etc/machine-id`, MAC and hostname equal to their names; both
reach the internet; clone disks allocate under 50 MB at creation; a file in one
is absent in the other; resize to 3 CPUs gives `nproc` 3 and reports the
restart; delete removes the directory; `launchctl kickstart -k` hibernates and
restores them. Tier s covers `defaultSize` (12 cores/24 GB → 6/6 GB; 4/8 GB →
2/2 GB) and the `SandboxHost` state machine on a fake backend. Tier l of slices
03–09 keeps passing with the fixture backend behind `SandboxHost`.

## Gates

`HostDaemonCoreTests.testDefaultSize*`, `testSandboxHostLifecycle`,
`testResizeReportsRestart`, `testSigtermHibernates`, `testSigtermColdBootsWhenSaveFails`;
new `tests/guest-identity.test.ts`.

## Delegated

File names inside the sandbox directory; the `ExitTimeOut` value.
