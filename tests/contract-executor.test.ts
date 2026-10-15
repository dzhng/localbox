import assert from "node:assert/strict";
import { test } from "node:test";
import { ContractError, hostOperationIds, operationCatalog, PROTOCOL_VERSION, validateRequest, type OperationId, type RequestEnvelope } from "../packages/contract/src/index.js";
import { sampleInput } from "../packages/runtime/src/index.js";

/** Where each operation runs, written out so a catalog change has to restate it. */
const account = ["account.status", "account.rename", "machine.list", "machine.rename", "machine.remove", "sandbox.create", "sandbox.list", "sandbox.rename", "sandbox.delete"];
const host = ["sandbox.status", "sandbox.resize", "sandbox.start", "sandbox.stop", "sandbox.sleep", "sandbox.logs", "system.info", "network.egress", "relay.status"];
const withoutSandbox = ["account.status", "account.rename", "machine.list", "machine.rename", "machine.remove", "sandbox.create", "sandbox.list", "relay.status"];

const request = (operation: OperationId, sandboxId: string | null): RequestEnvelope => ({ protocol_version: PROTOCOL_VERSION, request_id: "r", operation, sandbox_id: sandboxId, deadline_ms: 1000, mutation_id: "m", input: sampleInput(operation) });

test("every operation runs on the account, the host or the guest", () => {
  for (const entry of operationCatalog) assert.equal(entry.executor, account.includes(entry.id) ? "account" : host.includes(entry.id) ? "host" : "guest", entry.id);
  assert.ok(!operationCatalog.some((entry) => entry.id.startsWith("vm.")), "no vm.* operation survives");
});

test("account and machine operations, create, list and relay.status carry sandbox_id null; every other operation names one sandbox", () => {
  for (const entry of operationCatalog) {
    const scoped = !withoutSandbox.includes(entry.id);
    assert.equal(entry.sandbox_scoped, scoped, entry.id);
    assert.doesNotThrow(() => validateRequest(request(entry.id, scoped ? "sandbox_1" : null)), entry.id);
    assert.throws(() => validateRequest(request(entry.id, scoped ? null : "sandbox_1")), (error) => error instanceof ContractError && error.code === "invalid_input", entry.id);
  }
});

test("HostDaemon routes the host executor and every sandbox.* operation itself", () => {
  assert.deepEqual(new Set(hostOperationIds()), new Set([...host, "sandbox.create", "sandbox.list", "sandbox.rename", "sandbox.delete"]));
});
