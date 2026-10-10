import assert from "node:assert/strict";
import test from "node:test";
import { createConvexTestHarness, ConvexRelayStateRepository } from "../packages/state/src/index.js";

test("production Convex schema and relay functions run in the local Convex harness", async () => {
  const convex = createConvexTestHarness();
  const repository = new ConvexRelayStateRepository({
    mutation: (ref, args) => convex.mutation(ref, args),
    query: (ref, args) => convex.query(ref, args),
  }, "test-deployment");
  const owner = await repository.createOwner({ ownerId: "owner_test", subject: "subject_test" });
  await repository.createVm({ ownerId: owner.ownerId, vmId: "vm_test" });
  const queued = await repository.enqueueRequest({ ownerId: owner.ownerId, vmId: "vm_test", requestId: "request_test", operation: "shell.exec", payload: { command: "true" } });
  const claimed = await repository.claimRequests({ leaseOwner: "host_test" });
  assert.equal(claimed[0]?.frameId, queued.frameId);
  await repository.recordResponse({ requestId: queued.requestId, leaseOwner: "host_test", response: { exitCode: 0 } });
  assert.deepEqual((await repository.getResponse(queued.requestId))?.response, { exitCode: 0 });
});

