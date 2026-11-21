# 28 image create --from

**Unlocks:** Q1, Q7 and Q8 on Linux. `localbox image create --from SANDBOX` saves
the sandbox's disk and boot store as an image, the sandbox keeps running after
about a 1 s stall, and the result says exactly what happened.

## Seam

- `HostDaemonCore/ImageCapture.swift` (new), registered as host operation kind
  `image.capture` (slice 26). Steps:
  1. Check `ImageStore.freeBytes()` against the source disk's allocated bytes plus
     margin; refuse with `disk_full` before starting (E3).
  2. Source asleep: wake through admission first (P2). Source stopped: skip 3–5.
  3. `runtime.freezeAndClone` (slice 27) with body: APFS-clone `disk.img` and copy
     the boot store into `ImageStore.reserveTemp`.
  4. Measure `stall_ms` from freeze to thaw.
  5. `commit`.
- Relay `image.create { from }`: reserves the Convex row (slice 22), routes to the
  source sandbox's machine, returns the operation state; the connector sets the
  holder `ready` on completion.
- Result (the map's output standard, kept line for line):
  `image NAME saved from sandbox SRC (linux, SIZE)`;
  `SRC froze for N s while its disk was saved, and is running again`;
  `on machine M; copies to other Macs on first use`;
  `start a sandbox from it: localbox sandbox create --image NAME`.
- Fork: under the slice 15 fallback, the new image's `boot/kernel` and
  `boot/initrd` are copied from the source sandbox's image.

## See it

`localbox image create --from bold-otter` then `localbox image list` on a real
sandbox.

## Gates

- Tier `u`: `tests/image-capture-relay.test.ts` (routing, reservation, result text).
- Tier `l`, probe 28: fixture daemon capture, replay returns the same operation.
- Tier `v`, probe 28: stall < 2 s; a file written one second before capture exists
  in a sandbox created from the image (slice 29); that sandbox has a new machine-id
  (`apps/guest-agent/src/identity.ts:18`).

## Delegated

Disk margin size; progress phases for this kind.

## Stays green

Probe 12 (sleep lifecycle) and 27.
