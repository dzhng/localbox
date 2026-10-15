import assert from "node:assert/strict";
import { test } from "node:test";
import { McpAdapter, mcpTools } from "../apps/mcp/src/index.js";
import { handleOps, type Principal } from "../apps/relay/src/ops.js";
import { catalogById, success, type RequestEnvelope } from "../packages/contract/src/index.js";
import { FakeDispatcher } from "../packages/runtime/src/index.js";
import { memoryMailbox } from "./fixtures/memory-mailbox.js";

const ENDPOINT = "https://api.test/api/mcp";
const agent: Principal = { accountId: "acct", familyId: "family_1" };
const authenticate = async (token: string) => { if (token !== "good") throw new Error("invalid token"); return agent; };
const rpc = (adapter: McpAdapter, method: string, params?: unknown, token = "good") => adapter.handle({ method: "POST", url: ENDPOINT, headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: "2.0", id: 1, method, params } });
const result = (response: { body?: unknown }) => (response.body as any).result;

test("MCP requires a valid bearer and points clients at the protected-resource metadata", async () => {
  const adapter = new McpAdapter({ endpoint: ENDPOINT, authenticate, ops: async () => { throw new Error("not called"); }, allowedOrigins: ["https://claude.ai"] });
  for (const headers of [{}, { authorization: "Bearer bad" }]) {
    const response = await adapter.handle({ method: "POST", url: ENDPOINT, headers, body: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    assert.equal(response.status, 401);
    assert.equal(response.headers["www-authenticate"], `Bearer resource_metadata="${ENDPOINT}/.well-known/oauth-protected-resource"`);
  }
  assert.equal((await adapter.handle({ method: "POST", url: ENDPOINT, headers: { origin: "https://evil.test", authorization: "Bearer good" }, body: { jsonrpc: "2.0", id: 1, method: "initialize" } })).status, 403);
  assert.equal(result(await rpc(adapter, "initialize")).protocolVersion, "2025-06-18");
  assert.equal((await adapter.handle({ method: "POST", url: ENDPOINT, headers: { authorization: "Bearer good" }, body: { jsonrpc: "2.0", method: "notifications/initialized" } })).status, 202);
  assert.equal((await new McpAdapter({ endpoint: ENDPOINT, authenticate, ops: async () => ({ status: 200, body: {} }), maxBodyBytes: 8 }).handle({ method: "POST", url: ENDPOINT, body: "123456789" })).status, 413);
});

test("tools on one sandbox gain a sandbox argument, machine-level host tools a machine argument; the catalog is unchanged", async () => {
  const tools = mcpTools();
  assert.equal(tools.length, catalogById.size);
  for (const tool of tools) {
    assert.equal("sandbox" in (tool.inputSchema.properties ?? {}), catalogById.get(tool.name as never)!.sandbox_scoped, tool.name);
    const entry = catalogById.get(tool.name as never)!;
    assert.equal("machine" in (tool.inputSchema.properties ?? {}), tool.name === "sandbox.create" || (entry.executor === "host" && !entry.sandbox_scoped), tool.name);
  }
  assert.ok(!("sandbox" in (catalogById.get("shell.exec")!.input_schema.properties ?? {})), "the catalog itself is unchanged");
  const adapter = new McpAdapter({ endpoint: ENDPOINT, authenticate, ops: async () => ({ status: 200, body: {} }) });
  assert.deepEqual(result(await rpc(adapter, "tools/list")).tools, tools);
});

test("tools/call runs the agent API in-process as the token's account, on the named sandbox's machine", async () => {
  const machineB = new FakeDispatcher(); const ran: RequestEnvelope[] = [];
  const sandboxes = [{ sandbox_id: "sandbox_1", name: "quiet-otter", machine_id: "m_b", machine_name: "attic" }, { sandbox_id: "sandbox_2", name: "brave-fox", machine_id: "m_a", machine_name: "studio" }];
  const { deps } = memoryMailbox({ machines: [{ machineId: "m_a", name: "studio" }, { machineId: "m_b", name: "attic" }], sandboxes, connectors: { m_b: async (request) => { ran.push(request); return await machineB.dispatch(request); } } });
  const seen: Principal[] = [];
  const adapter = new McpAdapter({ endpoint: ENDPOINT, authenticate, ops: (principal, input) => { seen.push(principal); return handleOps(principal, input, deps); } });

  const unnamed = result(await rpc(adapter, "tools/call", { name: "fs.stat", arguments: { path: "/" } }));
  assert.equal(unnamed.isError, true); assert.equal(unnamed.structuredContent.code, "sandbox_ambiguous"); assert.match(unnamed.content[0].text, /quiet-otter, brave-fox/);
  assert.equal(ran.length, 0, "nothing runs without a sandbox");

  const listed = result(await rpc(adapter, "tools/call", { name: "machine.list", arguments: {} }));
  assert.deepEqual(JSON.parse(listed.content[0].text).map((row: any) => row.name), ["studio", "attic"]);

  const called = result(await rpc(adapter, "tools/call", { name: "system.info", arguments: { sandbox: "quiet-otter" } }));
  assert.equal(called.isError, undefined, JSON.stringify(called));
  assert.equal(ran.length, 1); assert.equal(ran[0].operation, "system.info"); assert.equal(ran[0].sandbox_id, "sandbox_1", "it ran on the sandbox's machine, B");
  assert.equal(called.structuredContent.protocol_version, "v1");
  assert.deepEqual(ran[0].input, {}, "the sandbox argument is stripped before the operation input is built");
  assert.ok(seen.every((principal) => principal === agent));

  const skill = result(await rpc(adapter, "tools/call", { name: "skill.status", arguments: { machine: "attic" } }));
  assert.equal(skill.isError, undefined, JSON.stringify(skill));
  assert.equal(ran.at(-1)!.operation, "skill.status"); assert.equal(ran.at(-1)!.sandbox_id, null, "a machine-level tool names no sandbox");
  assert.deepEqual(ran.at(-1)!.input, {}, "the machine argument is stripped too");
  const which = result(await rpc(adapter, "tools/call", { name: "skill.status", arguments: {} }));
  assert.equal(which.isError, true); assert.match(which.content[0].text, /2 machines; name one with machine: studio, attic/);

  const missing = result(await rpc(adapter, "tools/call", { name: "fs.stat", arguments: { sandbox: "nowhere", path: "/" } }));
  assert.equal(missing.isError, true); assert.equal(missing.structuredContent.code, "sandbox_not_found");
  assert.equal(((await rpc(adapter, "tools/call", { name: "nope", arguments: {} })).body as any).error.code, -32602);
});

test("tools/call resumes continuations and reports API failures as tool errors", async () => {
  const calls: Record<string, unknown>[] = [];
  const adapter = new McpAdapter({ endpoint: ENDPOINT, authenticate, ops: async (_principal, input) => {
    calls.push(input);
    if (calls.length === 1) return { status: 202, body: { status: "pending", request_id: "req_1", deadline_at: 123 } };
    if (input.operation === "account.rename") throw new Error("label must be 3–40 lowercase letters");
    return { status: 200, body: { response: success({ protocol_version: "v1", request_id: "req_1", operation: "fs.stat", sandbox_id: "sandbox_1", deadline_ms: 1, mutation_id: null, input: {} }, { size: 1 }) } };
  } });
  const done = result(await rpc(adapter, "tools/call", { name: "fs.stat", arguments: { sandbox: "quiet-otter", path: "/" } }));
  assert.deepEqual(done.structuredContent, { size: 1 });
  assert.deepEqual(calls[1], { continue: "req_1", deadline_at: 123 });
  assert.equal(calls[0].mutation_id, null, "a read carries no mutation id");
  await rpc(adapter, "tools/call", { name: "shell.exec", arguments: { sandbox: "quiet-otter", command: "true" } });
  assert.match(String(calls[2].mutation_id), /^mcp_/, "each mutating call is its own mutation");
  const failed = result(await rpc(adapter, "tools/call", { name: "account.rename", arguments: { name: "X" } }));
  assert.equal(failed.isError, true); assert.match(failed.content[0].text, /label/);
});
