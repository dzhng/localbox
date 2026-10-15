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
