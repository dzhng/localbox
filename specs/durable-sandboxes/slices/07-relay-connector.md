# 07 Relay mailbox and connector

**Unlocks:** a request for any machine on the account runs on that machine;
idle Macs cost about zero Convex calls; an offline machine is reported within
seconds; relay rows live 24 hours (map Q15, Q16, Q17; L2, L3; plan decisions
D5, D6, D13). Removes seam T2.

## Seam

- Convex `relay` (rewritten, keyed by account and machine):
  - `requests {requestId, accountId, machineId, sandboxId?, operation,
    mutationId, payload, status: queued|claimed|completed|abandoned, createdAt,
    claimDeadlineAt}` with the dedupe index on `(sandboxId, operation, mutationId)`;
    `responses {requestId, response, recordedAt}`.
  - `pendingForMachine` (query; the machine's subscription), `claim` (refuses
    `abandoned`), `complete` (refuses a response over the cap), `enqueue`
    (service), `abandonIfUnclaimed` (service), `reportCapacity` (machine; slice 11).
  - Lazy offline: a request unclaimed after 3 s is atomically marked `abandoned`
    and the caller gets `machine_offline` with the machine's last-seen time. A Mac
    that sees `abandoned` skips it, so nothing reported offline runs later.
  - Daily per-account limits (D13): 500 relayed requests and 25 MB of results,
    enforced in `enqueue`/`complete`; errors name the limit and reset time. Values
    are Convex env knobs.
  - `crons.ts`: a daily cleanup at a non-zero minute deleting rows older than
    24 h in bounded, self-rescheduling batches.
- `POST /api/relay/machine-token`: machine credential in, 24 h machine JWT out;
  records last seen (Q13).
- Agent side (D5): the agent API route from slice 06, `POST /api/v1/ops`, now also
  takes machine-bound operations: it enqueues, then waits on a
  Convex subscription for up to `min(deadline, 50 s)` and returns the response
  inline; past that it returns a continuation. `RelayHttpTransport` loses its
  50 ms poll loop.
- `apps/connector` (new; bundled Node; launchd job `com.localbox.connector`):
  `ConvexClient` with `setAuth` (fetching the machine JWT),
  `onUpdate(pendingForMachine)` → `claim` → forward over the daemon socket with
  `LocalIPCTransport` → `complete`. Long-polls the daemon's new `host.watch
  {since}` socket operation for state changes. It is the only process on a Mac
  that talks to Convex and owns nothing durable. On a revoked credential it exits
  cleanly without a launchd restart loop.
- `relay.status` reports the connector's real state; the daemon's fake
  `markRelay` flag goes.
- Delete `apps/relay/src/poller.ts`, `/host/*` routes, channel grants and the
  `channels` table, `apps/relay/src/index.ts` (`RelayServer`), `tests/relay.test.ts`,
  `tests/relay-poller-vercel.test.ts`.

## See it

`npm run proof -- 07 --tier u,l` (L-L, both logged in):

- From A, `localbox shell exec --machine b -- hostname` returns B's result;
  median claim latency under 1 s over 10 runs.
- Over 60 s idle, neither machine makes a Convex function call (counted from the
  local backend's function log).
- Stop B's connector: A gets `machine_offline` in under 5 s and the row is
  `abandoned`; restart B and the request never runs (B's guest journal has no
  entry).
- Kill the connector after claim, before complete: A gets
  `operation_uncertain`; replaying the same mutation id returns the original
  result.
- A 2 MiB `fs.read` returns 900 KiB with `truncated`.
- `npx convex run relay:cleanupExpired` with a future cutoff removes rows.
- With the request limit set to 3, the fourth request names the limit and reset.
- Record Convex calls and database bytes per relayed request into the evidence;
  update the map's budget estimate if it differs.

## Gates

New `tests/relay-convex.test.ts` (claim/abandon race, replay, limits, cleanup),
`tests/connector.test.ts` (injected Convex client and socket; oversized response
refused; capacity only on change); `tests/catalog-relay-parity.test.ts` and
`tests/client-relay.test.ts` rewritten.

## Delegated

Connector backoff, log format, subscription page size, continuation shape.

## Feedback that would change it

The 3 s offline window, the 50 s inline wait, the limit values.
