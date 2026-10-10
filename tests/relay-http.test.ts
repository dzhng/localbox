import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalConvexHarness } from "../packages/state/src/index.js";
import { RelayHttpAdapter } from "../apps/relay/src/http.js";

test("stateless relay routes submit, host poll/complete, replay, heartbeat and revoke", async () => {
  let now = 1_700_000_000_000;
  const harness = await createLocalConvexHarness({ now: () => now, id: (() => { let i = 0; return (p: string) => `${p}_${++i}`; })() }); const repo = harness.client();
  const owner = await repo.createOwner({ subject: "relay-user" }); await repo.createVm({ ownerId: owner.ownerId, vmId: "vm_01" });
  const oauth = await repo.issueOAuthTokens({ ownerId: owner.ownerId, vmId: "vm_01", resource: "https://relay.test/mcp", accessToken: "access", refreshToken: "refresh", accessExpiresAt: now + 1000, refreshExpiresAt: now + 1000 });
  await repo.issueChannelGrant({ ownerId: owner.ownerId, vmId: "vm_01", channelId: "channel_1", token: "channel-token" });
  const relay = new RelayHttpAdapter({ repository: repo, resource: "https://relay.test/mcp" }); const auth = { authorization: `Bearer access` }; const host = { "x-channel-id": "channel_1", "x-channel-token": "channel-token", "x-channel-epoch": "1", "x-vm-id": "vm_01" };
  const submitted = await relay.handle({ method: "POST", url: "https://relay.test/agent/requests", headers: auth, body: { request_id: "req_1", operation: "shell.exec", vm_id: "vm_01", mutation_id: "mut_1", payload: { command: "echo hi" } } }); assert.equal(submitted.status, 202);
  const poll = await relay.handle({ method: "POST", url: "https://relay.test/host/poll", headers: host, body: { lease_owner: "host_a" } }); assert.equal(poll.status, 200); assert.equal((poll.body as any).frames.length, 1);
  const complete = await relay.handle({ method: "POST", url: "https://relay.test/host/responses/req_1", headers: host, body: { lease_owner: "host_a", response: { ok: true, result: "done" } } }); assert.equal(complete.status, 200);
  const response = await relay.handle({ method: "GET", url: "https://relay.test/agent/responses/req_1", headers: auth }); assert.equal((response.body as any).response.result, "done");
  const heartbeat = await relay.handle({ method: "POST", url: "https://relay.test/host/heartbeat", headers: host, body: {} }); assert.equal(heartbeat.status, 200);
  const status = await relay.handle({ method: "GET", url: "https://relay.test/status", headers: auth }); assert.equal((status.body as any).queued, 0);
  const revoked = await relay.handle({ method: "POST", url: "https://relay.test/channels/channel_1/revoke", headers: auth, body: {} }); assert.equal(revoked.status, 200);
  const stale = await relay.handle({ method: "POST", url: "https://relay.test/host/heartbeat", headers: host, body: {} }); assert.equal(stale.status, 401);
  assert.equal(oauth.refreshTokenHash.length > 0, true);
});

test("relay rejects auth, VM mismatch, conflicting mutation and stale lease", async () => {
  let now = 1_700_000_000_000; const harness = await createLocalConvexHarness({ now: () => now }); const repo = harness.client(); const owner = await repo.createOwner({ subject: "user" }); await repo.createVm({ ownerId: owner.ownerId, vmId: "vm_01" });
  await repo.issueOAuthTokens({ ownerId: owner.ownerId, vmId: "vm_01", resource: "https://relay.test/mcp", accessToken: "access", refreshToken: "refresh", accessExpiresAt: now + 1000, refreshExpiresAt: now + 1000 }); await repo.issueChannelGrant({ ownerId: owner.ownerId, vmId: "vm_01", token: "token", channelId: "ch" });
  const relay = new RelayHttpAdapter({ repository: repo, resource: "https://relay.test/mcp" });
  assert.equal((await relay.handle({ method: "POST", url: "https://relay.test/agent/requests", body: {} })).status, 401);
  assert.equal((await relay.handle({ method: "POST", url: "https://relay.test/agent/requests", headers: { authorization: "Bearer access" }, body: { request_id: "r", operation: "x", vm_id: "other", payload: {} } })).status, 401);
  const base = { request_id: "r", operation: "x", vm_id: "vm_01", mutation_id: "m", payload: { x: 1 } }; assert.equal((await relay.handle({ method: "POST", url: "https://relay.test/agent/requests", headers: { authorization: "Bearer access" }, body: base })).status, 202);
  assert.equal((await relay.handle({ method: "POST", url: "https://relay.test/agent/requests", headers: { authorization: "Bearer access" }, body: { ...base, payload: { x: 2 } } })).status, 409);
  const host = { "x-channel-id": "ch", "x-channel-token": "token", "x-channel-epoch": "1", "x-vm-id": "vm_01" }; await relay.handle({ method: "POST", url: "https://relay.test/host/poll", headers: host, body: { lease_owner: "a", lease_ms: 5 } }); now += 6; const redeliver = await relay.handle({ method: "POST", url: "https://relay.test/host/poll", headers: host, body: { lease_owner: "b" } }); assert.equal((redeliver.body as any).frames.length, 1);
});
