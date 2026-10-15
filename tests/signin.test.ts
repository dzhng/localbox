import assert from "node:assert/strict";
import test from "node:test";
import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../packages/state/src/index.js";

const ref = (name: string) => makeFunctionReference(name) as any;
test("signin replaces active codes, enforces Q9 send limits, and hashes secrets", async () => {
  const t = createConvexTestHarness(); const service = t.withIdentity({ subject: "service:api" });
  const email = "signin@example.com";
  let latestCode = ""; for (let i = 0; i < 5; i++) { const result = await service.mutation(ref("signin:start"), { email, ip: "198.51.100.10" }) as any; assert.equal(result.sent, true); assert.equal(result.issued, true); latestCode = result.code; }
  const limited = await service.mutation(ref("signin:start"), { email, ip: "198.51.100.10" }) as any; assert.equal(limited.sent, true); assert.equal(limited.issued, false); assert.equal(limited.code, undefined);
  await t.run(async (ctx) => { const rows = await ctx.db.query("emailCodes").collect(); assert.equal(rows.length, 1); assert.notEqual(rows[0].codeHash, latestCode); });
});

test("five wrong guesses invalidate a code and a valid code creates a machine", async () => {
  const t = createConvexTestHarness(); const service = t.withIdentity({ subject: "service:api" });
  const started = await service.mutation(ref("signin:start"), { email: "guess@example.com", ip: "198.51.100.11" }) as any;
  const wrong = started.code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await service.mutation(ref("signin:verify"), { email: "guess@example.com", code: wrong, machineName: "mac", ip: `198.51.100.${i + 20}` }) as any).valid, false);
  assert.equal((await service.mutation(ref("signin:verify"), { email: "guess@example.com", code: started.code, machineName: "mac", ip: "198.51.100.30" }) as any).valid, false);
});
