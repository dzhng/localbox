import assert from "node:assert/strict";
import { test } from "node:test";
import { form, oauthFixture, pkcePair, RESOURCE } from "./fixtures/oauth-server.js";

const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/\s+/g, " ");

test("an MCP client signs in by email code and gets a rotating account token", async () => {
  const { call, register, authorizeParams, sent, oauth } = oauthFixture();
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const client = await register(redirectUri, "Claude");
  assert.ok(client.client_id);
  const pair = pkcePair(); const params = authorizeParams(client.client_id, redirectUri, pair.challenge, "xyz");

  const emailPage = await call(`/oauth/authorize?${new URLSearchParams(params)}`);
  assert.equal(emailPage.status, 200);
  assert.match(emailPage.headers.get("content-type")!, /text\/html/);
  assert.equal(emailPage.headers.get("x-frame-options"), "DENY");
  const emailHtml = await emailPage.text();
  assert.match(emailHtml, /<h1>Sign in to Localbox<\/h1>/); assert.match(emailHtml, /type="email"/); assert.match(emailHtml, />Send code</);
  for (const [name, value] of Object.entries(params)) assert.ok(emailHtml.includes(`name="${name}" value="${value}"`), `hidden ${name}`);

  const codePage = await call("/oauth/authorize", form({ ...params, step: "email", email: "Agent@Example.com" }));
  assert.equal(codePage.status, 200);
  const codeHtml = text(await codePage.text());
  assert.equal(sent.length, 1); assert.equal(sent[0].to, "agent@example.com");
  assert.ok(codeHtml.includes("Signing in gives Claude (claude.ai) full access to your Localbox account: it can create, use and delete sandboxes on all your machines."), codeHtml);
  assert.match(codeHtml, /Sign in/);

  const wrong = sent[0].code === "000000" ? "000001" : "000000";
  const retry = await call("/oauth/authorize", form({ ...params, step: "code", email: "agent@example.com", code: wrong }));
  assert.equal(retry.status, 400);
  const retryHtml = text(await retry.text());
  assert.match(retryHtml, /That code is wrong or has expired/);
  assert.ok(retryHtml.includes("full access to your Localbox account"), "a wrong code re-renders the same grant");

  const redirected = await call("/oauth/authorize", form({ ...params, step: "code", email: "agent@example.com", code: sent[0].code }));
  assert.equal(redirected.status, 302);
  const location = new URL(redirected.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, redirectUri);
  assert.equal(location.searchParams.get("state"), "xyz");
  const code = location.searchParams.get("code")!; assert.ok(code);

  const exchange = (fields: Record<string, string>) => call("/oauth/token", form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: pair.verifier, resource: RESOURCE, ...fields }));
  const tokens = await (await exchange({})).json() as Record<string, any>;
  assert.equal(tokens.token_type, "Bearer"); assert.equal(tokens.scope, "account"); assert.equal(tokens.expires_in, 900);
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal((await exchange({})).status, 400, "a code works once");
  await assert.rejects(() => oauth.validateAccessToken(tokens.access_token), "reusing a code revokes what it issued");

  // A second sign-in on the same email, which now has an account, still names no account before the code is checked.
  const again = pkcePair(); const againParams = authorizeParams(client.client_id, redirectUri, again.challenge);
  const unnamed = text(await (await call("/oauth/authorize", form({ ...againParams, step: "email", email: "agent@example.com" }))).text());
  assert.ok(unnamed.includes("full access to your Localbox account:"), unnamed);
  const wrongAgain = sent.at(-1)!.code === "000000" ? "000001" : "000000";
  const retried = text(await (await call("/oauth/authorize", form({ ...againParams, step: "code", email: "agent@example.com", code: wrongAgain }))).text());
  assert.ok(retried.includes("full access to your Localbox account:") && !/full access to account /.test(retried), "a wrong code does not reveal the account either");
  const second = await call("/oauth/authorize", form({ ...againParams, step: "code", email: "agent@example.com", code: sent.at(-1)!.code }));
  const secondCode = new URL(second.headers.get("location")!).searchParams.get("code")!;
  const fresh = await (await call("/oauth/token", form({ grant_type: "authorization_code", code: secondCode, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: again.verifier, resource: RESOURCE }))).json() as Record<string, any>;
  assert.ok((await oauth.validateAccessToken(fresh.access_token)).accountId);

  const refreshed = await (await call("/oauth/token", form({ grant_type: "refresh_token", refresh_token: fresh.refresh_token, client_id: client.client_id }))).json() as Record<string, any>;
  assert.ok(refreshed.access_token && refreshed.refresh_token); assert.notEqual(refreshed.refresh_token, fresh.refresh_token);
  await oauth.validateAccessToken(refreshed.access_token);

  const replay = await call("/oauth/token", form({ grant_type: "refresh_token", refresh_token: fresh.refresh_token, client_id: client.client_id }));
  assert.equal(replay.status, 400); assert.equal((await replay.json() as any).error, "invalid_grant");
  await assert.rejects(() => oauth.validateAccessToken(refreshed.access_token), "replay revokes the family's newest token");
  assert.equal((await call("/oauth/token", form({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token }))).status, 400);
});

test("authorize refuses an unregistered redirect, a missing S256 challenge and another resource", async () => {
  const { call, register, authorizeParams, sent } = oauthFixture();
  const client = await register("https://claude.ai/api/mcp/auth_callback");
  const pair = pkcePair(); const params = authorizeParams(client.client_id, "https://claude.ai/api/mcp/auth_callback", pair.challenge);
  const refused = async (overrides: Record<string, string | undefined>, pattern: RegExp) => {
    const query = Object.fromEntries(Object.entries({ ...params, ...overrides }).filter(([, value]) => value !== undefined)) as Record<string, string>;
    const response = await call(`/oauth/authorize?${new URLSearchParams(query)}`);
    assert.equal(response.status, 400); assert.equal(response.headers.get("location"), null, "never redirects an unchecked request");
    assert.match(text(await response.text()), pattern);
    const posted = await call("/oauth/authorize", form({ ...query, step: "email", email: "x@example.com" }));
    assert.equal(posted.status, 400, "the post re-checks the carried parameters");
  };
  await refused({ redirect_uri: "https://evil.test/callback" }, /return address/);
  await refused({ redirect_uri: "https://claude.ai/api/mcp/auth_callback/extra" }, /return address/);
  await refused({ client_id: "client_unknown" }, /isn't registered/);
  await refused({ code_challenge_method: undefined }, /S256/);
  await refused({ code_challenge_method: "plain" }, /S256/);
  await refused({ resource: "https://other.test/mcp" }, /resource/);
  await refused({ resource: undefined }, /resource/);
  await refused({ scope: "account admin" }, /scope/);
  assert.equal(sent.length, 0, "no email goes out for a refused request");
});
