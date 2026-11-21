import assert from "node:assert/strict";
import { test } from "node:test";
import { runOps } from "../apps/relay/src/ops.js";
import { AgentApiTransport } from "../packages/client/src/index.js";
import { success, type RequestEnvelope, type ResponseEnvelope } from "../packages/contract/src/index.js";
import type { ImageRow } from "../apps/relay/src/image-state.js";
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

const imageRow = (holders: Array<Partial<ImageRow["holders"][number]> & { machine_id: string; state: ImageRow["holders"][number]["state"] }>): ImageRow => ({
  image_id: "image_1", name: "rails-dev", os: "linux", size_bytes: null, min_macos: null, source: { kind: "sandbox", sandboxName: "quiet-otter" }, default: false, created_at: 1,
  holders: holders.map((holder) => ({ machine_name: holder.machine_id === "m_b" ? "attic" : "studio", operation_id: null, error: null, updated_at: 1, ...holder })),
});

test("image.wait asks the Mac building the image, waits there, and answers its operation state inline or by continuation", async () => {
  const asked: RequestEnvelope[] = []; let step = 0;
  const record = (state: string) => ({ key: "m-build", kind: "capture", subject: "image_1", state, progress: { phase: "copying disk", completed: ++step * 10, total: 100 }, started_at: 1, updated_at: 2 });
  const machineB = async (envelope: RequestEnvelope) => { asked.push(envelope); await new Promise((resolve) => setTimeout(resolve, 60)); return success(envelope, record(asked.length < 2 ? "running" : "succeeded")); };
  const { deps } = memoryMailbox({ machines, maxWaitMs: 20, images: [imageRow([{ machine_id: "m_b", state: "building", operation_id: "m-build" }])], connectors: { m_b: machineB } });
  const calls: Array<Record<string, unknown>> = [];
  const pending = await transportFor(deps, calls).dispatch(request({ operation: "image.wait", sandbox_id: null, input: { image: "rails-dev", timeout_ms: 500 } }));
  assert.ok(calls.some((call) => typeof call.continue === "string"), "the machine's answer came by continuation");
  assert.deepEqual(pending.ok && pending.result, { image: "image_1", name: "rails-dev", os: "linux", state: "building", progress: { phase: "copying disk", done_bytes: 10, total_bytes: 100 } });
  assert.deepEqual(asked[0].input, { image: "image_1", timeout_ms: 500 }, "the machine is asked by image id");
  const ready = await transportFor(deps).dispatch(request({ operation: "image.wait", sandbox_id: null, input: { image: "image_1" } }));
  assert.equal(ready.ok && (ready.result as any).state, "ready");
});

test("image.wait answers from the catalog when no Mac is building or copying, without asking a machine", async () => {
  const failure = { code: "disk_full", message: "attic has 2 GiB free", next_step: "free some disk on attic and copy it again" };
  const answers = async (holders: Parameters<typeof imageRow>[0], image = "rails-dev") => {
    const { deps, rows } = memoryMailbox({ machines, images: [imageRow(holders), { ...imageRow([{ machine_id: "m_a", state: "ready" }, { machine_id: "m_b", state: "ready" }]), image_id: "linux", name: "linux", source: { kind: "release" } }], connectors: {} });
    const response = await transportFor(deps).dispatch(request({ operation: "image.wait", sandbox_id: null, input: { image } }));
    assert.equal(rows.size, 0, "nothing was relayed");
    return response.ok ? response.result as any : response.error;
  };
  assert.equal((await answers([], "linux")).state, "ready");
  assert.equal((await answers([{ machine_id: "m_a", state: "ready" }, { machine_id: "m_b", state: "failed", error: failure }])).state, "ready");
  assert.deepEqual((await answers([{ machine_id: "m_b", state: "failed", error: failure }])).error, { code: "disk_full", message: "on attic: attic has 2 GiB free", next_step: failure.next_step });
  const orphan = await answers([]);
  assert.equal(orphan.state, "failed"); assert.match(orphan.error.next_step, /localbox image delete rails-dev --confirm rails-dev/);
  assert.equal((await answers([], "nope")).code, "image_not_found");
});
