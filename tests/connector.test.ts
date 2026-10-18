import assert from "node:assert/strict";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { Connector, type ConvexLike, type HostChange, type PendingRow } from "../apps/connector/src/connector.js";
import { MachineTokenSource, RevokedError } from "../apps/connector/src/token.js";
import { OUTPUT_CAP_BYTES, PROTOCOL_VERSION, success, type RequestEnvelope, type ResponseEnvelope } from "../packages/contract/src/index.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(): Promise<void> { for (let i = 0; i < 20; i++) await tick(); }

class FakeConvex implements ConvexLike {
  calls: Array<{ name: string; args: any }> = [];
  closed = false;
  fetchToken?: (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>;
  onAuth?: (authenticated: boolean) => void;
  private listeners = new Map<string, (rows: any) => unknown>();
  private errorListeners = new Map<string, (error: Error) => unknown>();
  claimAnswer: (requestId: string) => Promise<{ claimed: boolean; status: string }> = async () => ({ claimed: true, status: "claimed" });
  setAuth(fetchToken: FakeConvex["fetchToken"], onChange?: (authenticated: boolean) => void): void { this.fetchToken = fetchToken; this.onAuth = onChange; }
  onUpdate(query: any, args: any, callback: (rows: any) => unknown, onError?: (error: Error) => unknown): () => void {
    const name = getFunctionName(query); this.calls.push({ name, args }); this.listeners.set(name, callback);
    if (onError) this.errorListeners.set(name, onError);
    return () => { this.listeners.delete(name); this.errorListeners.delete(name); };
  }
  async mutation(fn: any, args: any): Promise<any> {
    const name = getFunctionName(fn); this.calls.push({ name, args });
    if (name === "relay:claim") return await this.claimAnswer(args.requestId);
    return null;
  }
  async close(): Promise<void> { this.closed = true; }
  push(rows: PendingRow[]): void { this.listeners.get("relay:pendingForMachine")?.(rows); }
  pushSandboxes(rows: unknown[]): void { this.listeners.get("sandboxes:forMachine")?.(rows); }
  fail(name: string, error: Error): void { this.errorListeners.get(name)?.(error); }
  named(name: string) { return this.calls.filter((call) => call.name === name); }
}

class FakeDaemon {
  requests: RequestEnvelope[] = [];
  respond: (request: RequestEnvelope) => Promise<ResponseEnvelope> = async (request) => success(request, { ran: request.request_id });
  async dispatch(request: RequestEnvelope): Promise<ResponseEnvelope> {
    this.requests.push(request);
    if (request.operation === "connector.report" || request.operation === "sandbox.mirror") return success(request, { recorded: true });
    return await this.respond(request);
  }
  work() { return this.requests.filter((request) => !["connector.report", "sandbox.mirror"].includes(request.operation)); }
  reports() { return this.requests.filter((request) => request.operation === "connector.report").map((request) => (request.input as { state: string }).state); }
}

/** A host.watch that blocks until the test releases the next value, like the daemon's long poll. */
class FakeWatch {
  sinces: number[] = [];
  private queue: HostChange[] = [];
  private waiting?: (value: HostChange) => void;
  watch = (since: number) => { this.sinces.push(since); const next = this.queue.shift(); return next ? Promise.resolve(next) : new Promise<HostChange>((resolve) => { this.waiting = resolve; }); };
  emit(value: HostChange): void { const waiting = this.waiting; this.waiting = undefined; if (waiting) waiting(value); else this.queue.push(value); }
}

function envelope(requestId: string, operation = "shell.exec"): RequestEnvelope {
  return { protocol_version: PROTOCOL_VERSION, request_id: requestId, operation, sandbox_id: "sandbox_1", deadline_ms: 30_000, mutation_id: `m-${requestId}`, input: { command: "hostname" } };
}
function row(requestId: string, status = "queued"): PendingRow {
  return { requestId, operation: "shell.exec", mutationId: `m-${requestId}`, status, payload: envelope(requestId), claimDeadlineAt: Date.now() + 3_000 };
}

function harness(options: { fetchToken?: (force: boolean) => Promise<string> } = {}) {
  const convex = new FakeConvex(); const daemon = new FakeDaemon(); const watch = new FakeWatch(); const logs: string[] = [];
  const connector = new Connector({ machineId: "machine_1", convex, daemon, hostWatch: watch.watch, fetchToken: options.fetchToken ?? (async () => "jwt"), log: (line) => logs.push(line), sleep: async () => {} });
  connector.start();
  return { convex, daemon, watch, logs, connector };
}

const GIB = 1024 ** 3;

test("a queued row is claimed, dispatched to the daemon and completed with its response", async () => {
  const { convex, daemon, connector } = harness();
  convex.push([row("r1")]);
  await settle();
  assert.deepEqual(convex.named("relay:claim").map((call) => call.args), [{ requestId: "r1" }]);
  assert.deepEqual(daemon.work().map((request) => request.request_id), ["r1"]);
  const [complete] = convex.named("relay:complete");
  assert.equal(complete.args.requestId, "r1");
  assert.deepEqual(complete.args.response.result, { ran: "r1" });
  await connector.stop();
});

test("a row whose claim answers claimed:false never reaches the daemon", async () => {
  const { convex, daemon, connector } = harness();
  convex.claimAnswer = async () => ({ claimed: false, status: "abandoned" });
  convex.push([row("abandoned")]);
  await settle();
  assert.equal(daemon.work().length, 0);
  assert.equal(convex.named("relay:complete").length, 0);
  await connector.stop();
});

test("the same row delivered twice in quick succession is claimed once", async () => {
  const { convex, daemon, connector } = harness();
  let release!: () => void;
  daemon.respond = (request) => new Promise((resolve) => { release = () => resolve(success(request, { ran: request.request_id })); });
  convex.push([row("r1")]);
  convex.push([row("r1")]);
  await settle();
  convex.push([row("r1")]);
  release();
  await settle();
  convex.push([row("r1")]);
  await settle();
  assert.equal(convex.named("relay:claim").length, 1);
  assert.equal(daemon.work().length, 1);
  assert.equal(convex.named("relay:complete").length, 1);
  await connector.stop();
});

test("a row another connector process claimed before dying is reclaimed, run once and completed", async () => {
  const { convex, daemon, connector } = harness();
  convex.push([row("orphan", "claimed")]);
  await settle();
  assert.equal(convex.named("relay:claim").length, 1);
  assert.equal(daemon.work().length, 1);
  assert.equal(convex.named("relay:complete").length, 1);
  await connector.stop();
});

test("an oversized daemon response is replaced by a resource_exhausted failure", async () => {
  const { convex, daemon, connector } = harness();
  daemon.respond = async (request) => success(request, { content: "x".repeat(OUTPUT_CAP_BYTES + 1) });
  convex.push([row("big")]);
  await settle();
  const [complete] = convex.named("relay:complete");
  assert.equal(complete.args.response.ok, false);
  assert.equal(complete.args.response.error.code, "resource_exhausted");
  assert.match(complete.args.response.error.message, new RegExp(String(OUTPUT_CAP_BYTES)));
  assert.ok(Buffer.byteLength(JSON.stringify(complete.args)) < OUTPUT_CAP_BYTES);
  await connector.stop();
});

test("a daemon dispatch error completes with guest_unreachable", async () => {
  const { convex, daemon, connector } = harness();
  daemon.respond = async () => { throw new Error("socket closed"); };
  convex.push([row("down")]);
  await settle();
  assert.equal(convex.named("relay:complete")[0].args.response.error.code, "guest_unreachable");
  await connector.stop();
});

test("capacity is reported to Convex only when its revision changes", async () => {
  const { convex, watch, connector } = harness();
  const capacity = { cpus: 8, total_bytes: 16 * GIB, reserved_bytes: 0, room_bytes: 12 * GIB, running: 0, revision: 1 };
  const started = { ...capacity, reserved_bytes: 4 * GIB, room_bytes: 8 * GIB, running: 1, revision: 2 };
  watch.emit({ version: 1, capacity });
  await settle();
  // A rename or mirror push moves the watch version but not the capacity revision.
  watch.emit({ version: 2, capacity: { ...capacity } });
  await settle();
  watch.emit({ version: 3, capacity: started });
  await settle();
  watch.emit({ version: 4, capacity: { ...started } });
  await settle();
  assert.deepEqual(convex.named("relay:reportCapacity").map((call) => call.args.capacity.revision), [1, 2]);
  assert.deepEqual(watch.sinces, [0, 1, 2, 3, 4]);
  await connector.stop();
});

test("a revoked machine credential stops the connector and closes Convex", async () => {
  const { convex, daemon, connector } = harness({ fetchToken: async () => { throw new RevokedError(); } });
  assert.equal(await convex.fetchToken!({ forceRefreshToken: false }), null);
  assert.equal(await connector.finished, "revoked");
  assert.equal(connector.state().state, "revoked");
  assert.equal(convex.closed, true);
  await settle();
  assert.equal(daemon.reports().at(-1), "revoked");
});

test("a subscription refused because the machine was removed ends the connector once the token route refuses too", async () => {
  let removed = false; const forced: boolean[] = [];
  const { convex, connector } = harness({ fetchToken: async (force) => { forced.push(force); if (removed) throw new RevokedError(); return "jwt"; } });
  // Production Convex sends a refusal as a ConvexError whose data carries the code; the message text is not to be relied on.
  const refused = () => new ConvexError({ code: "unauthorized", message: "Forbidden: machine revoked or unknown" });
  convex.fail("relay:pendingForMachine", refused());
  await settle();
  assert.equal(connector.state().state, "connecting", "while the token route still answers, the connector keeps going");
  removed = true;
  convex.fail("relay:pendingForMachine", refused());
  assert.equal(await connector.finished, "revoked");
  assert.deepEqual(forced, [true, true]);
  assert.equal(convex.closed, true);
});

test("a subscription error that is not about the machine identity does not touch the token", async () => {
  const forced: boolean[] = [];
  const { convex, connector } = harness({ fetchToken: async (force) => { forced.push(force); return "jwt"; } });
  // A thrown non-ConvexError reaches the client redacted to "Server Error", whatever it said.
  convex.fail("sandboxes:forMachine", new Error("[CONVEX Q(sandboxes:forMachine)] [Request ID: 1] Server Error"));
  await settle();
  assert.deepEqual(forced, []);
  await connector.stop();
});

test("auth changes move the state and are reported to the daemon", async () => {
  const { convex, daemon, connector } = harness();
  assert.equal(connector.state().state, "connecting");
  convex.onAuth!(true);
  await settle();
  assert.equal(connector.state().state, "connected");
  await connector.stop();
  assert.deepEqual(daemon.reports(), ["connecting", "connected", "stopped"]);
});

test("an idle connector makes no Convex calls", async () => {
  const { convex, watch, connector } = harness();
  convex.onAuth!(true);
  watch.emit({ version: 1, capacity: { cpus: 8, total_bytes: 16 * GIB, reserved_bytes: 0, room_bytes: 12 * GIB, running: 0, revision: 1 } });
  await settle();
  const before = convex.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  await settle();
  assert.equal(convex.calls.length, before);
  assert.deepEqual(convex.calls.map((call) => call.name), ["relay:pendingForMachine", "sandboxes:forMachine", "relay:reportCapacity"]);
  await connector.stop();
});

test("the machine token is cached until five minutes before expiry and 401 is a revocation", async () => {
  let now = 1_800_000_000_000; let calls = 0; let status = 200;
  const source = new MachineTokenSource({
    apiOrigin: "https://api.example/", secret: "machine-secret", now: () => now,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls++;
      assert.equal(url, "https://api.example/api/relay/machine-token");
      assert.equal((init.headers as Record<string, string>).authorization, "Bearer machine-secret");
      return new Response(JSON.stringify({ token: `jwt-${calls}`, expires_at: now + 10 * 60_000, convex_url: "https://convex.example" }), { status });
    }) as typeof fetch,
  });
  assert.equal((await source.get()).token, "jwt-1");
  now += 4 * 60_000;
  assert.equal((await source.get()).token, "jwt-1");
  now += 2 * 60_000;
  assert.equal((await source.get()).token, "jwt-2");
  assert.equal((await source.get(true)).token, "jwt-3");
  status = 401;
  await assert.rejects(source.get(true), RevokedError);
});

