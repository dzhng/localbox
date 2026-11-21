import assert from "node:assert/strict";
import test from "node:test";
import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../packages/state/src/index.js";

const ref = (name: string) => makeFunctionReference(name) as any;
const code = (expected: string) => (error: any) => error.data?.code === expected;
const GIB = 1024 ** 3;
const lan = (address: string) => [{ kind: "local", address, port: 50_000 }];

/**
 * Account a1 with machines studio (m1), attic (m2) and den (m3), and image rails-dev held ready on studio. `agent` is a
 * signed-in agent on a1; `other` is a machine on another account.
 */
async function setup() {
  const t = createConvexTestHarness();
  await t.run(async (ctx) => {
    const now = Date.now();
    for (const account of ["a1", "a2"]) await ctx.db.insert("accounts", { accountId: account, email: `${account}@example.com`, name: account, createdAt: now });
    for (const [machineId, name, accountId] of [["m1", "studio", "a1"], ["m2", "attic", "a1"], ["m3", "den", "a1"], ["x1", "elsewhere", "a2"]]) {
      await ctx.db.insert("machines", { machineId, accountId, credentialHash: `h-${machineId}`, name, createdAt: now, lastSeenAt: now });
    }
    await ctx.db.insert("oauthTokens", { accountId: "a1", clientId: "c1", scopes: ["account"], constraints: null, familyId: "f1", accessTokenHash: "a", refreshTokenHash: "r", accessExpiresAt: now + 60_000, refreshExpiresAt: now + 60_000 });
  });
  const agent = t.withIdentity({ subject: "agent:f1", account: "a1" });
  const machine = (id: string, account = "a1") => t.withIdentity({ subject: `machine:${id}`, account });
  const [m1, m2, m3, other] = [machine("m1"), machine("m2"), machine("m3"), machine("x1", "a2")];
  const image = await agent.mutation(ref("images:reserve"), { machineId: "m1", name: "rails-dev", os: "linux", source: { kind: "sandbox", sandboxName: "bold-otter" }, createMutationId: "capture-1" }) as any;
  await m1.mutation(ref("images:setHolder"), { imageId: image.image_id, state: "ready", sizeBytes: 3 * GIB });
  const start = (args: Record<string, unknown> = {}) => agent.mutation(ref("images:startCopy"), { image: image.image_id, fromMachineId: "m1", toMachineId: "m2", createMutationId: "copy-1", ...args }) as Promise<any>;
  const holders = async () => ((await agent.query(ref("images:get"), { image: "rails-dev" })) as any).holders.map((holder: any) => [holder.machine_name, holder.state, holder.operation_id]).sort();
  const rows = async (client: typeof m1) => await client.query(ref("images:copiesForMachine"), {}) as any[];
  return { t, agent, m1, m2, m3, other, image, start, holders, rows };
}

test("a copy starts waiting with the target holding copying under the copy's mutation id; a replay returns the same copy", async () => {
  const { agent, start, holders } = await setup();
  const copy = await start();
  assert.equal(copy.state, "waiting");
  assert.deepEqual([copy.from_machine_name, copy.to_machine_name, copy.operation_id], ["studio", "attic", "copy-1"]);
  assert.deepEqual(await holders(), [["attic", "copying", "copy-1"], ["studio", "ready", "capture-1"]]);
  assert.deepEqual(await start(), copy, "the same mutation id starts nothing new");
  assert.deepEqual(await agent.query(ref("images:copyByOperation"), { operationId: "copy-1" }), copy);
  assert.equal(await agent.query(ref("images:copyByOperation"), { operationId: "copy-unknown" }), null);
});

test("the key is readable only by the copy's two machines: never by the agent, a third machine of the account, or another account", async () => {
  const { t, agent, m1, m2, m3, other, start, rows } = await setup();
  const copy = await start();
  const stored = await t.run(async (ctx) => await ctx.db.query("copies").first()) as any;
  assert.match(stored.key, /^[A-Za-z0-9+/]{43}=$/, "32 random bytes");
  assert.ok(!JSON.stringify(copy).includes(stored.key) && !("key" in copy), "the agent's start view has no key");
  assert.ok(!JSON.stringify(await agent.query(ref("images:copyByOperation"), { operationId: "copy-1" })).includes(stored.key));
  const [sender] = await rows(m1); const [receiver] = await rows(m2);
  assert.deepEqual([sender.role, sender.key, receiver.role, receiver.key], ["sender", stored.key, "receiver", stored.key]);
  assert.equal(receiver.size_bytes, 3 * GIB, "the receiver learns how much room the copy needs");
  assert.deepEqual(await rows(m3), [], "a third machine sees nothing");
  assert.deepEqual(await rows(other), []);
  await assert.rejects(() => agent.query(ref("images:copiesForMachine"), {}), code("unauthorized"), "agents can't read it at all");
  await assert.rejects(() => m3.mutation(ref("images:offerCandidates"), { copyId: copy.copy_id, candidates: lan("10.0.0.3") }), code("image_not_found"));
  await assert.rejects(() => other.mutation(ref("images:cancelCopy"), { copyId: copy.copy_id, error: { code: "internal", message: "x", nextStep: "y" } }), code("image_not_found"));
});

