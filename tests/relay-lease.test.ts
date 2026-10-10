import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFunctionReference } from "convex/server";
import { RelayHttpAdapter } from "../apps/relay/src/http.js";
import { createConvexTestHarness, createLocalConvexHarness, StateConflictError } from "../packages/state/src/index.js";

test("in-memory response recording requires the active lease owner", async () => {
  const harness = await createLocalConvexHarness();
  const repository = harness.client();
  const owner = await repository.createOwner({ subject: "lease-owner" });
  await repository.createVm({ ownerId: owner.ownerId, vmId: "vm_01" });
  await repository.enqueueRequest({ ownerId: owner.ownerId, vmId: "vm_01", requestId: "request-1", operation: "system.info", payload: {} });

  await assert.rejects(() => repository.recordResponse({ requestId: "request-1", response: { ok: true } }), StateConflictError);
  await repository.claimRequests({ ownerId: owner.ownerId, vmId: "vm_01", leaseOwner: "host-a" });
  await assert.rejects(() => repository.recordResponse({ requestId: "request-1", response: { ok: true } }), StateConflictError);
  await assert.rejects(() => repository.recordResponse({ requestId: "request-1", leaseOwner: "host-b", response: { ok: true } }), StateConflictError);
  await repository.recordResponse({ requestId: "request-1", leaseOwner: "host-a", response: { ok: true } });
});

test("Convex response mutation rejects an unleased or unowned request", async () => {
  const harness = createConvexTestHarness();
  const write = makeFunctionReference("relay:write") as any;
  const owner = await harness.mutation(write, { operation: "createOwner", input: { subject: "convex-lease-owner" } }) as { ownerId: string };
  await harness.mutation(write, { operation: "createVm", input: { ownerId: owner.ownerId, vmId: "vm_01" } });
  await harness.mutation(write, { operation: "enqueueRequest", input: { ownerId: owner.ownerId, vmId: "vm_01", requestId: "request-1", operation: "system.info", payload: {} } });

  await assert.rejects(() => harness.mutation(write, { operation: "recordResponse", input: { requestId: "request-1", response: { ok: true } } }));
  await harness.mutation(write, { operation: "claimRequests", input: { ownerId: owner.ownerId, vmId: "vm_01", leaseOwner: "host-a" } });
  await assert.rejects(() => harness.mutation(write, { operation: "recordResponse", input: { requestId: "request-1", leaseOwner: "host-b", response: { ok: true } } }));
  await harness.mutation(write, { operation: "recordResponse", input: { requestId: "request-1", leaseOwner: "host-a", response: { ok: true } } });
});

test("relay host response route requires lease_owner before completing a frame", async () => {
  const harness = await createLocalConvexHarness();
  const repository = harness.client();
  const owner = await repository.createOwner({ subject: "relay-lease-owner" });
  await repository.createVm({ ownerId: owner.ownerId, vmId: "vm_01" });
  await repository.issueOAuthTokens({ ownerId: owner.ownerId, vmId: "vm_01", resource: "https://relay.test/mcp", accessToken: "access", refreshToken: "refresh", accessExpiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 60_000 });
  await repository.issueChannelGrant({ ownerId: owner.ownerId, vmId: "vm_01", channelId: "channel-1", token: "channel-token" });
  const relay = new RelayHttpAdapter({ repository, resource: "https://relay.test/mcp" });
  const auth = { authorization: "Bearer access" };
  const channel = { "x-channel-id": "channel-1", "x-channel-token": "channel-token", "x-channel-epoch": "1", "x-vm-id": "vm_01" };
  await relay.handle({ method: "POST", url: "https://relay.test/v1/requests", headers: auth, body: { request_id: "request-1", operation: "system.info", vm_id: "vm_01", payload: {} } });
  const response = { protocol_version: "v1", request_id: "request-1", operation: "system.info", vm_id: "vm_01", release_id: "agent-computer-contract-v1", ok: true, result: {} };
  const missingOwner = await relay.handle({ method: "POST", url: "https://relay.test/host/responses/request-1", headers: channel, body: { response } });
  assert.equal(missingOwner.status, 409);
  await relay.handle({ method: "POST", url: "https://relay.test/host/poll", headers: channel, body: { lease_owner: "host-a" } });
  const completed = await relay.handle({ method: "POST", url: "https://relay.test/host/responses/request-1", headers: channel, body: { lease_owner: "host-a", response } });
  assert.equal(completed.status, 200);
});
