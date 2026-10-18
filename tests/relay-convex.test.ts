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
  assert.equal(await service.query(ref("relay:result"), { requestId: "old" }), null, "an expired request reads as absent, so a waiter on it ends");
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

test("a replay of an abandoned request queues afresh instead of answering machine_offline again", async () => {
  const t = await setup(); const service = t.withIdentity({ subject: "service:api" }); const machine = t.withIdentity({ subject: "machine:m1", account: "a1" });
  const enqueue = (requestId: string) => service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId, operation: "x", mutationId: "mut", sandboxId: "s", payload: { a: 1, sandbox_id: "s" } }) as Promise<any>;
  await enqueue("r1");
  assert.deepEqual(await service.mutation(ref("relay:abandonIfUnclaimed"), { requestId: "r1" }), { abandoned: true, lastSeenAt: (await t.run(async (ctx) => (await ctx.db.query("machines").first())!.lastSeenAt)) });
  const replay = await enqueue("r2");
  assert.equal(replay.requestId, "r2"); assert.equal(replay.status, "queued");
  assert.deepEqual(await machine.mutation(ref("relay:claim"), { requestId: "r2" }), { claimed: true, status: "claimed" });
  assert.equal((await enqueue("r3")).requestId, "r2", "a live row still deduplicates");
  await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "same", operation: "x", payload: {} });
  await service.mutation(ref("relay:abandonIfUnclaimed"), { requestId: "same" });
  assert.equal((await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "same", operation: "x", payload: {} }) as any).status, "queued");
});

test("expected failures are ConvexErrors with a code, since production redacts every other message", async () => {
  const t = await setup(); const service = t.withIdentity({ subject: "service:api" }); const m2 = t.withIdentity({ subject: "machine:m2", account: "a1" });
  await service.mutation(ref("relay:enqueue"), { accountId: "a1", machineId: "m1", requestId: "r1", operation: "x", payload: {} });
  await assert.rejects(() => m2.mutation(ref("relay:claim"), { requestId: "r1" }), (error: any) => error.data?.code === "invalid_input");
  await assert.rejects(() => t.withIdentity({ subject: "machine:gone", account: "a1" }).query(ref("relay:pendingForMachine"), {}), (error: any) => error.data?.code === "unauthorized");
  await assert.rejects(() => t.query(ref("relay:result"), { requestId: "r1" }), (error: any) => error.data?.code === "unauthorized");
});

test("the daily cleanup also removes dead sign-in, OAuth and machine rows, and keeps live ones", async () => {
  const t = await setup(); const now = Date.now(); const day = 86_400_000;
  await t.run(async (ctx) => {
    await ctx.db.insert("emailCodes", { email: "old@example.com", codeHash: "h", expiresAt: now - 1, attempts: 0, createdAt: now - 1_000 });
    await ctx.db.insert("emailCodes", { email: "live@example.com", codeHash: "h", expiresAt: now + 60_000, attempts: 0, createdAt: now });
    await ctx.db.insert("rateLimits", { key: "k", bucket: "old", count: 1, resetAt: now - 1 });
    await ctx.db.insert("rateLimits", { key: "k", bucket: "live", count: 1, resetAt: now + 60_000 });
    const code = { accountId: "a1", clientId: "c", redirectUri: "https://x", resource: "r", codeChallenge: "c" };
    await ctx.db.insert("authCodes", { ...code, codeHash: "old", expiresAt: now - 2 * day, usedAt: now - 2 * day });
    await ctx.db.insert("authCodes", { ...code, codeHash: "live", expiresAt: now + 60_000 });
    const token = { accountId: "a1", clientId: "c", scopes: ["account" as const], constraints: null, accessExpiresAt: now };
    await ctx.db.insert("oauthTokens", { ...token, familyId: "expired", accessTokenHash: "a1", refreshTokenHash: "r1", refreshExpiresAt: now - 1 });
    await ctx.db.insert("oauthTokens", { ...token, familyId: "revoked", accessTokenHash: "a2", refreshTokenHash: "r2", refreshExpiresAt: now + day });
    await ctx.db.insert("oauthRevocations", { familyId: "revoked", revokedAt: now - 2 * 60 * 60_000 });
    await ctx.db.insert("oauthTokens", { ...token, familyId: "live", accessTokenHash: "a3", refreshTokenHash: "r3", refreshExpiresAt: now + day });
    await ctx.db.insert("machines", { machineId: "m_removed", accountId: "a1", credentialHash: "h9", name: "gone", createdAt: now - 3 * day, lastSeenAt: now - 3 * day, revokedAt: now - 2 * day });
    await ctx.db.insert("machines", { machineId: "m_just_removed", accountId: "a1", credentialHash: "h8", name: "going", createdAt: now, lastSeenAt: now, revokedAt: now - 1 });
  });
  await t.run(async (ctx) => { await ctx.runMutation(makeFunctionReference<"mutation">("relay:cleanupExpired") as any, {}); });
  await t.run(async (ctx) => {
    assert.deepEqual((await ctx.db.query("emailCodes").collect()).map((row) => row.email), ["live@example.com"]);
    assert.deepEqual((await ctx.db.query("rateLimits").collect()).map((row) => row.bucket), ["live"]);
    assert.deepEqual((await ctx.db.query("authCodes").collect()).map((row) => row.codeHash), ["live"]);
    assert.deepEqual((await ctx.db.query("oauthTokens").collect()).map((row) => row.familyId), ["live"]);
    assert.deepEqual(await ctx.db.query("oauthRevocations").collect(), []);
    assert.deepEqual((await ctx.db.query("machines").collect()).map((row) => row.machineId).sort(), ["m1", "m2", "m_just_removed"]);
  });
});

test("removed machines stay out of the account's machine list and sign-in count", async () => {
  const t = await setup();
  await t.run(async (ctx) => { for (let i = 0; i < 3; i++) await ctx.db.insert("machines", { machineId: `old${i}`, accountId: "a1", credentialHash: `o${i}`, name: `old-${i}`, createdAt: 0, lastSeenAt: 0, revokedAt: 1 }); });
  const listed = await t.withIdentity({ subject: "machine:m1", account: "a1" }).query(ref("machines:list"), {}) as any[];
  assert.deepEqual(listed.map((row) => row.machineId).sort(), ["m1", "m2"]);
});
