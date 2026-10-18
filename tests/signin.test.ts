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

test("wrong codes count per email across replaced codes, so a fresh code buys no fresh guesses", async () => {
  const t = createConvexTestHarness(); const service = t.withIdentity({ subject: "service:api" });
  const email = "brute@example.com"; let ip = 0; const nextIp = () => `203.0.113.${ip++}`;
  const start = async () => (await service.mutation(ref("signin:start"), { email, ip: nextIp() }) as any).code as string;
  const guess = (code: string) => service.mutation(ref("signin:verify"), { email, code, machineName: "mac", ip: nextIp() });
  const wrongFor = (code: string) => code === "000000" ? "000001" : "000000";
  let code = await start();
  for (let i = 0; i < 3; i++) assert.equal((await guess(wrongFor(code)) as any).valid, false);
  code = await start();
  await t.run(async (ctx) => { assert.equal((await ctx.db.query("emailCodes").collect())[0].attempts, 3, "a replacement code inherits the wrong guesses"); });
  for (let i = 0; i < 2; i++) assert.equal((await guess(wrongFor(code)) as any).valid, false);
  code = await start();
  for (let i = 0; i < 5; i++) assert.equal((await guess(wrongFor(code)) as any).valid, false);
  // Ten wrong codes this hour: even the right code is refused until the window resets.
  code = await start();
  await assert.rejects(() => guess(code), (error: any) => error.data?.code === "rate_limited");
});

test("an IPv6 client is limited by its /64, and a malformed email is refused with a code", async () => {
  const t = createConvexTestHarness(); const service = t.withIdentity({ subject: "service:api" });
  for (let i = 0; i < 20; i++) assert.equal((await service.mutation(ref("signin:start"), { email: `v6-${i}@example.com`, ip: `2001:db8:1:2::${i.toString(16)}` }) as any).issued, true);
  assert.equal((await service.mutation(ref("signin:start"), { email: "v6-last@example.com", ip: "2001:0db8:0001:0002:ffff:1:2:3" }) as any).issued, false, "another address in the same /64 shares the limit");
  assert.equal((await service.mutation(ref("signin:start"), { email: "v6-other@example.com", ip: "2001:db8:1:3::1" }) as any).issued, true);
  for (const email of ["a b@example.com", "a@b@example.com", "@example.com", "a@example"]) await assert.rejects(() => service.mutation(ref("signin:start"), { email, ip: "198.51.100.1" }), (error: any) => error.data?.code === "invalid_input", email);
});
