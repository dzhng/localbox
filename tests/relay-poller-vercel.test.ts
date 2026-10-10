import assert from "node:assert/strict";
import { test } from "node:test";
import { createVercelRelayHandler, RelayHostPoller } from "../apps/relay/src/index.js";
import { createLocalConvexHarness } from "../packages/state/src/index.js";

test("Vercel handler maps Web Requests to the stateless relay adapter", async () => {
  const harness = await createLocalConvexHarness();
  const repo = harness.client();
  const owner = await repo.createOwner({ subject: "vercel-user" });
  await repo.createVm({ ownerId: owner.ownerId, vmId: "vm_01" });
  await repo.issueOAuthTokens({ ownerId: owner.ownerId, vmId: "vm_01", resource: "https://relay.test/mcp", accessToken: "access", refreshToken: "refresh", accessExpiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 60_000 });
  const handle = createVercelRelayHandler(repo, { resource: "https://relay.test/mcp" });
  const response = await handle(new Request("https://relay.test/v1/requests", { method: "POST", headers: { authorization: "Bearer access", "content-type": "application/json" }, body: JSON.stringify({ request_id: "req", operation: "system.info", vm_id: "vm_01", payload: {} }) }));
  assert.equal(response.status, 202);
  assert.equal((await response.json()).request_id, "req");
});

test("host poller dispatches leased frames and posts the response", async () => {
  const harness = await createLocalConvexHarness();
  const repo = harness.client();
  const owner = await repo.createOwner({ subject: "poller-user" });
  await repo.createVm({ ownerId: owner.ownerId, vmId: "vm_01" });
  await repo.issueChannelGrant({ ownerId: owner.ownerId, vmId: "vm_01", channelId: "ch", token: "token" });
  await repo.enqueueRequest({ ownerId: owner.ownerId, vmId: "vm_01", requestId: "req", operation: "system.info", payload: { ok: true } });
  const { RelayHttpAdapter } = await import("../apps/relay/src/http.js");
  const relay = new RelayHttpAdapter({ repository: repo, resource: "https://relay.test/mcp" });
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input); const headers = Object.fromEntries(new Headers(init.headers).entries()); const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const result = await relay.handle({ method: init.method ?? "GET", url, headers, body });
    return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
  };
  const poller = new RelayHostPoller({ relayUrl: "https://relay.test", channelId: "ch", channelToken: "token", channelEpoch: 1, vmId: "vm_01", leaseOwner: "host", fetchImpl, dispatch: async (request) => ({ protocol_version: "v1", request_id: request.request_id, operation: request.operation, vm_id: request.vm_id, release_id: "agent-computer-contract-v1", ok: true, result: { ready: true } }) });
  assert.equal(await poller.pollOnce(), 1);
  assert.equal((await repo.getResponse("req"))?.responseHash.length, 64);
});
