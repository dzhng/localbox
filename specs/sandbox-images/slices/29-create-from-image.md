# 29 sandbox create --image (image already here)

**Unlocks:** Q9 when the chosen Mac holds the image. `--image NAME`, the account
default with no flag, and the `macos` reserved name all resolve; the daemon clones
from `ImageStore`.

## Seam

- Relay `createSandbox` (`apps/relay/src/ops.ts:174-216`) resolves the image:
  explicit `image`, else `accounts.defaultImageId`, else `linux`. `macos` with no
  ipsw-sourced image fails with `image_not_found` and the message
  `no macOS image yet; build one with: localbox image create --macos`.
  The resolved `image_id` is stored on the `sandboxes` row (no `create_input`
  dependence; rows are swept after 24 h, `sandboxes.ts:53-60`) and forwarded.
- This slice handles only a target Mac that already holds the image (or `linux`).
  A target without it fails with `image_not_found` naming the holders; slice 39
  replaces that with a copy.
- Daemon `create` (`SandboxHost.swift:487-524`) requires `image_id` and passes it
  to `factory.provision` (slice 24).
- Result adds `image NAME` to the existing creation line.

## See it

`localbox image default bold-image`, then `localbox sandbox create` with no flag
lands on `bold-image`; `localbox sandbox create --image macos` before any macOS
build prints the guidance above.

## Gates

- Tier `u`: `tests/sandbox-catalog.test.ts` new cases (default resolution, `macos`
  guidance, stored `image_id`).
- Tier `l`, probe 29: fixture create from a held image.
- Tier `v`, probe 29: a real sandbox boots from a captured image.

## Delegated

Where in the result the image line sits.

## Stays green

`tests/placement.test.ts`, probe 11.
