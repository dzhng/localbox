import assert from "node:assert/strict";
import { test } from "node:test";
import handle from "../apps/mcp/api/[...path].js";
import { createPkcePair } from "../packages/client/src/auth.js";

test("MCP Vercel handler exposes OAuth metadata, redirects authorization, and exchanges PKCE", async () => {
  const metadata = await handle(new Request("https://relay.test/.well-known/oauth-protected-resource"));
  assert.equal(metadata.status, 200);
  assert.deepEqual((await metadata.json()).resource, "https://relay.example.test/mcp");
  const pair = createPkcePair();
  const authorize = await handle(new Request(`https://relay.test/oauth/authorize?response_type=code&client_id=cli&redirect_uri=${encodeURIComponent("http://127.0.0.1:43123/oauth/callback")}&code_challenge=${pair.challenge}&code_challenge_method=S256&state=state`));
  assert.equal(authorize.status, 302);
  const location = authorize.headers.get("location"); assert.ok(location);
  const code = new URL(location).searchParams.get("code"); assert.ok(code);
  const token = await handle(new Request("https://relay.test/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: "cli", redirect_uri: "http://127.0.0.1:43123/oauth/callback", code_verifier: pair.verifier }).toString() }));
  assert.equal(token.status, 200);
  assert.equal(typeof (await token.json()).access_token, "string");
});

test("MCP Vercel handler rejects malformed JSON before dispatch", async () => {
  const response = await handle(new Request("https://relay.test/mcp", { method: "POST", body: "{" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_json");
});

