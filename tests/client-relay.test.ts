import assert from "node:assert/strict";
import { test } from "node:test";
import { runOps } from "../apps/relay/src/ops.js";
import { AgentApiTransport } from "../packages/client/src/index.js";
import type { RequestEnvelope, ResponseEnvelope } from "../packages/contract/src/index.js";
import { memoryMailbox } from "./fixtures/memory-mailbox.js";

const request = (overrides: Partial<RequestEnvelope> = {}): RequestEnvelope => ({ protocol_version: "v1", request_id: `req_${Math.random()}`, operation: "system.info", sandbox_id: "sandbox_b", deadline_ms: 5_000, mutation_id: null, input: {}, ...overrides });
const answer = (envelope: RequestEnvelope): ResponseEnvelope => ({ protocol_version: "v1", request_id: envelope.request_id, operation: envelope.operation, sandbox_id: envelope.sandbox_id, release_id: "localbox-contract-v1", ok: true, result: { ran_on: "attic" } });
const transportFor = (deps: ReturnType<typeof memoryMailbox>["deps"], calls: unknown[] = []) => new AgentApiTransport({ apiOrigin: "https://localbox.test", accessToken: "secret", fetchImpl: async (_input, init = {}) => { const body = JSON.parse(String(init.body)); calls.push(body); const result = await runOps({ accountId: "acct", machineId: "m_a" }, body, deps); return new Response(JSON.stringify(result.body), { status: result.status }); } });
const machines = [{ machineId: "m_a", name: "studio" }, { machineId: "m_b", name: "attic" }];
const sandboxes = [{ sandbox_id: "sandbox_b", name: "quiet-otter", machine_id: "m_b" }];

test("a request for a sandbox on machine B runs on B's connector and returns inline", async () => {
  const { deps } = memoryMailbox({ machines, sandboxes, connectors: { m_b: async (envelope) => answer(envelope) } });
  const response = await transportFor(deps).dispatch(request());
  assert.equal(response.ok, true); assert.deepEqual(response.ok && response.result, { ran_on: "attic" });
});

test("an unclaimed request is abandoned and reported machine_offline with the last-seen time", async () => {
  const { deps, rows } = memoryMailbox({ machines, sandboxes, connectors: {} });
  const response = await transportFor(deps).dispatch(request({ request_id: "req_offline" }));
  assert.equal(response.ok, false); assert.equal(!response.ok && response.error.code, "machine_offline");
  assert.match(!response.ok ? response.error.message : "", /last seen 2023-11-14T22:13:20.000Z/);
  assert.equal(rows.get("req_offline")?.status, "abandoned");
});

test("a request still running when the server's wait ends resumes through a continuation", async () => {
  const { deps } = memoryMailbox({ machines, sandboxes, maxWaitMs: 20, connectors: { m_b: async (envelope) => { await new Promise((resolve) => setTimeout(resolve, 80)); return answer(envelope); } } });
  const calls: Array<Record<string, unknown>> = [];
  const response = await transportFor(deps, calls).dispatch(request());
  assert.equal(response.ok, true); assert.ok(calls.length >= 2, "at least one continuation"); assert.equal(typeof calls[1].continue, "string");
});

test("a claimed request that never answers before the deadline is operation_uncertain; replaying the mutation returns the original result", async () => {
  let answerNow = false; const pending: Array<() => void> = [];
  const { deps } = memoryMailbox({ machines, sandboxes, connectors: { m_b: async (envelope) => { if (!answerNow) await new Promise<void>((resolve) => pending.push(resolve)); return answer(envelope); } } });
  const first = await transportFor(deps).dispatch(request({ operation: "shell.exec", mutation_id: "m1", deadline_ms: 100, input: { command: "true" } }));
  assert.equal(!first.ok && first.error.code, "operation_uncertain");
  answerNow = true; for (const resolve of pending) resolve();
  const replay = await transportFor(deps).dispatch(request({ operation: "shell.exec", mutation_id: "m1", input: { command: "true" } }));
  assert.equal(replay.ok, true);
});

