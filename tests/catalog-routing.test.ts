import assert from "node:assert/strict";
import { test } from "node:test";
import { ContractError, hostOperationIds, operationCatalog, operationIds, PROTOCOL_VERSION, validateRequest, type Executor, type OperationId, type RequestEnvelope, type Routing } from "../packages/contract/src/index.js";
import { sampleInput } from "../packages/runtime/src/index.js";

/** Every operation's executor, whether it names a sandbox, and where the relay sends it, written out so a new operation has to state all three. */
const routes: Record<OperationId, [Executor, boolean, Routing]> = {
  "account.status": ["account", false, "account"], "account.rename": ["account", false, "account"],
  "machine.list": ["account", false, "account"], "machine.rename": ["account", false, "account"], "machine.remove": ["account", false, "account"],
  "sandbox.create": ["account", false, "machine"], "sandbox.list": ["account", false, "account"],
  "sandbox.rename": ["account", true, "machine"], "sandbox.delete": ["account", true, "machine"],
  "image.create": ["account", false, "machine"], "image.list": ["account", false, "account"], "image.rename": ["account", false, "account"],
  "image.copy": ["account", false, "machine"], "image.default": ["account", false, "account"],
  "image.delete": ["account", false, "holders"], "image.wait": ["account", false, "holders"],
  "system.info": ["host", true, "machine"], "sandbox.status": ["host", true, "machine"], "sandbox.resize": ["host", true, "machine"],
  "sandbox.start": ["host", true, "machine"], "sandbox.stop": ["host", true, "machine"], "sandbox.sleep": ["host", true, "machine"], "sandbox.logs": ["host", true, "machine"],
  "relay.status": ["host", false, "machine"],
  "skill.status": ["host", false, "machine"], "skill.install": ["host", false, "machine"], "skill.update": ["host", false, "machine"], "skill.uninstall": ["host", false, "machine"],
  "cli.status": ["host", false, "machine"], "agents.setup.status": ["host", false, "machine"], "agents.setup.set": ["host", false, "machine"],
  "network.egress": ["guest", true, "machine"], "shell.exec": ["guest", true, "machine"],
  "job.status": ["guest", true, "machine"], "job.wait": ["guest", true, "machine"], "job.cancel": ["guest", true, "machine"], "job.output": ["guest", true, "machine"],
  "guest.activity": ["guest", true, "machine"],
  "fs.list": ["guest", true, "machine"], "fs.stat": ["guest", true, "machine"], "fs.read": ["guest", true, "machine"], "fs.write": ["guest", true, "machine"], "fs.mkdir": ["guest", true, "machine"], "fs.remove": ["guest", true, "machine"],
  "browser.list_tabs": ["guest", true, "machine"], "browser.open": ["guest", true, "machine"], "browser.navigate": ["guest", true, "machine"], "browser.focus": ["guest", true, "machine"],
  "browser.close": ["guest", true, "machine"], "browser.screenshot": ["guest", true, "machine"], "browser.click": ["guest", true, "machine"], "browser.type": ["guest", true, "machine"], "browser.key": ["guest", true, "machine"],
  "desktop.status": ["guest", true, "machine"], "desktop.screenshot": ["guest", true, "machine"], "desktop.click": ["guest", true, "machine"], "desktop.move": ["guest", true, "machine"],
  "desktop.scroll": ["guest", true, "machine"], "desktop.key": ["guest", true, "machine"], "desktop.type": ["guest", true, "machine"],
};

const request = (operation: OperationId, sandboxId: string | null): RequestEnvelope => ({ protocol_version: PROTOCOL_VERSION, request_id: "r", operation, sandbox_id: sandboxId, deadline_ms: 1000, mutation_id: "m", input: sampleInput(operation) });
const invalid = (error: unknown) => error instanceof ContractError && error.code === "invalid_input";

test("every operation states its executor, sandbox scope and routing", () => {
  assert.deepEqual(new Set(Object.keys(routes)), new Set(operationIds));
  for (const entry of operationCatalog) assert.deepEqual([entry.executor, entry.sandbox_scoped, entry.routing], routes[entry.id], entry.id);
  assert.ok(!operationCatalog.some((entry) => entry.id.startsWith("vm.")), "no vm.* operation survives");
});

test("a sandbox-scoped operation needs a sandbox_id; every other operation carries sandbox_id null", () => {
  for (const entry of operationCatalog) {
    const scoped = entry.sandbox_scoped;
    assert.doesNotThrow(() => validateRequest(request(entry.id, scoped ? "sandbox_1" : null)), entry.id);
    assert.throws(() => validateRequest(request(entry.id, scoped ? null : "sandbox_1")), invalid, entry.id);
  }
});

test("HostDaemon answers the host executor, every account operation relayed to a machine, and sandbox.list", () => {
  const relayed = operationIds.filter((id) => routes[id][0] === "host" || (routes[id][0] === "account" && routes[id][2] !== "account"));
  assert.deepEqual(new Set(hostOperationIds()), new Set([...relayed, "sandbox.list"]));
});

test("image.create takes exactly one of from and macos", () => {
  const create = (input: RequestEnvelope["input"]) => validateRequest({ ...request("image.create", null), input });
  assert.doesNotThrow(() => create({ from: "bold-otter" }));
  assert.doesNotThrow(() => create({ macos: true, name: "mac-base" }));
  assert.throws(() => create({}), invalid);
  assert.throws(() => create({ from: "bold-otter", macos: true }), invalid);
  assert.throws(() => create({ macos: false }), invalid);
});
