import assert from "node:assert/strict";
import { test } from "node:test";
import { runOps } from "../apps/relay/src/ops.js";
import { AgentClient, FixtureTransport, AgentApiTransport } from "../packages/client/src/index.js";
import { operationCatalog } from "../packages/contract/src/index.js";
import { FakeDispatcher, FIXTURE_SANDBOX_ID, sampleInput } from "../packages/runtime/src/index.js";
import { memoryMailbox } from "./fixtures/memory-mailbox.js";

test("every catalog operation preserves local semantics through the agent API and a machine's connector", async () => {
  const machineA = new FakeDispatcher(); const machineB = new FakeDispatcher();
  const { deps } = memoryMailbox({ machines: [{ machineId: "m_a", name: "studio" }, { machineId: "m_b", name: "attic" }], sandboxes: [{ sandbox_id: FIXTURE_SANDBOX_ID, name: "quiet-otter", machine_id: "m_b" }], connectors: { m_a: (request) => machineA.dispatch(request), m_b: (request) => machineB.dispatch(request) } });
  const principal = { accountId: "acct", machineId: "m_a" };
  const fetchImpl: typeof fetch = async (_input, init = {}) => {
    const result = await runOps(principal, JSON.parse(String(init.body)), deps);
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  };
  const local = new AgentClient({ transport: new FixtureTransport("local", new FakeDispatcher()) });
  const remote = new AgentClient({ transport: new AgentApiTransport({ apiOrigin: "https://localbox.test", accessToken: "secret", fetchImpl }) });
  // Every operation the machine answers itself, i.e. all but those that change or read the account catalog. A
  // machine-level operation names no sandbox and runs on the calling machine.
  for (const entry of operationCatalog.filter((operation) => operation.executor !== "account")) {
    const input = sampleInput(entry.id);
    const options = { sandboxId: entry.sandbox_scoped ? FIXTURE_SANDBOX_ID : null, requestId: `parity-${entry.id.replaceAll(".", "-")}`, mutationId: entry.idempotency === "required" ? `mutation-${entry.id.replaceAll(".", "-")}` : null };
    assert.deepEqual(await remote.invoke(entry.id, input, options), await local.invoke(entry.id, input, options), entry.id);
  }
});