test("the daemon's sandbox mirror follows the catalog subscription", async () => {
  const { convex, daemon, connector } = harness();
  const rows = [{ sandbox_id: "sandbox_1", name: "quiet-otter", cpus: 2, memory_bytes: 2147483648 }];
  convex.pushSandboxes(rows);
  await settle();
  const mirrored = daemon.requests.filter((request) => request.operation === "sandbox.mirror");
  assert.equal(mirrored.length, 1); assert.deepEqual(mirrored[0].input, { source: "catalog", machine_id: "machine_1", sandboxes: rows }); assert.equal(mirrored[0].sandbox_id, null);
  await connector.stop();
});

test("mirror pushes reach the daemon in the order Convex sent them, and what the daemon deleted is logged", async () => {
  const { convex, daemon, logs, connector } = harness();
  const order: number[] = []; const releases: Array<() => void> = [];
  const dispatch = daemon.dispatch.bind(daemon);
  daemon.dispatch = async (request) => {
    if (request.operation !== "sandbox.mirror") return await dispatch(request);
    const count = (request.input as { sandboxes: unknown[] }).sandboxes.length;
    if (count === 1) await new Promise<void>((resolve) => releases.push(resolve));
    order.push(count);
    return success(request, { deleted: count ? [] : [{ sandbox_id: "sandbox_1", detail: "deleted quiet-otter: the catalog no longer lists it" }] });
  };
  convex.pushSandboxes([{ sandbox_id: "sandbox_1", name: "quiet-otter" }]); convex.pushSandboxes([]);
  await settle(); assert.deepEqual(order, [], "the second push waits for the first");
  releases.forEach((release) => release()); await settle();
  assert.deepEqual(order, [1, 0]);
  assert.ok(logs.includes("sandbox sandbox_1 is no longer in the catalog: deleted quiet-otter: the catalog no longer lists it"), logs.join("\n"));
  await connector.stop();
});

