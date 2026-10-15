import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalConvexHarness, StateConflictError, StateUnauthorizedError, pkceChallenge } from "../packages/state/src/index.js";

test("local Convex harness preserves state across restart and refuses use after close", async () => {
  const harness = await createLocalConvexHarness();
  await harness.pushSchema(); const repo = harness.client();
  const owner = await repo.createOwner({ subject: "user_1" }); await repo.createVm({ ownerId: owner.ownerId, vmId: "vm_01" });
  await assert.rejects(() => repo.createVm({ ownerId: owner.ownerId, vmId: "vm_01" }), StateConflictError);
  const restarted = await harness.restart(); assert.deepEqual((await restarted.listVms(owner.ownerId)).map((vm) => vm.vmId), ["vm_01"]);
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
