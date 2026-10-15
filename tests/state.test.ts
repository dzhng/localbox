import assert from "node:assert/strict";
import { test } from "node:test";
import { createConvexTestHarness, createLocalConvexHarness, StateConflictError, StateUnauthorizedError, pkceChallenge } from "../packages/state/src/index.js";

test("local Convex harness preserves relay state across restart and enforces dedupe/leases", async () => {
  let now = 1_700_000_000_000;
  const harness = await createLocalConvexHarness({ now: () => now, id: (() => { let n = 0; return (prefix: string) => `${prefix}_${++n}`; })() });
  await harness.pushSchema(); const repo = harness.client();
  const owner = await repo.createOwner({ subject: "user_1" }); const vm = await repo.createVm({ ownerId: owner.ownerId, vmId: "vm_01" });
  await repo.issueChannelGrant({ ownerId: owner.ownerId, vmId: vm.vmId, channelId: "channel_1", token: "raw-token" });
  const rotatedChannel = await repo.rotateChannelGrant("channel_1", 1, "next-token");
  assert.equal(rotatedChannel.epoch, 2);
  await assert.rejects(() => repo.validateChannelGrant({ channelId: "channel_1", token: "raw-token", vmId: vm.vmId, epoch: 1 }), StateUnauthorizedError);
  assert.equal((await repo.validateChannelGrant({ channelId: "channel_1", token: "next-token", vmId: vm.vmId, epoch: 2 })).epoch, 2);
  const frame = await repo.enqueueRequest({ ownerId: owner.ownerId, vmId: vm.vmId, requestId: "req_1", operation: "shell.exec", mutationId: "mut_1", payload: { command: "echo hi" } });
  assert.equal((await repo.enqueueRequest({ ownerId: owner.ownerId, vmId: vm.vmId, requestId: "req_1", operation: "shell.exec", mutationId: "mut_1", payload: { command: "echo hi" } })).frameId, frame.frameId);
  await assert.rejects(() => repo.enqueueRequest({ ownerId: owner.ownerId, vmId: vm.vmId, requestId: "req_2", operation: "shell.exec", mutationId: "mut_1", payload: { command: "echo bye" } }), StateConflictError);
  const claimed = await repo.claimRequests({ leaseOwner: "agent_a", leaseMs: 10 }); assert.equal(claimed.length, 1);
  assert.equal((await repo.claimRequests({ leaseOwner: "agent_b" })).length, 0);
  now += 11; assert.equal((await repo.claimRequests({ leaseOwner: "agent_b" })).length, 1);
  await repo.recordResponse({ requestId: "req_1", response: { ok: true }, leaseOwner: "agent_b" });
  const restarted = await harness.restart(); assert.ok(await restarted.getResponse("req_1"));
  await harness.close(); await assert.rejects(() => harness.pushSchema(), StateConflictError);
});

test("OAuth state stores hashes, rotates refresh, and redacts audit output", async () => {
  let now = 1_700_000_000_000; const harness = await createLocalConvexHarness({ now: () => now }); const repo = harness.client();
  const owner = await repo.createOwner({ subject: "oauth_user" }); await repo.createVm({ ownerId: owner.ownerId, vmId: "vm_oauth" });
  const code = await repo.createAuthorizationCode({ ownerId: owner.ownerId, clientId: "client", redirectUri: "https://client/cb", resource: "https://relay/mcp", vmId: "vm_oauth", codeChallenge: pkceChallenge("verifier") });
  assert.notEqual(code.codeHash, code.code); assert.equal((await repo.consumeAuthorizationCode(code.code, "verifier")).vmId, "vm_oauth"); await assert.rejects(() => repo.consumeAuthorizationCode(code.code, "verifier"), StateUnauthorizedError);
  const tokens = await repo.issueOAuthTokens({ ownerId: owner.ownerId, vmId: "vm_oauth", resource: "https://relay/mcp", accessToken: "access", refreshToken: "refresh", accessExpiresAt: now + 100, refreshExpiresAt: now + 1000 });
  const rotated = await repo.rotateRefreshToken("refresh"); assert.equal(rotated.vmId, tokens.vmId); await assert.rejects(() => repo.rotateRefreshToken("refresh"), StateUnauthorizedError);
  await repo.appendAudit({ ownerId: owner.ownerId, operation: "shell.exec", outcome: "success", metadata: { command: "echo", output: "secret" } }); const snapshot = await harness.snapshot(); assert.equal((snapshot.audit[0].metadata as any).output, "[REDACTED]");
});
