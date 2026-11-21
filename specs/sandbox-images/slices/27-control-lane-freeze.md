# 27 Control lane and freeze lifecycle

**Unlocks:** E1 and E2. A sandbox can be frozen for a disk clone without being
woken, slept or saved underneath it, and freeze/thaw never queue behind a guest
request or write to the frozen disk (P10).

## Seam

- **Control lane, vsock port 1025.** Linux: a second socat unit in
  `Dockerfile.arm64` (`VSOCK-LISTEN:1025` → `/run/localbox/control.sock`); darwin:
  `localbox-vsock` (slice 19). Frames use the existing length-prefixed JSON framing
  (`packages/guest-gateway/src/protocol.ts`), kinds `freeze`, `thaw`, and later
  `agent.update` (slice 32). No mutation journal, no request serializer.
- **Guest:** `packages/guest-gateway/src/control.ts` (new). `freeze { timeout_ms }`
  runs `sync` then `fsfreeze -f /` on Linux and `sync` only on darwin, answers
  `frozen`, and arms a self-thaw timer (default 10 s). `thaw` runs `fsfreeze -u /`.
  Nothing on this path writes to disk.
- **Host:** `FramedGuestChannel` gets a sibling `ControlChannel` dialled per need.
  `SandboxRuntime` gains lifecycle `.freezing` and a per-sandbox operation lock.
  While `.freezing`: guest requests wait for the lock (today `.paused` wakes on any
  request, `SandboxHost.swift:360-361`), admission never picks it for
  sleep-for-room (`SandboxHost.swift:561-565`), idle policy skips it, and shutdown
  thaws then saves (`SandboxRuntime.swift:213`).
- `freezeAndClone(_ body: () throws -> Void)` on the runtime: lock, freeze, pause,
  body, resume, thaw, unlock; thaw and unlock run on every path.

## See it

Tier `v`: start a guest writing a file in a loop, call `freezeAndClone` with a body
that sleeps 1 s, see the writer stall then continue; kill the host mid-body and see
the guest thaw itself within the timeout.

## Gates

- Tier `u`, `tests/guest-control.test.ts`: self-thaw fires; freeze answers while a
  request is in flight on the request lane.
- Tier `s`, `FreezeLockTests`: idle tick, admission and incoming requests all skip
  or wait on a `.freezing` sandbox.
- Tier `v`, probe 27: the stall and self-thaw scenario above.

## Delegated

Default self-thaw timeout within 5–30 s; control-channel dial strategy.

## Stays green

`tests/guest-service.test.ts`, `tests/guest-agent-persistent.test.ts`, probe 12.