test("an unknown sandbox is sandbox_not_found and names the account's sandboxes", async () => {
  const { deps } = memoryMailbox({ machines, sandboxes, connectors: {} });
  const response = await transportFor(deps).dispatch(request({ sandbox_id: "garage" }));
  assert.equal(!response.ok && response.error.code, "sandbox_not_found"); assert.match(!response.ok ? response.error.message : "", /quiet-otter/);
});

test("a mutation replayed while its first run is still going runs once and both callers get its result", async () => {
  const { FakeDispatcher } = await import("../packages/runtime/src/index.js");
  let runs = 0; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const dispatcher = new FakeDispatcher({ handlers: { "shell.exec": async () => { runs++; await gate; return { stdout: "once" }; } } });
  const envelope = request({ operation: "shell.exec", mutation_id: "same", input: { command: "true" } });
  const first = dispatcher.dispatch(envelope); const second = dispatcher.dispatch({ ...envelope, request_id: "replay" });
  release();
  assert.deepEqual((await first).ok && (await first as any).result, { stdout: "once" });
  assert.deepEqual((await second as any).result, { stdout: "once" }); assert.equal(runs, 1);
});

test("a mutation replayed after machine_offline is queued afresh and runs, since the abandoned row never reached the machine", async () => {
  const connectors: Record<string, (envelope: RequestEnvelope) => Promise<ResponseEnvelope>> = {};
  const { deps } = memoryMailbox({ machines, sandboxes, connectors });
  const mutation = { operation: "shell.exec", mutation_id: "offline-then-back", input: { command: "true" } };
  const first = await transportFor(deps).dispatch(request(mutation));
  assert.equal(!first.ok && first.error.code, "machine_offline");
  connectors.m_b = async (envelope) => answer(envelope);
  assert.equal((await transportFor(deps).dispatch(request(mutation))).ok, true);
});

test("a wait ends as not found when the request is unknown, and as operation_uncertain when the subscription fails", async () => {
  const { deps } = memoryMailbox({ machines, sandboxes, connectors: {} });
  const missing = await runOps({ accountId: "acct" }, { continue: "req_never_queued" }, deps);
  assert.equal(missing.status, 404);
  const failing = { ...deps, watchResult: (_id: string, _onChange: unknown, onError: (error: Error) => void) => { queueMicrotask(() => onError(new Error("[CONVEX Q(relay:result)] Server Error"))); return () => {}; } };
  const lost = await runOps({ accountId: "acct" }, { continue: "req_any" }, failing);
  assert.equal(lost.status, 200); assert.equal((lost.body as any).response.error.code, "operation_uncertain");
});

test("a relayed request is checked against the contract before it is queued", async () => {
  const { deps, rows } = memoryMailbox({ machines, sandboxes, connectors: {} });
  const result = await runOps({ accountId: "acct" }, { operation: "system.info", sandbox: "quiet-otter", deadline_ms: 10 * 60_000, input: {} }, deps);
  assert.equal((result.body as any).response.error.code, "invalid_input"); assert.match((result.body as any).response.error.message, /deadline_ms/);
  assert.equal(rows.size, 0);
});

test("a caller Convex refuses as unauthorized is answered 401, whatever the error's message says", async () => {
  const { ConvexError } = await import("convex/values");
  const { deps } = memoryMailbox({ machines, sandboxes, connectors: {} });
  const refusing = { ...deps, accountCall: async () => { throw new ConvexError({ code: "unauthorized", message: "redacted" }); } };
  assert.equal((await runOps({ accountId: "acct", machineId: "m_a" }, { operation: "machine.list", input: {} }, refusing)).status, 401);
  assert.equal((await runOps({ accountId: "acct", familyId: "f" }, { operation: "system.info", sandbox: "quiet-otter", input: {} }, refusing)).status, 401);
});
