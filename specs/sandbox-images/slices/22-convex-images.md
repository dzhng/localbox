# 22 Convex image records

**Unlocks:** images, the machines holding them and the account default are
durable account state with one owner (E6, P1).

## Seam

`packages/state/convex/images.ts` (new), the only owner of the image record.

- Tables, added to `relayStateSchema` (`schema.ts:36-41`):
  - `images { imageId, accountId, name, os: "linux" | "macos", sizeBytes,
    source: { kind: "sandbox" | "ipsw", sandboxName?, ipswVersion? },
    minMacOS?, createdAt, createMutationId }`, index by account and name.
  - `imageHolders { imageId, accountId, machineId, state: "building" | "copying" |
    "ready" | "failed", operationId?, updatedAt }`.
- `accounts` gains `defaultImageId?` (absent means `linux`). `account.status`
  returns the whole row (`accounts.ts:7`), so the field shows up there; keep it.
- Functions: `list` (synthesizes `linux` with every live machine as a ready holder,
  P1), `reserve` (name generated with `packages/names` when absent, unique per
  account among images, `linux` and `macos` reserved), `rename`, `setDefault`,
  `remove` (resets the default to `linux` and returns that fact), `setHolder`,
  `dropHolder`.
- `machines.ts` removal and logout (`machines.ts:22-36`) also drop that machine's
  holder rows; an image left with no holders stays listed as `holders: []` until
  deleted (no silent deletion).
- `macos` resolves to the account's most recent image with `source.kind = "ipsw"`;
  rename and delete rules apply to that image by its own name.

## See it

convex-test output for the cases below; `npx convex dev` shows the new tables.

## Gates

Tier `u`, `tests/images-convex.test.ts`:

- `linux` can't be renamed, deleted or reserved; `macos` can't be used as a name.
- Deleting the default resets it to `linux` and says so.
- Removing a machine drops its holders; the image remains with no holders.
- Names unique per account; generated when omitted.
- Every function goes through `requireIdentity`.

## Delegated

Index names; the exact shape of `list`'s row beyond the fields the CLI renders
(slice 30).

## Stays green

`tests/convex-auth.test.ts`, `tests/relay-convex.test.ts`, `admin:wipe` covering the
new tables.

## Feedback that would change it

The user wanting `linux` pinned to one version account-wide (would make it a row).
