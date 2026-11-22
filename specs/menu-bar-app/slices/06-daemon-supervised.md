# 06 · Daemon: supervised mode, one daemon per root

Needs 02 (go).

## Contract

`localbox-hostd` is safe as someone's child and safe against a twin. Started
with `--supervised`, it treats its parent going away as a stop request and
hibernates. Two daemons can never serve one machine root.

## Why

Today only launchd's one-job-per-label prevents a second daemon.
`UnixDomainSocketServer.start()` in `LocalIPC.swift` unlinks any existing
socket with no liveness check, so a second daemon on the same root would steal
the socket while the first keeps its VMs. And nothing ties the daemon to a
parent: spike 02, check 5 records what an orphan does.

## API seam

- **`HostDaemonCore.MachineLock`** (new, one small file): `flock(LOCK_EX |
  LOCK_NB)` on `<root>/hostd.lock`, held for the process's life. Refusal exits
  75 with one line on stderr naming the lock. `main.swift` takes it before the
  socket server starts, so nothing is unlinked by a daemon that will not run.
  The lock's path comes from a new environment variable
  `LOCALBOX_HOSTD_LOCK` (set by `DaemonLaunch` in slice 08 and by
  `realDaemon()` in the proof harness); without it the daemon derives it from
  the socket's directory.
- **`localbox-hostd --supervised`:** EOF on stdin runs exactly the SIGTERM
  path in `installSignalHandlers` (`server.stop()`, `host.shutdown()`,
  `exit(0)`). Without the flag nothing changes, because probes start the daemon
  with stdin on `/dev/null`.
- **Shutdown progress:** `host.shutdown()`'s caller prints one line per sandbox
  to stderr as it finishes (`hibernated NAME` or `stopped NAME: reason`), so the
  app can show "Putting 2 sandboxes to sleep…" from real events.
- **Leftover ids:** the five `DispatchQueue(label: "org.localbox.…")` labels in
  `SystemPower.swift`, `FramedGuestChannel.swift`, `VirtualMachine.swift`,
  `VNCClient.swift` and `ControlChannel.swift` become `sh.localbox.…`.

`SandboxHost.shutdown()` itself does not change (README, firewalls).

- **The rare cold boot (spike 02):** one restore in about 40 fell back to
  `cold_booted` with "guest channel is unavailable" after 125 s. Reproduce it
  with probe 40's restore loop (at least 200 cycles), find the cause, and fix
  it or record why it can't be fixed here.

## What the human can run

Start two daemons on one scratch root: the second prints the refusal and exits
75. Start one with `--supervised` under `cat |`, close the pipe, and watch it
hibernate its sandbox and exit 0.

## Verification

- `swift test`: lock held, lock refused, lock released on exit; stdin EOF runs
  shutdown (with `ProcessFixtureBackend`); no EOF handling without the flag.
- Probe 40 (from spike 02) becomes a regression at tier `v`: closing stdin
  hibernates a real VM and a relaunch wakes it; a twin is refused.
- `git grep org.localbox -- apps packages scripts` is empty.

## Delegated to the implementer

The stderr line format; whether the EOF watcher is a `DispatchSource` or a
thread.

## Must stay green

All of `swift test`; probes 10, 12 and 13 at tiers `l` and `v`; `realDaemon()`
callers (they must not need `--supervised`).

## Feedback that would change this slice

Spike 02, check 5 showing an orphaned daemon is already harmless would not
remove this slice: the twin hazard remains.
