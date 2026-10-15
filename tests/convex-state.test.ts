import assert from "node:assert/strict";
import test from "node:test";
import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../packages/state/src/index.js";

const ref = (name: string) => makeFunctionReference(name) as any;
test("typed authenticated Convex functions run the relay state machine", async () => {
  const t = createConvexTestHarness();
  const service = t.withIdentity({ subject: "service:api" });
  const owner = await service.mutation(ref("owners:create"), { ownerId: "owner_test", subject: "subject_test" }) as any;
  await service.mutation(ref("vms:create"), { ownerId: owner.ownerId, vmId: "vm_test" });
  await assert.rejects(() => service.mutation(ref("vms:create"), { ownerId: owner.ownerId, vmId: "vm_test" }), /already exists/);
  await service.mutation(ref("channels:issue"), { ownerId: owner.ownerId, vmId: "vm_test", channelId: "channel_test", token: "token_test" });
  const rotated = await service.mutation(ref("channels:rotate"), { channelId: "channel_test", expectedEpoch: 1, token: "token_rotated" }) as any;
  assert.equal(rotated.epoch, 2);
  await service.mutation(ref("requests:enqueue"), { ownerId: owner.ownerId, vmId: "vm_test", requestId: "request_test", operation: "shell.exec", payload: { command: "true" } });
  const claimed = await t.withIdentity({ subject: "service:api" }).mutation(ref("requests:claim"), { ownerId: owner.ownerId, vmId: "vm_test", leaseOwner: "host_test" });
  assert.equal((claimed as any[])[0]?.requestId, "request_test");
  await t.withIdentity({ subject: "service:api" }).mutation(ref("requests:recordResponse"), { requestId: "request_test", leaseOwner: "host_test", response: { exitCode: 0 } });
  assert.deepEqual((await service.query(ref("requests:getResponse"), { requestId: "request_test" }) as any).response, { exitCode: 0 });
  assert.deepEqual(await service.query(ref("status:owner"), { ownerId: owner.ownerId }), { channels: 1, queued: 0 });
});

test("typed OAuth functions revoke a refresh family on replay", async () => {
  const t = createConvexTestHarness();
  const service = t.withIdentity({ subject: "service:api" });
  const owner = await service.mutation(ref("owners:create"), { ownerId: "owner_replay", subject: "subject_replay" }) as any;
  await service.mutation(ref("vms:create"), { ownerId: owner.ownerId, vmId: "vm_replay" });
  const original = await service.mutation(ref("oauth:issue"), { ownerId: owner.ownerId, vmId: "vm_replay", resource: "https://relay.test/mcp", accessToken: "access_original", refreshToken: "refresh_original", accessExpiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 60_000 }) as any;
  const rotated = await service.mutation(ref("oauth:rotateRefresh"), { refreshToken: "refresh_original" }) as any;
  assert.equal((await service.mutation(ref("oauth:rotateRefresh"), { refreshToken: "refresh_original" }) as any).__error, "refresh_replay_revoked_family");
  await assert.rejects(() => service.query(ref("oauth:validateAccess"), { accessToken: rotated.accessToken, resource: "https://relay.test/mcp" }), /invalid|expired/);
  assert.ok(original.familyId);
});
