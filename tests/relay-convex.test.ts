import assert from "node:assert/strict";
import test from "node:test";
import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../packages/state/src/index.js";
import { OUTPUT_CAP_BYTES } from "../packages/contract/src/index.js";

const ref = (name: string) => makeFunctionReference(name) as any;
async function setup() {
  const t = createConvexTestHarness();
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("machines", { machineId: "m1", accountId: "a1", credentialHash: "h1", name: "one", createdAt: now, lastSeenAt: now });
    await ctx.db.insert("machines", { machineId: "m2", accountId: "a1", credentialHash: "h2", name: "two", createdAt: now, lastSeenAt: now });
    await ctx.db.insert("sandboxes", { sandboxId: "s", accountId: "a1", machineId: "m1", name: "quiet-otter", cpus: 2, memoryBytes: 2 * 1024 ** 3, sleepAfterMs: 1_800_000, createdAt: now });
  });
  return t;
}

test("relay claim window and service abandonment are atomic", async () => {
  const t = await setup(); const service = t.withIdentity({ subject: "service:api" }); const machine = t.withIdentity({ subject: "machine:m1", account: "a1" });
  await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "r1", operation: "x", payload: {} });
  const old = Date.now; Date.now = () => old() + 3_001;
  try { assert.deepEqual(await machine.mutation(ref("relay:claim"), { requestId: "r1" }), { claimed: false, status: "abandoned" }); } finally { Date.now = old; }
  await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "r2", operation: "x", payload: {} });
  await machine.mutation(ref("relay:claim"), { requestId: "r2" });
  assert.deepEqual(await service.mutation(ref("relay:abandonIfUnclaimed"), { requestId: "r2" }), { abandoned: false, status: "claimed" });
});

test("machines only see and claim their own rows; mutation replay deduplicates", async () => {
  const t = await setup(); const service = t.withIdentity({ subject: "service:api" }); const m1 = t.withIdentity({ subject: "machine:m1", account: "a1" }); const m2 = t.withIdentity({ subject: "machine:m2", account: "a1" });
  const first = await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "r1", operation: "x", mutationId: "mut", sandboxId: "s", payload: { a: 1, sandbox_id: "s" } }) as any;
  const replay = await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "r2", operation: "x", mutationId: "mut", sandboxId: "s", payload: { a: 1, sandbox_id: "s" } }) as any;
  assert.equal(replay.requestId, first.requestId); assert.deepEqual(await m2.query(ref("relay:pendingForMachine"), {}), []);
  await assert.rejects(() => m2.mutation(ref("relay:claim"), { requestId: "r1" }), /not found/);
  await assert.rejects(() => service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "r3", operation: "x", mutationId: "mut", sandboxId: "s", payload: { a: 2, sandbox_id: "s" } }), /mutation id conflicts/);
});

test("relay completion enforces the output cap and daily request limit", async () => {
  const t = await setup(); const service = t.withIdentity({ subject: "service:api" }); const machine = t.withIdentity({ subject: "machine:m1", account: "a1" });
  await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "large", operation: "x", payload: {} }); await machine.mutation(ref("relay:claim"), { requestId: "large" });
  await assert.rejects(() => machine.mutation(ref("relay:complete"), { requestId: "large", response: "x".repeat(OUTPUT_CAP_BYTES) }), (error: any) => error.data?.code === "resource_exhausted");
  const old = process.env.LOCALBOX_RELAY_DAILY_REQUESTS; process.env.LOCALBOX_RELAY_DAILY_REQUESTS = "3";
  try {
    for (let i = 0; i < 2; i++) await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: `q${i}`, operation: "x", payload: {} });
    await assert.rejects(() => service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "q3", operation: "x", payload: {} }), (error: any) => error.data?.code === "rate_limited" && error.data.details.limit === "requests" && /request limit \(3; reset/.test(error.data.message));
  } finally { if (old === undefined) delete process.env.LOCALBOX_RELAY_DAILY_REQUESTS; else process.env.LOCALBOX_RELAY_DAILY_REQUESTS = old; }
});

