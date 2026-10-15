# 08 MCP sign-in

**Unlocks:** a cloud agent connects over MCP, signs in with an email and code,
and gets a full-account token (map Q2, Q10, Q13; plan decision D7). Closes the
open authorize hole and removes seam T3.

## Seam

- `RepositoryOAuthServer` becomes account-based. `GET /oauth/authorize` renders an
  email page, then a code page that states the grant: "Signing in gives
  `<client_name>` (`<redirect host>`) full access to your Localbox account: it
  can create, use and delete sandboxes on all your machines." The page names no
  account: nothing about an email's account is revealed before its code is verified.
- Dynamic client registration (`POST /oauth/register`, RFC 7591) stores
  `client_name` and exact `redirect_uris`; authorize requires an exact redirect
  match and PKCE S256.
- Tokens store the general shape `{accountId, scopes: ["account"], constraints:
  null, expiresAt}`: 15 min access, 30-day refresh renewed on use, the existing
  replay-family revocation kept.
- The MCP endpoint calls the agent API in-process; it no longer forwards the
  caller's bearer token over HTTP (`apps/mcp/api/[...path].ts:44`).
- The relay submit route accepts either an agent token or a machine credential;
  both resolve to an account principal.
- Delete `apps/relay/src/oauth.ts` (fixture server), the fixture default in
  `McpAdapter`, `LOCALBOX_OWNER_SUBJECT` (`apps/mcp/api/[...path].ts:13,17`,
  `scripts/local-vercel.ts:18`, `DEVELOPMENT.md`), the `owners` table and the `vm`
  scope. `InMemoryRelayStateRepository` and `LocalConvexHarness` go with their last
  consumer here.

## See it

`npm run proof -- 08 --tier u,l`: a scripted client discovers metadata,
registers, opens authorize, posts the email, reads the code from the dev log,
posts it, gets the redirect, exchanges the code (PKCE + `resource`), calls MCP
`tools/call` against machine B, refreshes, replays the old refresh token (family
revoked) and is refused for an unregistered redirect.

Visual: `scripts/proof/lib/shoot.ts` captures both pages at 390 px and 1280 px
into the evidence folder, styled with the site's tokens. Run
[screenshot-critique](../../../.agents/skills/screenshot-critique/SKILL.md) as the
last check. There is no prior look, so compare-screenshots does not apply.

**Review checkpoint (non-blocking):** open the shots with preview-shots, wait
about five minutes for feedback, then decide on the evidence, record the
decision here, close the shots and continue.

## Gates

`tests/repository-oauth.test.ts`, `tests/oauth-mcp.test.ts`,
`tests/mcp-vercel-oauth.test.ts` rewritten; new `tests/oauth-email-flow.test.ts`.

## Delegated

Page layout within the site's visual language, wording beneath the grant
sentence.

## Feedback that would change it

Sign-in page copy and look.

## Review decision (2026-10-15)

The user was away during the checkpoint, so the agent decided on the evidence in
`.localbox/proof/runs/*-08/08-signin-*.png`: kept as built. See `choices.md`.
