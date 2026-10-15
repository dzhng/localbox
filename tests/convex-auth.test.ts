import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../packages/state/src/index.js";

import { calls, type Call, type Kind } from "./fixtures/convex-public-functions.js";

async function invoke(t: ReturnType<typeof createConvexTestHarness>, call: Call, identity?: Kind) {
  const client = identity ? t.withIdentity(identity === "service" ? { subject: "service:api" } : { subject: "machine:m1", account: "a1" }) : t;
  const ref = makeFunctionReference(call.name) as any;
  return call.mutation ? client.mutation(ref, call.args) : client.query(ref, call.args);
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
  const t = createConvexTestHarness();
  await t.run(async (ctx) => { await ctx.db.insert("machines", { machineId: "m1", accountId: "a1", credentialHash: "h", name: "machine", createdAt: Date.now(), lastSeenAt: Date.now() }); });
  for (const call of calls) {
    await assert.rejects(() => invoke(t, call), /Unauthenticated|authentication/i, call.name);
    const wrong: Kind = call.kind === "service" ? "machine" : "service";
    await assert.rejects(() => invoke(t, call, wrong), /Forbidden|revoked|identity/i, call.name);
  }
});

test("machine revocation is observed on the next Convex call", async () => {
  const t = createConvexTestHarness();
  await t.run(async (ctx) => { await ctx.db.insert("machines", { machineId: "m1", accountId: "a1", credentialHash: "h", name: "machine", createdAt: Date.now(), lastSeenAt: Date.now() }); });
  const machine = t.withIdentity({ subject: "machine:m1", account: "a1" });
  await machine.query(makeFunctionReference("machines:self") as any, {});
  await t.run(async (ctx) => { const row = await ctx.db.query("machines").withIndex("by_machine", (q: any) => q.eq("machineId", "m1")).first(); await ctx.db.patch(row._id, { revokedAt: Date.now() }); });
  await assert.rejects(() => machine.query(makeFunctionReference("machines:self") as any, {}), /revoked|Forbidden/i);
});
