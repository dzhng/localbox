# 05 Convex auth boundary

**Unlocks:** no Convex function runs without an identity Convex verified. Today
`packages/state/convex/relay.ts` exports public `write`/`read` switches with no
identity check (including a table `snapshot`), several trusting a caller-supplied
`now`. Q15 ships the Convex URL to every Mac, so this must close first (plan
decision D3).

## Seam

- `packages/state/convex/auth.config.ts`: `customJwt`, ES256, issuer
  `${LOCALBOX_API_ORIGIN}`, `applicationID: "localbox-convex"`, JWKS as a data URI
  from the Convex env `LOCALBOX_JWKS` (works offline locally).
- `packages/state/convex/lib/identity.ts`: `requireIdentity(ctx, kind)` with
  `kind` `"service" | "machine"`. A machine identity re-reads its `machines` row
  and refuses it when `revokedAt` is set, on every call, so removal is immediate
  although the JWT lives 24 h.
- `packages/tokens` (used by Vercel routes only) signs ES256 JWTs: service tokens
  (`sub: "service:api"`, 5 min, minted per invocation) and machine tokens
  (`sub: "machine:<id>"`, `account` claim, 24 h). Private key from
  `LOCALBOX_JWT_PRIVATE_KEY`.
- Typed, validated functions per module replace the `write`/`read` switch; every
  `input.now` argument is removed.
- New tables `accounts`, `machines`, `emailCodes`, `rateLimits`. Old relay
  tables stay until slice 07 (seam T2).
- `scripts/convex-wipe.ts --deployment local|prod`: empties every table (run in
  production only in slice 13, map Q14).
- `packages/state/src` keeps only typed client helpers; `RelayStateRepository`,
  `InMemoryRelayStateRepository` and `LocalConvexHarness` go when their last
  consumer moves (07 and 08); tests use `convex-test`.

## See it

`npm run proof -- 05 --tier u,l`: tier u runs a parameterized test over every
exported public function, refusing anonymous and wrong-kind callers (a new
unguarded function fails CI), and refuses a revoked machine on its next call;
tier l shows an unauthenticated `ConvexHttpClient` refused everywhere and a
service JWT minted by `dev:local` accepted. Confirms the map's
"custom JWT works" item.

## Gates

New `tests/convex-auth.test.ts`; `tests/convex-state.test.ts`,
`tests/relay-lease.test.ts`, `tests/state.test.ts` rewritten to the typed
functions.

## Delegated

Module file split and validator style.

## Feedback that would change it

Preferring RS256 or a hosted JWKS URL (key rotation then needs no redeploy).