test("lifecycle: both ends publish candidates (copying), each sees the other's, the receiver reports it copied and its holding is ready", async () => {
  const { agent, m1, m2, start, holders, rows } = await setup();
  const copy = await start();
  assert.deepEqual(await m1.mutation(ref("images:offerCandidates"), { copyId: copy.copy_id, candidates: lan("10.0.0.1") }), { copy_id: copy.copy_id, state: "waiting", expired: false });
  assert.equal((await rows(m2))[0].peer_candidates[0].address, "10.0.0.1", "the receiver sees the sender's candidates");
  assert.equal((await m2.mutation(ref("images:offerCandidates"), { copyId: copy.copy_id, candidates: lan("10.0.0.2") }) as any).state, "copying");
  // A restarted receiver publishes new candidates in place of its old ones.
  await m2.mutation(ref("images:offerCandidates"), { copyId: copy.copy_id, candidates: lan("10.0.0.22") });
  const [sender] = await rows(m1);
  assert.deepEqual([sender.state, sender.candidates[0].address, sender.peer_candidates[0].address], ["copying", "10.0.0.1", "10.0.0.22"]);

  assert.deepEqual(await m1.mutation(ref("images:endCopy"), { operationId: "copy-1", state: "succeeded", result: { bytes: 3 * GIB, durationMs: 9_000, path: "local_network" } }), { operation_id: "copy-1", reported: true, state: "copying" }, "the sender's success changes nothing");
  assert.deepEqual(await holders(), [["attic", "copying", "copy-1"], ["studio", "ready", "capture-1"]]);
  await m2.mutation(ref("images:endCopy"), { operationId: "copy-1", state: "succeeded", sizeBytes: 3 * GIB, result: { bytes: 3 * GIB, durationMs: 9_500, path: "local_network" } });
  assert.deepEqual(await holders(), [["attic", "ready", "copy-1"], ["studio", "ready", "capture-1"]]);
  const done = await agent.query(ref("images:copyByOperation"), { operationId: "copy-1" }) as any;
  assert.deepEqual([done.state, done.result], ["copied", { bytes: 3 * GIB, duration_ms: 9_500, path: "local_network" }]);
  assert.deepEqual(await m2.query(ref("images:forMachine"), {}), [{ image_id: copy.image_id, state: "ready" }], "the receiver's image mirror now lists it ready");
});

test("a sender that fails fails the copy, so the receiver stops waiting; the receiver's failure is its holding's", async () => {
  const { agent, m1, m2, start, holders, rows } = await setup();
  await start();
  const gaveUp = { code: "image_not_found", message: "image rails-dev is no longer on this Mac", nextStep: "copy it from another Mac that holds it" };
  await m1.mutation(ref("images:endCopy"), { operationId: "copy-1", state: "failed", error: gaveUp });
  assert.deepEqual([(await rows(m2))[0].state, (await rows(m2))[0].error.code], ["failed", "image_not_found"], "the receiver's subscription hears it");
  assert.deepEqual(await holders(), [["attic", "copying", "copy-1"], ["studio", "ready", "capture-1"]]);
  const unreachable = { code: "copy_unreachable", message: "tried local network 10.0.0.1:50000 (timed out)", nextStep: "put both Macs on the same network once, then copy" };
  await m2.mutation(ref("images:endCopy"), { operationId: "copy-1", state: "failed", error: unreachable });
  const image = await agent.query(ref("images:get"), { image: "rails-dev" }) as any;
  assert.deepEqual(image.holders.find((holder: any) => holder.machine_name === "attic").error, { code: "copy_unreachable", message: unreachable.message, next_step: unreachable.nextStep });
  assert.equal((await agent.query(ref("images:copyByOperation"), { operationId: "copy-1" }) as any).error.code, "image_not_found", "the copy keeps its first cause");
  await assert.rejects(() => m2.mutation(ref("images:endCopy"), { operationId: "copy-1", state: "failed" }), code("invalid_input"));
});

