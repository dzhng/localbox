# 30 Image catalog commands

**Unlocks:** Q10. `image list`, `rename`, `default` and `delete` work across the
account, offline holders delete later, and output meets the map's standard.

## Seam

- Relay handlers in `apps/relay/src/ops.ts`: `list`, `rename`, `default` are
  account ops over `images.ts`. `delete` checks `confirm` like `deleteSandbox`
  (`ops.ts:269`), drops the Convex row (and holders) first, then fans out to holder
  machines; with `--machine M` it drops only M's holder and file. Deleting never
  touches sandboxes created from the image: each sandbox disk is its own APFS clone,
  and the result says so.
- Connector: a new host op `image.mirror` modelled on `sandbox.mirror`
  (`SandboxHost.swift:329`): the daemon deletes any local image the account no
  longer lists for it, so an offline holder catches up when it reconnects.
- CLI render (`apps/cli/src/render.ts`): `image list` columns `NAME OS SIZE FROM ON
  DEFAULT`, `ON` lists holder machine names or `every Mac` for `linux`; text and
  JSON carry the same facts. Deleting the default prints that it reset to `linux`.

## See it

`localbox image list`, `localbox image rename brave-walrus rails-dev`,
`localbox image delete rails-dev --confirm rails-dev`.

## Gates

- Tier `u`: `tests/image-catalog.test.ts` (rules from slice 22 through the relay),
  `tests/cli-output.test.ts` (columns, text/JSON parity).
- Tier `l`, probe 30: delete while a holder is offline, then it reconnects and the
  file goes.

## Delegated

Size formatting; column widths.

## Stays green

`tests/cli-layout.test.ts`, `tests/client-relay.test.ts`.
