# 38 image copy

**Unlocks:** Q4, Q5 and E8 in the product. `localbox image copy NAME --to MACHINE`
copies directly between two signed-in Macs, resumes across restarts, and reports
size, duration and path, or why it couldn't connect.

## Seam

- Convex `copies` (new, in `images.ts`): `{ copyId, accountId, imageId, fromMachineId,
  toMachineId, key, candidates: { from?, to? }, state, createdAt }`. The key is
  generated per copy and readable only by the two machines' credentials. Rows expire
  after 24 h.
- Relay `image.copy`: resolves `--to` the same way `--machine` resolves
  (`packages/placement/src/index.ts:33`), picks the source holder (slice 36's rule),
  creates the `copies` row and a holder row `copying` for the target, and relays a
  host op to both machines.
- Connector: exchanges candidates through the `copies` row (it is the only Convex
  speaker on a Mac) and forwards them to the daemon.
- Daemon: host operation kind `image.copy` on both ends (slice 26). The sender
  serves `ImageStore` files through `ImageTransfer`; the receiver writes into
  `ImageStore.reserveTemp`, verifies, commits, and the connector sets the holder
  `ready`. Free disk checked before starting.
- Result: `copied image NAME from A to B (SIZE, DURATION, local network | internet)`.
  Failure: `copy_unreachable` listing each path tried and the next step ("put both
  Macs on the same network once, then copy").

## See it

Tier `l`: two fixture daemons on this Mac copy an image over loopback, the receiver
is killed and restarted mid-copy, `image list` shows both holders.

## Gates

- Tier `u`: `tests/copy-rendezvous.test.ts` (row lifecycle, key visible only to the
  two machines, expiry).
- Tier `l`, probe 38: the scenario above; a replay of the mutation returns the same
  operation.
- Tier `x`: the user's two Macs on different networks (runbook step, advisory).

## Delegated

Candidate refresh cadence; how long a copy waits for the peer before
`copy_unreachable`.

## Stays green

`tests/connector.test.ts`, `tests/relay-convex.test.ts`.
