import assert from "node:assert/strict";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
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
  claimAnswer: (requestId: string) => Promise<{ claimed: boolean; status: string }> = async () => ({ claimed: true, status: "claimed" });
  setAuth(fetchToken: FakeConvex["fetchToken"], onChange?: (authenticated: boolean) => void): void { this.fetchToken = fetchToken; this.onAuth = onChange; }
  onUpdate(query: any, args: any, callback: (rows: any) => unknown): () => void {
    const name = getFunctionName(query); this.calls.push({ name, args }); this.listeners.set(name, callback); return () => { this.listeners.delete(name); };
  }
  async mutation(fn: any, args: any): Promise<any> {
    const name = getFunctionName(fn); this.calls.push({ name, args });
    if (name === "relay:claim") return await this.claimAnswer(args.requestId);
    return null;
  }
  async close(): Promise<void> { this.closed = true; }
  push(rows: PendingRow[]): void { this.listeners.get("relay:pendingForMachine")?.(rows); }
  pushSandboxes(rows: unknown[]): void { this.listeners.get("sandboxes:forMachine")?.(rows); }
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
  const connector = new Connector({ convex, daemon, hostWatch: watch.watch, fetchToken: options.fetchToken ?? (async () => "jwt"), log: (line) => logs.push(line), sleep: async () => {} });
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
  assert.equal(mirrored.length, 1); assert.deepEqual(mirrored[0].input, { sandboxes: rows }); assert.equal(mirrored[0].sandbox_id, null);
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
