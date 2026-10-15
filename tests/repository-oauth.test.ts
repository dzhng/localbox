import assert from "node:assert/strict";
import { test } from "node:test";
import { redirectUriAllowed } from "../apps/relay/src/repository-oauth.js";
import { form, oauthFixture, pkcePair, RESOURCE } from "./fixtures/oauth-server.js";

test("metadata advertises registration, S256 and the account scope", () => {
  const { oauth } = oauthFixture();
  const server = oauth.authorizationServerMetadata();
  assert.equal(server.registration_endpoint, `${RESOURCE}/oauth/register`);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(server.scopes_supported, ["account"]);
  assert.deepEqual(oauth.protectedResourceMetadata(), { resource: RESOURCE, authorization_servers: [RESOURCE], bearer_methods_supported: ["header"], scopes_supported: ["account"] });
});

test("registration takes https or loopback http redirects only", async () => {
  for (const uri of ["https://claude.ai/cb", "http://127.0.0.1:33418/callback", "http://localhost:8080/cb", "cursor://anysphere.cursor-retrieval/oauth/callback", "vscode://vscode.github-authentication/did-authenticate"]) assert.ok(redirectUriAllowed(uri), uri);
  for (const uri of ["http://claude.ai/cb", "http://127.0.0.1.evil.test/cb", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "https://claude.ai/cb#frag", "https://user:pw@claude.ai/cb", "/relative"]) assert.ok(!redirectUriAllowed(uri), uri);
  const { call } = oauthFixture();
  const register = (body: unknown) => call("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const refused = await register({ client_name: "x", redirect_uris: ["https://ok.test/cb", "http://evil.test/cb"] });
  assert.equal(refused.status, 400); assert.equal((await refused.json() as any).error, "invalid_redirect_uri");
  assert.equal((await register({ client_name: "x", redirect_uris: [] })).status, 400);
  const created = await register({ client_name: "Claude\u0007", redirect_uris: ["https://claude.ai/cb"], token_endpoint_auth_method: "client_secret_post" });
  assert.equal(created.status, 201);
  const body = await created.json() as any;
  assert.equal(body.client_name, "Claude"); assert.equal(body.token_endpoint_auth_method, "none"); assert.deepEqual(body.redirect_uris, ["https://claude.ai/cb"]);
  for (let index = 1; index < 20; index++) await register({ redirect_uris: ["https://claude.ai/cb"] });
  assert.equal((await register({ redirect_uris: ["https://claude.ai/cb"] })).status, 429, "registrations are limited per address");
});

test("codes and tokens are stored hashed in the account shape, and agent sign-in creates no machine", async () => {
  const { t, signIn, sent } = oauthFixture();
  const tokens = await signIn("shape@example.com");
  const rows = await t.run(async (ctx) => ({ codes: await ctx.db.query("authCodes").collect(), tokens: await ctx.db.query("oauthTokens").collect(), machines: await ctx.db.query("machines").collect(), accounts: await ctx.db.query("accounts").collect() }));
  const stored = JSON.stringify(rows);
  for (const secret of [tokens.access_token, tokens.refresh_token, sent[0].code]) assert.ok(!stored.includes(secret), "no raw secret is stored");
  assert.equal(rows.machines.length, 0); assert.equal(rows.accounts.length, 1);
  const { _id, _creationTime, accessTokenHash, refreshTokenHash, accessExpiresAt, refreshExpiresAt, familyId, ...token } = rows.tokens[0];
  assert.deepEqual(token, { accountId: rows.accounts[0].accountId, clientId: tokens.clientId, scopes: ["account"], constraints: null });
  assert.ok(Math.abs(accessExpiresAt - Date.now() - 15 * 60_000) < 5_000); assert.ok(Math.abs(refreshExpiresAt - Date.now() - 30 * 86_400_000) < 5_000);
});

test("a code is single use and binds client, redirect, resource and the PKCE verifier", async () => {
  const { t, call, register, authorizeParams, sent, oauth } = oauthFixture();
  const redirectUri = "https://claude.ai/cb";
  const client = await register(redirectUri); const other = await register(redirectUri);
  const codeFor = async () => {
    const pair = pkcePair(); const params = authorizeParams(client.client_id, redirectUri, pair.challenge);
    await call("/oauth/authorize", form({ ...params, step: "email", email: "bind@example.com" }));
    const response = await call("/oauth/authorize", form({ ...params, step: "code", email: "bind@example.com", code: sent.at(-1)!.code }));
    return { code: new URL(response.headers.get("location")!).searchParams.get("code")!, verifier: pair.verifier };
  };
  const exchange = (code: string, fields: Record<string, string>) => call("/oauth/token", form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: redirectUri, resource: RESOURCE, ...fields }));
  const mismatches: Array<Record<string, string>> = [{ client_id: other.client_id }, { redirect_uri: "https://claude.ai/cb2" }, { code_verifier: pkcePair().verifier }];
  for (const wrong of mismatches) {
    const { code, verifier } = await codeFor();
    const failed = await exchange(code, { code_verifier: verifier, ...wrong });
    assert.equal(failed.status, 400); assert.equal((await failed.json() as any).error, "invalid_grant");
    assert.equal((await exchange(code, { code_verifier: verifier })).status, 400, "a failed exchange burns the code");
  }
  const { code, verifier } = await codeFor();
  assert.equal((await exchange(code, { code_verifier: verifier, resource: "https://other.test/mcp" })).status, 400);
  await t.run(async (ctx) => { for (const row of await ctx.db.query("authCodes").collect()) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 }); });
  assert.equal((await exchange(code, { code_verifier: verifier })).status, 400, "an expired code is refused");
  await assert.rejects(() => oauth.validateAccessToken("not-a-token"));
});