test("a result over the daily result bytes completes as a small rate_limited failure naming the limit", async () => {
  const { convex, connector } = harness();
  const mutation = convex.mutation.bind(convex);
  convex.mutation = async (fn, args) => {
    if (args.response?.ok === true) { convex.calls.push({ name: "relay:complete", args }); throw new ConvexError({ code: "rate_limited", message: "the account's daily relay result bytes limit (25000000; reset 2026-10-16T00:00:00.000Z)", details: { limit: "result_bytes" } }); }
    return await mutation(fn, args);
  };
  convex.push([row("limited")]);
  await settle();
  const [, completed] = convex.named("relay:complete");
  assert.equal(completed.args.response.error.code, "rate_limited");
  assert.deepEqual(completed.args.response.error.details, { limit: "result_bytes" });
  assert.match(completed.args.response.error.message, /^the operation ran, but its result was dropped: the account's daily relay result bytes limit \(25000000; reset 2026-10-16T00:00:00\.000Z\)/);
  assert.equal(completed.args.response.error.retryable, true);
  assert.ok(Buffer.byteLength(JSON.stringify(completed.args.response)) < 4096);
  await connector.stop();
});

test("sandbox states are reported to Convex only when one changes", async () => {
  const { convex, watch, connector } = harness();
  const running = { sandbox_id: "sandbox_1", state: "running", cpus: 2, memory_bytes: 2147483648 };
  watch.emit({ version: 1, sandboxes: [running] });
  await settle();
  watch.emit({ version: 2, sandboxes: [{ ...running }] });
  await settle();
  watch.emit({ version: 3, sandboxes: [{ ...running, state: "sleeping" }, { sandbox_id: "sandbox_2", state: "running" }] });
  await settle();
  assert.deepEqual(convex.named("sandboxes:reportState").map((call) => call.args.states), [
    [{ sandboxId: "sandbox_1", state: "running", cpus: 2, memoryBytes: 2147483648 }],
    [{ sandboxId: "sandbox_1", state: "sleeping", cpus: 2, memoryBytes: 2147483648 }, { sandboxId: "sandbox_2", state: "running" }],
  ]);
  await connector.stop();
});

test("sandboxes the daemon deleted for idleness are removed from the catalog once, with the reason", async () => {
  const { convex, watch, logs, connector } = harness();
  const gone = { sandbox_id: "sandbox_1", name: "quiet-otter", reason: "idle for 11 s, past its delete-after of 10 s" };
  watch.emit({ version: 1, sandboxes: [], deleted: [gone] });
  await settle();
  watch.emit({ version: 2, sandboxes: [], deleted: [gone] });
  await settle();
  assert.deepEqual(convex.named("sandboxes:removeIdle").map((call) => call.args), [{ sandboxId: "sandbox_1", reason: gone.reason }]);
  assert.ok(logs.includes(`removed quiet-otter (sandbox_1) from the catalog: ${gone.reason}`));
  await connector.stop();
});
