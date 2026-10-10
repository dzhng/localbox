import assert from "node:assert/strict";
import { test } from "node:test";
import { FixtureTransport, AgentClient } from "../packages/client/src/index.js";
import { OAuthAuthorizationServer, OAuthError, pkceChallenge } from "../apps/relay/src/oauth.js";
import { McpAdapter } from "../apps/mcp/src/index.js";

test("OAuth metadata, PKCE, VM binding, rotation and family revocation", () => {
  let now = 1_700_000_000;
  const oauth = new OAuthAuthorizationServer({ issuer: "https://relay.test", now: () => now, accessTokenTtlSeconds: 10, refreshReplayGraceSeconds: 2 });
  assert.deepEqual(oauth.protectedResourceMetadata().authorization_servers, ["https://relay.test"]);
  const verifier = "verifier-value";
  const started = oauth.authorize({ response_type: "code", client_id: "client", redirect_uri: "https://client.test/cb", code_challenge: pkceChallenge(verifier), resource: "https://relay.test/mcp", vm_id: "vm_02" });
  const tokens = oauth.token({ grant_type: "authorization_code", code: started.code, client_id: "client", redirect_uri: "https://client.test/cb", code_verifier: verifier, resource: "https://relay.test/mcp" });
  assert.equal(tokens.vm_id, "vm_02");
  assert.equal(oauth.validateAccessToken(tokens.access_token).vm_id, "vm_02");
  assert.throws(() => oauth.validateAccessToken(tokens.access_token, "https://other.test/mcp"), OAuthError);
  assert.throws(() => oauth.validateAccessToken(tokens.access_token, undefined, "vm_01"), OAuthError);
  const rotated = oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  const grace = oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(grace.vm_id, "vm_02");
  now += 3;
  assert.throws(() => oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }), OAuthError);
  assert.throws(() => oauth.validateAccessToken(rotated.access_token), OAuthError);
});

test("MCP Streamable HTTP initialize/list/call and auth/origin mapping", async () => {
  const oauth = new OAuthAuthorizationServer({ issuer: "https://relay.test" });
  const verifier = "mcp-verifier";
  const code = oauth.authorize({ response_type: "code", client_id: "mcp", redirect_uri: "https://client.test/cb", code_challenge: pkceChallenge(verifier) }).code;
  const token = oauth.token({ grant_type: "authorization_code", code, client_id: "mcp", redirect_uri: "https://client.test/cb", code_verifier: verifier });
  const adapter = new McpAdapter({ oauth, client: new AgentClient({ transport: new FixtureTransport("local") }), allowedOrigins: ["https://client.test"] });
  const unauth = await adapter.handle({ method: "POST", url: "https://relay.test/mcp", headers: { origin: "https://client.test" }, body: { jsonrpc: "2.0", id: 1, method: "initialize" } });
  assert.equal(unauth.status, 401);
  const badOrigin = await adapter.handle({ method: "POST", url: "https://relay.test/mcp", headers: { origin: "https://evil.test", authorization: `Bearer ${token.access_token}` }, body: { jsonrpc: "2.0", id: 1, method: "initialize" } });
  assert.equal(badOrigin.status, 403);
  const initialize = await adapter.handle({ method: "POST", url: "https://relay.test/mcp", headers: { origin: "https://client.test", authorization: `Bearer ${token.access_token}` }, body: { jsonrpc: "2.0", id: 1, method: "initialize" } });
  assert.equal((initialize.body as any).result.protocolVersion, "2025-06-18");
  const listed = await adapter.handle({ method: "POST", url: "https://relay.test/mcp", headers: { authorization: `Bearer ${token.access_token}` }, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
  assert.ok((listed.body as any).result.tools.some((tool: any) => tool.name === "shell.exec"));
  const called = await adapter.handle({ method: "POST", url: "https://relay.test/mcp", headers: { authorization: `Bearer ${token.access_token}` }, body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "system.info", arguments: {} } } });
  assert.equal((called.body as any).result.structuredContent.vm_id, token.vm_id);
  const get = await adapter.handle({ method: "GET", url: "https://relay.test/mcp", headers: { authorization: `Bearer ${token.access_token}` } });
  assert.equal(get.status, 200);
});

test("MCP accepts a durable access-token validator without owning OAuth state", async () => {
  const adapter = new McpAdapter({
    endpoint: "https://relay.test/mcp",
    client: new AgentClient({ transport: new FixtureTransport("local") }),
    accessTokenValidator: (token) => token === "durable" ? { vm_id: "vm_01" } : (() => { throw new Error("invalid token"); })(),
  });
  const response = await adapter.handle({ method: "POST", url: "https://relay.test/mcp", headers: { authorization: "Bearer durable" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  assert.equal(response.status, 200);
  const denied = await adapter.handle({ method: "POST", url: "https://relay.test/mcp", headers: { authorization: "Bearer other" }, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
  assert.equal(denied.status, 401);
});
