import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayHttpAdapter } from "../apps/relay/src/http.js";
import { RelayHttpTransport } from "../packages/client/src/index.js";
import { createLocalConvexHarness } from "../packages/state/src/index.js";

test("RelayHttpTransport submits and polls through the stateless adapter", async () => {
  const harness = await createLocalConvexHarness({ id: (() => { let i = 0; return (prefix: string) => `${prefix}_${++i}`; })() });
  const repo = harness.client();
  const owner = await repo.createOwner({ subject: "client-user" });
  await repo.createVm({ ownerId: owner.ownerId, vmId: "vm_01" });
  await repo.issueOAuthTokens({ ownerId: owner.ownerId, vmId: "vm_01", resource: "https://relay.test/mcp", accessToken: "access", refreshToken: "refresh", accessExpiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 60_000 });
  await repo.issueChannelGrant({ ownerId: owner.ownerId, vmId: "vm_01", channelId: "channel_1", token: "channel-token" });
  const relay = new RelayHttpAdapter({ repository: repo, resource: "https://relay.test/mcp" });
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    if (url.endsWith("/v1/requests") && init.method === "POST") {
      const result = await relay.handle({ method: "POST", url, headers, body });
      return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
    }
    if (url.includes("/v1/requests/") && init.method === "GET") {
      const requestId = url.split("/").at(-1)!;
      const hostHeaders = { "x-channel-id": "channel_1", "x-channel-token": "channel-token", "x-channel-epoch": "1", "x-vm-id": "vm_01" };
      const poll = await relay.handle({ method: "POST", url: "https://relay.test/host/poll", headers: hostHeaders, body: { lease_owner: "host_1" } });
      const frame = (poll.body as { frames: Array<{ request_id: string }> }).frames[0];
      if (frame) await relay.handle({ method: "POST", url: `https://relay.test/host/responses/${frame.request_id}`, headers: hostHeaders, body: { lease_owner: "host_1", response: { protocol_version: "v1", request_id: requestId, operation: "system.info", vm_id: "vm_01", release_id: "agent-computer-contract-v1", ok: true, result: { ready: true } } } });
      const result = await relay.handle({ method: "GET", url, headers });
      return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  };
  const client = new RelayHttpTransport({ baseUrl: "https://relay.test", accessToken: "access", fetchImpl, pollMs: 1 });
  const response = await client.dispatch({ protocol_version: "v1", request_id: "req_client", operation: "system.info", vm_id: "vm_01", deadline_ms: 1000, mutation_id: null, input: {} });
  assert.equal(response.ok, true);
  assert.deepEqual(response.ok && response.result, { ready: true });
});