test("a copy expires after 24 h: its ends can't publish or report any more, and the daily cleanup drops the row and fails a target still copying", async () => {
  const { t, agent, m1, m2, start, holders, rows } = await setup();
  const copy = await start();
  await t.run(async (ctx) => { const row = await ctx.db.query("copies").first() as any; assert.ok(Math.abs(row.expiresAt - row.createdAt - 24 * 60 * 60 * 1000) < 1); await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 }); });
  assert.deepEqual(await m1.mutation(ref("images:offerCandidates"), { copyId: copy.copy_id, candidates: lan("10.0.0.1") }), { copy_id: copy.copy_id, state: "waiting", expired: true });
  assert.deepEqual(await m2.mutation(ref("images:endCopy"), { operationId: "copy-1", state: "succeeded" }), { operation_id: "copy-1", reported: false });
  assert.equal(await agent.query(ref("images:copyByOperation"), { operationId: "copy-1" }), null);
  assert.deepEqual(await rows(m1), [], "the subscription no longer carries the key");
  await t.run(async (ctx) => { await ctx.runMutation(ref("relay:cleanupExpired"), {}); });
  assert.deepEqual(await t.run(async (ctx) => await ctx.db.query("copies").collect()), [], "the row and its key are gone");
  assert.deepEqual(await rows(m1), []);
  assert.deepEqual(await holders(), [["attic", "failed", "copy-1"], ["studio", "ready", "capture-1"]]);
});

test("refusals: linux, a copy to itself, a source not holding it ready, a target that holds it or is already copying it; a failed target can be copied again", async () => {
  const { agent, m2, image, start } = await setup();
  await assert.rejects(() => start({ image: "linux" }), code("invalid_input"));
  await assert.rejects(() => start({ toMachineId: "m1" }), code("invalid_input"));
  await assert.rejects(() => start({ fromMachineId: "m3", toMachineId: "m2" }), code("image_not_found"));
  await assert.rejects(() => start({ toMachineId: "x1" }), code("machine_not_found"));
  await start();
  await assert.rejects(() => start({ createMutationId: "copy-2" }), (error: any) => error.data?.code === "conflict" && /already being copied to attic/.test(error.data.message));
  await m2.mutation(ref("images:endCopy"), { operationId: "copy-1", state: "failed", error: { code: "copy_unreachable", message: "no path", nextStep: "same network" } });
  const again = await start({ createMutationId: "copy-2" });
  assert.equal(again.state, "waiting");
  await m2.mutation(ref("images:endCopy"), { operationId: "copy-2", state: "succeeded" });
  await assert.rejects(() => start({ createMutationId: "copy-3" }), (error: any) => error.data?.code === "conflict" && /already holds/.test(error.data.message));
  const listed = (await agent.query(ref("images:get"), { image: image.image_id }) as any).holders;
  assert.equal(listed.find((holder: any) => holder.machine_id === "m2").error, null, "a fresh start cleared the old failure");
});

test("a late outcome of an earlier copy to the same Mac leaves the running copy's holding alone", async () => {
  const { t, m2, start, holders } = await setup();
  await start();
  // The first copy's row outlives its holding: a second copy took the target over (its rendezvous died meanwhile).
  await t.run(async (ctx) => { const row = await ctx.db.query("copies").first() as any; await ctx.db.patch(row._id, { state: "failed" }); });
  await m2.mutation(ref("images:endCopy"), { operationId: "copy-1", state: "failed", error: { code: "copy_unreachable", message: "no path", nextStep: "same network" } });
  await start({ createMutationId: "copy-2" });
  assert.deepEqual(await holders(), [["attic", "copying", "copy-2"], ["studio", "ready", "capture-1"]]);
  await m2.mutation(ref("images:endCopy"), { operationId: "copy-1", state: "failed", error: { code: "copy_unreachable", message: "late", nextStep: "same network" } });
  await m2.mutation(ref("images:endCopy"), { operationId: "copy-1", state: "succeeded" });
  assert.deepEqual(await holders(), [["attic", "copying", "copy-2"], ["studio", "ready", "capture-1"]], "copy-2 still owns attic's holding");
});

test("a copy neither Mac started is cancelled: failed with why, and the target's holding goes; deleting the image deletes its copies", async () => {
  const { t, agent, start, holders } = await setup();
  const copy = await start();
  assert.deepEqual(await agent.mutation(ref("images:cancelCopy"), { copyId: copy.copy_id, error: { code: "machine_offline", message: "attic did not pick up the request", nextStep: "start attic's connector, then copy again" } }), { copy_id: copy.copy_id, cancelled: true });
  assert.deepEqual(await holders(), [["studio", "ready", "capture-1"]]);
  assert.equal((await agent.query(ref("images:copyByOperation"), { operationId: "copy-1" }) as any).state, "failed");
  await agent.mutation(ref("images:remove"), { image: "rails-dev" });
  assert.deepEqual(await t.run(async (ctx) => await ctx.db.query("copies").collect()), []);
});