test("past the daily result bytes, a result is refused but a small failure still completes the row", async () => {
  const t = await setup(); const service = t.withIdentity({ subject: "service:api" }); const machine = t.withIdentity({ subject: "machine:m1", account: "a1" });
  const old = process.env.LOCALBOX_RELAY_DAILY_RESULT_BYTES; process.env.LOCALBOX_RELAY_DAILY_RESULT_BYTES = "100";
  try {
    await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "big", operation: "x", payload: {} }); await machine.mutation(ref("relay:claim"), { requestId: "big" });
    await assert.rejects(() => machine.mutation(ref("relay:complete"), { requestId: "big", response: { ok: true, result: "x".repeat(200) } }), (error: any) => error.data?.code === "rate_limited" && error.data.details.limit === "result_bytes" && /\(100; reset/.test(error.data.message));
    const refused = { ok: false, error: { code: "rate_limited", message: "the account's daily relay result bytes limit (100)", retryable: true, details: { limit: "result_bytes" } } };
    await machine.mutation(ref("relay:complete"), { requestId: "big", response: refused });
    assert.deepEqual(await service.query(ref("relay:result"), { requestId: "big" }), { accountId: "a1", status: "completed", response: refused });
    await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "huge-failure", operation: "x", payload: {} }); await machine.mutation(ref("relay:claim"), { requestId: "huge-failure" });
    await assert.rejects(() => machine.mutation(ref("relay:complete"), { requestId: "huge-failure", response: { ok: false, error: { message: "x".repeat(5_000) } } }), (error: any) => error.data?.code === "rate_limited", "only a small failure is exempt");
  } finally { if (old === undefined) delete process.env.LOCALBOX_RELAY_DAILY_RESULT_BYTES; else process.env.LOCALBOX_RELAY_DAILY_RESULT_BYTES = old; }
});

test("cleanupExpired removes rows before a supplied cutoff", async () => {
  const t = await setup(); const service = t.withIdentity({ subject: "service:api" });
  await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "old", operation: "x", payload: {} });
  await t.run(async (ctx) => { await ctx.runMutation(makeFunctionReference<"mutation">("relay:cleanupExpired") as any, { cutoff: Date.now() + 1, batch: 200 }); });
  await assert.rejects(() => service.query(ref("relay:result"), { requestId: "old" }), /not found/);
});

test("request and mutation ids never match across machines, and a machine re-claims its own unfinished row", async () => {
  const t = await setup(); const service = t.withIdentity({ subject: "service:api" }); const machine = t.withIdentity({ subject: "machine:m1", account: "a1" });
  await t.run(async (ctx) => { await ctx.db.insert("machines", { machineId: "m3", accountId: "a2", credentialHash: "h3", name: "three", createdAt: Date.now(), lastSeenAt: Date.now() }); });
  await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "shared", operation: "x", mutationId: "mut", payload: {} });
  await assert.rejects(() => service.mutation(ref("relay:enqueue"), { accountId: "a2", machineId: "m3", requestId: "shared", operation: "x", payload: {} }), /conflicts/);
  const other = await service.mutation(ref("relay:enqueue"), { accountId: "a2", machineId: "m3", requestId: "fresh", operation: "x", mutationId: "mut", payload: {} }) as any;
  assert.equal(other.requestId, "fresh");
  assert.deepEqual(await machine.mutation(ref("relay:claim"), { requestId: "shared" }), { claimed: true, status: "claimed" });
  assert.deepEqual((await machine.query(ref("relay:pendingForMachine"), {}) as any[]).map((row) => [row.requestId, row.status]), [["shared", "claimed"]]);
  assert.deepEqual(await machine.mutation(ref("relay:claim"), { requestId: "shared" }), { claimed: true, status: "claimed" });
});

test("a request reaches only the machine and account that hold its sandbox", async () => {
  const t = await setup(); const service = t.withIdentity({ subject: "service:api" });
  await t.run(async (ctx) => { await ctx.db.insert("machines", { machineId: "m3", accountId: "a2", credentialHash: "h3", name: "three", createdAt: Date.now(), lastSeenAt: Date.now() }); });
  const enqueue = (accountId: string, machineId: string, requestId: string, sandboxId: string) => service.mutation(ref("relay:enqueue"), { accountId, machineId, requestId, operation: "fs.stat", sandboxId, payload: { sandbox_id: sandboxId, input: {} } });
  await enqueue("a1", "m1", "own", "s");
  await assert.rejects(() => enqueue("a1", "m2", "other-machine", "s"), /sandbox not found/);
  await assert.rejects(() => enqueue("a2", "m3", "other-account", "s"), /sandbox not found/);
  await assert.rejects(() => service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "mismatch", operation: "fs.stat", sandboxId: "s", payload: { sandbox_id: "elsewhere" } }), /does not match/);
});
