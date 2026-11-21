# 36 Placement with images

**Unlocks:** Q6, E7 and P7 as a pure decision: given an image, where a sandbox
goes and whether a copy comes first.

## Seam

`packages/placement/src/index.ts` `place()`, still pure:

- Input gains `image: { id, os, minMacOS? }` and per machine `{ holds: boolean,
  freeDiskBytes, macOSVersion, macVMsRunning }` beside today's room fields
  (`index.ts:5-12`).
- Output gains `copy?: { fromMachineId, bytes }` and a `reason` string the result
  quotes.
- Rules, in order:
  1. Filter out machines that can't run the image: macOS images need
     `macOSVersion ≥ minMacOS` (E12).
  2. Named machine, or no flag (the caller's own Mac, P7): that machine; `copy`
     when it doesn't hold the image, from the holder with the most recent
     `updatedAt`. Not enough free disk for the copy is `disk_full` with the numbers.
  3. `--placement auto|remote`: among holders with room, today's most-room rule;
     only if none fits, the non-holder with the most room that has disk for the
     copy, with `copy` set.
- The relay builds holders from `imageHolders` (slice 22), never from the capacity
  blob; free disk and macOS version come from capacity (slice 24).
- `linux` counts as held everywhere (P1).

## See it

The table test output.

## Gates

Tier `u`: `tests/placement.test.ts` table cases: holder first; copy only when no
holder fits; named machine without the image copies; no flag copies to the local
Mac; macOS image never placed on an older macOS; not enough disk reported with
numbers; `linux` never copies.

## Delegated

Tie-breaking among equal holders beyond "most room".

## Stays green

Existing placement cases unchanged for `linux`.
