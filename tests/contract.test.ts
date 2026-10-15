import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  catalogById, ContractError, defaultSize, helpSnapshot, operationCatalog, PROTOCOL_VERSION, swiftHostOperations,
  type RequestEnvelope, validateRequest,
} from "../packages/contract/src/index.js";
import { FakeDispatcher, FixtureClock } from "../packages/runtime/src/index.js";

const request = (overrides: Partial<RequestEnvelope> = {}): RequestEnvelope => ({ protocol_version: PROTOCOL_VERSION, request_id: "req-1", operation: "system.info", sandbox_id: "sandbox_1", deadline_ms: 1000, mutation_id: null, input: {}, ...overrides });

test("catalog has unique operation IDs", () => {
  assert.equal(new Set(operationCatalog.map((x) => x.id)).size, operationCatalog.length);
  assert.equal(operationCatalog.length, 53);
});

test("committed snapshots are generated from the same catalog", async () => {
  const [catalog, help, swift] = await Promise.all([
    readFile("snapshots/catalog.json", "utf8"),
    readFile("snapshots/help.json", "utf8"),
    readFile("apps/macos/HostDaemon/Sources/HostDaemonCore/GeneratedOperations.swift", "utf8"),
  ]);
  assert.deepEqual(JSON.parse(catalog), operationCatalog);
  assert.equal(swift, swiftHostOperations(), "HostDaemon routes on the current catalog; run npm run generate:snapshots");
  assert.deepEqual(JSON.parse(help), helpSnapshot());
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
  assert.deepEqual({ request_id: ok.request_id, operation: ok.operation, sandbox_id: ok.sandbox_id }, { request_id: "req-1", operation: "system.info", sandbox_id: "sandbox_1" });
  assert.equal(ok.release_id, "localbox-contract-v1");
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
  const first = await dispatcher.dispatch(request({ operation: "sandbox.start", mutation_id: "mut-1" }));
  const second = await dispatcher.dispatch(request({ operation: "sandbox.start", mutation_id: "mut-1", request_id: "req-2" }));
  assert.deepEqual(second, first);
  const missing = await dispatcher.dispatch(request({ operation: "sandbox.start" }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "invalid_input");
});

test("CLI help is the catalog and generic invoke preserves envelope identity", () => {
  const help = spawnSync(process.execPath, ["bin/localbox.js", "help", "--json"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.deepEqual(JSON.parse(help.stdout), helpSnapshot());

  const fixtureEnv = { ...process.env, LOCALBOX_LOCAL_TRANSPORT: "fixture" };
  const invoked = spawnSync(process.execPath, ["bin/localbox.js", "invoke", "system.info", "--input-json", "{}", "--json"], { encoding: "utf8", env: fixtureEnv });
  assert.equal(invoked.status, 0);
  const response = JSON.parse(invoked.stdout);
  assert.equal(response.ok, true);
  assert.equal(response.operation, "system.info");
  assert.equal(response.sandbox_id, "sandbox_fixture", "the only sandbox is used when none is named");

  const unknown = spawnSync(process.execPath, ["bin/localbox.js", "invoke", "sandbox.resize", "--input-json", '{"cpus":0}', "--mutation-id", "resize-1", "--json"], { encoding: "utf8", env: fixtureEnv });
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stdout).error.code, "invalid_input");

  // Not on this Mac: only the account can say where it is, and this Mac is not signed in.
  const missing = spawnSync(process.execPath, ["bin/localbox.js", "invoke", "fs.stat", "--sandbox", "nowhere", "--input-json", '{"path":"/"}', "--json"], { encoding: "utf8", env: fixtureEnv });
  assert.equal(JSON.parse(missing.stdout).error.code, "unauthorized");
  assert.match(JSON.parse(missing.stdout).error.message, /not signed in; run localbox login/);

  const mcp = spawnSync(process.execPath, ["bin/localbox.js", "mcp", "install", "--json"], { encoding: "utf8", env: { ...process.env, LOCALBOX_API_ORIGIN: "https://computer.example" } });
  assert.equal(mcp.status, 0);
  assert.equal(JSON.parse(mcp.stdout).mcpServers["localbox"].url, "https://computer.example/api/mcp");
});

test("defaultSize is half the cores and a quarter of memory, at least 2 CPUs and 2 GiB", () => {
  const gib = 1024 ** 3;
  for (const [cpus, memory, expected] of [[12, 24 * gib, [6, 6 * gib]], [4, 8 * gib, [2, 2 * gib]], [2, 4 * gib, [2, 2 * gib]], [10, 64 * gib, [5, 16 * gib]]] as const) {
    assert.deepEqual(defaultSize(cpus, memory), { cpus: expected[0], memory_bytes: expected[1] }, `${cpus} cores, ${memory} bytes`);
  }
});
