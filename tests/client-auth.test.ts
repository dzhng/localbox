import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizationUrl, createPkcePair, exchangeAuthorizationCode, refreshAccessToken } from "../packages/client/src/auth.js";

test("PKCE helpers build an S256 authorization request and exchange tokens", async () => {
  const pair = createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]+$/);
  const url = new URL(authorizationUrl({ endpoint: "https://relay.test/oauth/authorize", clientId: "cli", redirectUri: "http://127.0.0.1/cb", resource: "https://relay.test/mcp", challenge: pair.challenge, state: "state" }));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const fetchImpl: typeof fetch = async (_input, init) => {
    assert.equal(init?.method, "POST");
    const form = new URLSearchParams(String(init?.body));
    if (form.get("grant_type") === "authorization_code") assert.equal(form.get("code_verifier"), pair.verifier);
    return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh" }), { status: 200 });
  };
  const token = await exchangeAuthorizationCode({ endpoint: "https://relay.test/oauth/token", code: "code", clientId: "cli", redirectUri: "http://127.0.0.1/cb", verifier: pair.verifier, fetchImpl });
  assert.equal(token.access_token, "access");
  const refreshed = await refreshAccessToken({ endpoint: "https://relay.test/oauth/token", refreshToken: "refresh", clientId: "cli", fetchImpl });
  assert.equal(refreshed.refresh_token, "refresh");
});