test("refresh is bound to its client, and revoke ends the whole family", async () => {
  const { call, signIn, register, oauth } = oauthFixture();
  const tokens = await signIn("refresh@example.com"); const other = await register();
  const refresh = (fields: Record<string, string>) => call("/oauth/token", form({ grant_type: "refresh_token", ...fields }));
  assert.equal((await refresh({ refresh_token: tokens.refresh_token, client_id: other.client_id })).status, 400);
  const rotated = await (await refresh({ refresh_token: tokens.refresh_token, client_id: tokens.clientId })).json() as any;
  assert.equal(rotated.scope, "account");
  assert.equal((await call("/oauth/revoke", form({ token: rotated.refresh_token, token_type_hint: "refresh_token" }))).status, 200);
  await assert.rejects(() => oauth.validateAccessToken(rotated.access_token));
  assert.equal((await refresh({ refresh_token: rotated.refresh_token })).status, 400);
  assert.equal((await refresh({ refresh_token: "garbage" })).status, 400);
  assert.equal((await call("/oauth/token", form({ grant_type: "password" }))).status, 400);
});

test("rotation keeps a family at two rows, replaying the last used refresh token still revokes it, and a family of any size is revocable", async () => {
  const { t, call, signIn, oauth } = oauthFixture();
  const first = await signIn("rotate@example.com");
  const refresh = (token: string) => call("/oauth/token", form({ grant_type: "refresh_token", refresh_token: token, client_id: first.clientId }));
  let current = first.refresh_token;
  for (let index = 0; index < 5; index++) current = (await (await refresh(current)).json() as any).refresh_token;
  const familyRows = async () => await t.run(async (ctx) => await ctx.db.query("oauthTokens").collect());
  assert.equal((await familyRows()).length, 2, "the current row and the one it rotated from");
  assert.equal((await refresh(first.refresh_token)).status, 400, "a long-superseded refresh token is refused");
  const latest = await (await refresh(current)).json() as any; await oauth.validateAccessToken(latest.access_token);
  const replay = await refresh(current);
  assert.equal(replay.status, 400); assert.equal((await replay.json() as any).error, "invalid_grant");
  await assert.rejects(() => oauth.validateAccessToken(latest.access_token), "replaying the last used refresh token revokes the family");

  // A family left over with more rows than one read may take is still revoked with a single row.
  const big = await signIn("big@example.com");
  const { familyId } = await oauth.validateAccessToken(big.access_token) as any;
  await t.run(async (ctx) => { const [row] = await ctx.db.query("oauthTokens").withIndex("by_family", (q) => q.eq("familyId", familyId)).collect(); for (let index = 0; index < 1_100; index++) await ctx.db.insert("oauthTokens", { ...row, _id: undefined, _creationTime: undefined, accessTokenHash: `a${index}`, refreshTokenHash: `r${index}` } as any); });
  assert.equal((await call("/oauth/revoke", form({ token: big.refresh_token }))).status, 200);
  await assert.rejects(() => oauth.validateAccessToken(big.access_token));
});
