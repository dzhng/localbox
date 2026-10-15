import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpHandler } from "../apps/mcp/api/[...path].js";
import type { Principal } from "../apps/relay/src/ops.js";
import { oauthFixture, RESOURCE } from "./fixtures/oauth-server.js";

function handler() {
  const fixture = oauthFixture(); const calls: Array<{ principal: Principal; input: Record<string, unknown> }> = [];
  const handle = createMcpHandler({ oauth: fixture.oauth, ops: async (principal, input) => { calls.push({ principal, input }); return { status: 200, body: [{ machineId: "m_b", name: "attic" }] }; } });
  return { ...fixture, handle, calls };
}
const mcp = (token: string, body: unknown) => new Request(RESOURCE, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

test("the MCP entry serves OAuth metadata on both the well-known paths and Vercel's rewrite", async () => {
  const { handle } = handler();
  for (const path of ["/.well-known/oauth-protected-resource", "?metadata=oauth-protected-resource"]) {
    const response = await handle(new Request(`${RESOURCE}${path}`)); assert.equal(response.status, 200);
    assert.equal((await response.json() as any).resource, RESOURCE);
  }
  const server = await (await handle(new Request(`${RESOURCE}?metadata=oauth-authorization-server`))).json() as any;
  assert.equal(server.registration_endpoint, `${RESOURCE}/oauth/register`);
});

test("an MCP call with a signed-in token reaches the agent API as that account, never as a machine", async () => {
  const { handle, signIn, calls, oauth } = handler();
  const unauthenticated = await handle(new Request(RESOURCE, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
  assert.equal(unauthenticated.status, 401); assert.match(unauthenticated.headers.get("www-authenticate")!, /resource_metadata=/);
  const tokens = await signIn("vercel@example.com");
  const grant = await oauth.validateAccessToken(tokens.access_token);
  const response = await handle(mcp(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "machine.list", arguments: {} } }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse((await response.json() as any).result.content[0].text), [{ machineId: "m_b", name: "attic" }]);
  assert.deepEqual(calls, [{ principal: { accountId: grant.accountId, familyId: grant.familyId }, input: { operation: "machine.list", input: {} } }]);
  await oauth.revoke(tokens.access_token, "access_token");
  assert.equal((await handle(mcp(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/list" }))).status, 401);
});

test("the MCP entry rejects malformed JSON before dispatch and malformed OAuth bodies as client errors", async () => {
  const { handle } = handler();
  const response = await handle(new Request(RESOURCE, { method: "POST", body: "{" }));
  assert.equal(response.status, 400); assert.equal((await response.json() as any).error, "invalid_json");
  const token = await handle(new Request(`${RESOURCE}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }));
  assert.equal(token.status, 400); assert.equal((await token.json() as any).error, "invalid_request");
});
