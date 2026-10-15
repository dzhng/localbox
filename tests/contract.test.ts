import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  catalogById, cliHelpSnapshot, ContractError, mcpToolsSnapshot, operationCatalog, PROTOCOL_VERSION,
  type RequestEnvelope, validateRequest,
} from "../packages/contract/src/index.js";
import { FakeDispatcher, FixtureClock } from "../packages/runtime/src/index.js";

const request = (overrides: Partial<RequestEnvelope> = {}): RequestEnvelope => ({ protocol_version: PROTOCOL_VERSION, request_id: "req-1", operation: "system.info", vm_id: "vm_01", deadline_ms: 1000, mutation_id: null, input: {}, ...overrides });

test("catalog has unique operation IDs and matching CLI/MCP identity", () => {
  assert.equal(new Set(operationCatalog.map((x) => x.id)).size, operationCatalog.length);
  assert.deepEqual(cliHelpSnapshot().map((x) => x.id), mcpToolsSnapshot().map((x) => x.id));
  assert.deepEqual(cliHelpSnapshot(), mcpToolsSnapshot());
  assert.equal(operationCatalog.length, 42);
});

test("committed snapshots are generated from the same catalog", async () => {
  const [catalog, cli, mcp] = await Promise.all([
    readFile("snapshots/catalog.json", "utf8"),
    readFile("snapshots/cli-help.json", "utf8"),
    readFile("snapshots/mcp-tools.json", "utf8"),
  ]);
  assert.deepEqual(JSON.parse(catalog), operationCatalog);
  assert.deepEqual(JSON.parse(cli), cliHelpSnapshot());
  assert.deepEqual(JSON.parse(mcp), mcpToolsSnapshot());
});

test("schema validation rejects unknown operations and malformed fields", () => {
  assert.throws(() => validateRequest(request({ operation: "nope", input: {} })), (e) => e instanceof ContractError && e.code === "invalid_input");
  assert.throws(() => validateRequest(request({ operation: "system.info", input: { extra: true } })), (e) => e instanceof ContractError && e.code === "invalid_input");
  assert.throws(() => validateRequest(request({ operation: "fs.read", input: {} })), (e) => e instanceof ContractError && e.code === "invalid_input");
  assert.throws(() => validateRequest(request({ operation: "fs.write", input: { path: "/x", content: "x" } })), (e) => e instanceof ContractError && e.code === "invalid_input" && /mutation_id/.test(e.message));
});

test("success and failure envelopes preserve request and release identity", async () => {
  const dispatcher = new FakeDispatcher();
  const ok = await dispatcher.dispatch(request());
  assert.equal(ok.ok, true);
  assert.deepEqual({ request_id: ok.request_id, operation: ok.operation, vm_id: ok.vm_id }, { request_id: "req-1", operation: "system.info", vm_id: "vm_01" });
  assert.equal(ok.release_id, "agent-computer-contract-v1");
  const bad = await dispatcher.dispatch(request({ operation: "fs.read", input: {} }));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, "invalid_input");
  assert.equal(bad.request_id, "req-1");
});

test("parity harness invokes every operation through one dispatcher", async () => {
  const responses = await new FakeDispatcher().invokeAll();
  assert.equal(responses.length, operationCatalog.length);
  assert.ok(responses.every((response) => response.ok));
});

test("deadline and cancellation are deterministic", async () => {
  const clock = new FixtureClock(1000);
  const dispatcher = new FakeDispatcher({ clock, handlers: {
    "system.info": (_input, context) => { context.clock.advance(11); return { done: true }; }
  } });
  const timedOut = await dispatcher.dispatch(request({ deadline_ms: 10 }));
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) { assert.equal(timedOut.error.code, "operation_timeout"); assert.equal(timedOut.error.retryable, true); }
  const abort = new AbortController();
  abort.abort();
  const cancelled = await new FakeDispatcher().dispatch(request(), { signal: abort.signal });
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.error.code, "operation_cancelled");
});

test("mutation IDs make replay deterministic", async () => {
  const dispatcher = new FakeDispatcher();
  const first = await dispatcher.dispatch(request({ operation: "vm.start", mutation_id: "mut-1" }));
  const second = await dispatcher.dispatch(request({ operation: "vm.start", mutation_id: "mut-1", request_id: "req-2" }));
  assert.deepEqual(second, first);
  const missing = await dispatcher.dispatch(request({ operation: "vm.start" }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "invalid_input");
});

test("CLI help is the catalog and generic invoke preserves envelope identity", () => {
  const help = spawnSync(process.execPath, ["bin/localbox.js", "help", "--json"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.deepEqual(JSON.parse(help.stdout), cliHelpSnapshot());

  const fixtureEnv = { ...process.env, LOCALBOX_LOCAL_TRANSPORT: "fixture" };
  const invoked = spawnSync(process.execPath, ["bin/localbox.js", "invoke", "system.info", "--input-json", "{}", "--json"], { encoding: "utf8", env: fixtureEnv });
  assert.equal(invoked.status, 0);
  const response = JSON.parse(invoked.stdout);
  assert.equal(response.ok, true);
  assert.equal(response.operation, "system.info");
  assert.equal(response.vm_id, "vm_01");

  const reset = spawnSync(process.execPath, ["bin/localbox.js", "invoke", "vm.reset", "--input-json", "{}", "--mutation-id", "reset-1", "--json"], { encoding: "utf8", env: fixtureEnv });
  assert.equal(reset.status, 0);
  const resetResponse = JSON.parse(reset.stdout);
  assert.equal(resetResponse.ok, false);
  assert.equal(resetResponse.error.code, "invalid_input");

  const confirmed = spawnSync(process.execPath, ["bin/localbox.js", "invoke", "vm.reset", "--input-json", '{"discard_state":true,"confirm":"RESET"}', "--mutation-id", "reset-1", "--json"], { encoding: "utf8", env: fixtureEnv });
  assert.equal(confirmed.status, 0);
  assert.equal(JSON.parse(confirmed.stdout).ok, true);

  const mcp = spawnSync(process.execPath, ["bin/localbox.js", "mcp", "install", "--json"], { encoding: "utf8", env: { ...process.env, LOCALBOX_API_ORIGIN: "https://computer.example" } });
  assert.equal(mcp.status, 0);
  assert.equal(JSON.parse(mcp.stdout).mcpServers["localbox"].url, "https://computer.example/api/mcp");
});
