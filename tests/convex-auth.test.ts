import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../packages/state/src/index.js";

import { calls, type Call } from "./fixtures/convex-public-functions.js";

type Caller = "service" | "machine" | "agent";
const identities: Record<Caller, { subject: string; account?: string }> = { service: { subject: "service:api" }, machine: { subject: "machine:m1", account: "a1" }, agent: { subject: "agent:f1", account: "a1" } };

async function invoke(t: ReturnType<typeof createConvexTestHarness>, call: Call, caller?: Caller) {
  const client = caller ? t.withIdentity(identities[caller]) : t;
  const ref = makeFunctionReference(call.name) as any;
  return call.mutation ? client.mutation(ref, call.args) : client.query(ref, call.args);
}

/** Machine m1 and agent token family f1, both on account a1. */
async function seeded() {
  const t = createConvexTestHarness();
  await t.run(async (ctx) => {
    await ctx.db.insert("machines", { machineId: "m1", accountId: "a1", credentialHash: "h", name: "machine", createdAt: Date.now(), lastSeenAt: Date.now() });
    await ctx.db.insert("oauthTokens", { accountId: "a1", clientId: "c1", scopes: ["account"], constraints: null, familyId: "f1", accessTokenHash: "a", refreshTokenHash: "r", accessExpiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 60_000 });
  });
  return t;
}

test("the guarded list covers every exported public Convex function", async () => {
  const modules = (await readdir(new URL("../packages/state/convex/", import.meta.url))).filter((file) => file.endsWith(".ts") && !["schema.ts", "auth.config.ts"].includes(file));
  const exported: string[] = [];
  for (const file of modules) {
    const module = await import(`../packages/state/convex/${file}`) as Record<string, { isPublic?: boolean }>;
    for (const [name, fn] of Object.entries(module)) if (fn?.isPublic) exported.push(`${file.replace(/\.ts$/, "")}:${name}`);
  }
  assert.deepEqual(exported.sort(), calls.map((call) => call.name).sort());
});

test("every exported public Convex function rejects anonymous and wrong-kind callers", async () => {
  const t = await seeded();
  for (const call of calls) {
    await assert.rejects(() => invoke(t, call), /Unauthenticated|authentication/i, call.name);
    const wrong: Caller[] = call.kind === "service" ? ["machine", "agent"] : call.kind === "machine" ? ["service", "agent"] : ["service"];
    for (const caller of wrong) await assert.rejects(() => invoke(t, call, caller), /Forbidden|revoked|identity/i, `${call.name} as ${caller}`);
  }
});

test("account functions accept an agent, scoped to its account", async () => {
  const t = await seeded();
  await t.run(async (ctx) => { await ctx.db.insert("machines", { machineId: "m2", accountId: "a2", credentialHash: "h2", name: "other", createdAt: Date.now(), lastSeenAt: Date.now() }); });
  const agent = t.withIdentity(identities.agent);
  const listed = await agent.query(makeFunctionReference("machines:list") as any, {}) as Array<{ machineId: string }>;
  assert.deepEqual(listed.map((row) => row.machineId), ["m1"]);
  await assert.rejects(() => agent.mutation(makeFunctionReference("machines:remove") as any, { machineId: "m2" }), /machine not found/);
  // A JWT naming another account than its token family is refused.
  await assert.rejects(() => t.withIdentity({ subject: "agent:f1", account: "a2" }).query(makeFunctionReference("machines:list") as any, {}), /Forbidden/);
});

test("machine and agent revocation are observed on the next Convex call", async () => {
  const t = await seeded();
  const machine = t.withIdentity(identities.machine); const agent = t.withIdentity(identities.agent);
  await machine.query(makeFunctionReference("machines:self") as any, {});
  await agent.query(makeFunctionReference("machines:list") as any, {});
  await t.run(async (ctx) => {
    const row = await ctx.db.query("machines").withIndex("by_machine", (q: any) => q.eq("machineId", "m1")).first(); await ctx.db.patch(row._id, { revokedAt: Date.now() });
    await ctx.db.insert("oauthRevocations", { familyId: "f1", revokedAt: Date.now() });
  });
  await assert.rejects(() => machine.query(makeFunctionReference("machines:self") as any, {}), /revoked|Forbidden/i);
  await assert.rejects(() => agent.query(makeFunctionReference("machines:list") as any, {}), /revoked|Forbidden/i);
});
