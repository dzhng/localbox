import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCOUNT_OPERATIONS, handleOps } from "../apps/relay/src/ops.js";
import { AgentClient, FixtureTransport, RelayHttpTransport } from "../packages/client/src/index.js";
import { operationCatalog } from "../packages/contract/src/index.js";
import { FakeDispatcher, sampleInput } from "../packages/runtime/src/index.js";
import { memoryMailbox } from "./fixtures/memory-mailbox.js";

test("every catalog operation preserves local semantics through the agent API and a machine's connector", async () => {
  const machineB = new FakeDispatcher();
  const { deps } = memoryMailbox({ machines: [{ machineId: "m_a", name: "studio" }, { machineId: "m_b", name: "attic" }], connectors: { m_b: (request) => machineB.dispatch(request) } });
  const principal = { accountId: "acct", machineId: "m_a" };
  const fetchImpl: typeof fetch = async (_input, init = {}) => {
    const result = await handleOps(principal, JSON.parse(String(init.body)), deps);
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  };
  const local = new AgentClient({ vmId: "vm_01", transport: new FixtureTransport("local", new FakeDispatcher()) });
  const remote = new AgentClient({ vmId: "vm_01", transport: new RelayHttpTransport({ apiOrigin: "https://localbox.test", machine: "attic", accessToken: "secret", fetchImpl }) });
  for (const entry of operationCatalog.filter((operation) => !(operation.id in ACCOUNT_OPERATIONS))) {
    const input = sampleInput(entry.id);
    const options = { requestId: `parity-${entry.id.replaceAll(".", "-")}`, mutationId: entry.idempotency === "required" ? `mutation-${entry.id.replaceAll(".", "-")}` : null };
    assert.deepEqual(await remote.invoke(entry.id, input, options), await local.invoke(entry.id, input, options), entry.id);
  }
});
