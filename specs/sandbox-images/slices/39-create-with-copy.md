# 39 Create with copy

**Unlocks:** Q6 fully. `sandbox create --image X` on a Mac without X copies first
and returns at once; the sandbox becomes usable when the copy lands.

## Seam

- Relay `createSandbox` follows slice 36's plan. With `copy` set it starts an
  `image.copy` (slice 38) and creates the sandbox row in state `copying` with the
  copy's operation id, then returns immediately with that state and the placement
  `reason`.
- Daemon: host operation kind `sandbox.create_after_copy`, chained to the copy;
  when the copy commits it provisions the sandbox (slice 29's path).
- While `copying`, every sandbox operation answers `sandbox_not_ready` with the
  copy's progress, answered by the relay without relaying.
- `image wait X` and `sandbox status` both show the progress.
- Result: `copied image X from A to B (…)` then `created sandbox S on B: …` once
  done; the first response says `sandbox S on B is waiting for image X to copy
  (SIZE); localbox image wait X`.

## See it

Tier `l`: two fixture machines, image held only on A, `sandbox create --image X
--machine b`, then `image wait X`, then `shell exec` on the new sandbox.

## Gates

- Tier `u`: `tests/sandbox-create-copy.test.ts` (state, `sandbox_not_ready` with
  progress, P7's local default).
- Tier `l`, probe 39: the scenario above, including a connector restart during the
  copy.

## Delegated

Wording of the waiting line.

## Stays green

Probes 11 and 29.
