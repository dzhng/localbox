# 21 Catalog routing and image operations

**Unlocks:** every `image.*` operation and `sandbox.create`'s `image` field exist
in the contract, each with explicit routing instead of prefix defaults (E5, E13).

## Seam

`packages/contract/src/index.ts`, the only owner of op routing.

- Replace `executorOf` and `sandboxScoped` (`index.ts:134-139`) and the prefix rule
  in `hostOperationIds` (`index.ts:318`) with an explicit entry per operation in
  `definitions`: `{ executor: "account" | "host" | "guest", sandbox_scoped,
  routing: "account" | "machine" | "holders" }`. `holders` means the relay fans out
  to the machines holding an image. Every existing op keeps today's behaviour; the
  table makes it explicit.
- New operations (CLI words follow the existing rule, second id part with `_` → `-`,
  `apps/cli/src/index.ts:82,95-98`):

  | Id | Input | Routing | Mutation |
  | --- | --- | --- | --- |
  | `image.create` | `{ from?: sandbox, macos?: boolean, name? }`, exactly one of `from`/`macos` | machine (the source sandbox's Mac, or the target Mac for `--macos`) | required |
  | `image.list` | `{}` | account | none |
  | `image.rename` | `{ image, name }` | account | required |
  | `image.copy` | `{ image, to }` | machine (`to`) | required |
  | `image.default` | `{ image }` | account | required |
  | `image.delete` | `{ image, confirm?, machine? }` | holders, or one machine | required |
  | `image.wait` | `{ image, timeout_ms ≤ 120000 }` | holders (the Mac whose holder row is `building` or `copying`; answered from Convex when none is) | none |

- `sandbox.create` gains optional `image`.
- One shared output shape, `ImageOperationState`: `{ image, name, os, state:
  "building" | "copying" | "ready" | "failed", progress?: { phase, done_bytes,
  total_bytes }, error? }`. The `failed` error carries the reason and the next
  step (Q5, the map's output standard).
- New error codes: `image_not_found`, `disk_full`, `copy_unreachable`
  (both Macs tried every path), `image_incompatible` (macOS guest newer than the
  host).
- `--machine` stays a CLI control flag (`apps/cli/src/index.ts:27`); for
  `image.delete` it is the routing selector on purpose, not input.

## See it

`localbox help image.create`, `localbox help image.delete`; `npm run generate:snapshots`
diff shows the new ops in `snapshots/catalog.json`, `snapshots/help.json` and
`GeneratedOperations.swift`.

## Gates

Tier `u`:

- `tests/contract.test.ts`: catalog count updated (`:15`), snapshots equal generated.
- New `tests/catalog-routing.test.ts`: a literal table of every op → executor,
  scope and routing, so a new op can't silently inherit a default.
- `tests/catalog-relay-parity.test.ts`: sample inputs for every new op.

## Delegated

Description wording; the order ops appear in help.

## Stays green

All existing contract, CLI layout and parity tests with their current behaviour.

## Feedback that would change it

The user renaming a command (for example `image save` instead of `image create
--from`).
