import assert from "node:assert/strict";
import test from "node:test";
import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../packages/state/src/index.js";

const ref = (name: string) => makeFunctionReference(name) as any;
const code = (expected: string) => (error: any) => error.data?.code === expected;
const fromSandbox = { kind: "sandbox", sandboxName: "quiet-otter" } as const;

/** Account a1 with machines m1 ("studio") and m2 ("attic"); `agent` is a signed-in agent on a1. */
async function setup() {
  const t = createConvexTestHarness();
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("accounts", { accountId: "a1", email: "a@example.com", name: "brave-walrus-100", createdAt: now });
    await ctx.db.insert("machines", { machineId: "m1", accountId: "a1", credentialHash: "h1", name: "studio", createdAt: now, lastSeenAt: now });
    await ctx.db.insert("machines", { machineId: "m2", accountId: "a1", credentialHash: "h2", name: "attic", createdAt: now, lastSeenAt: now });
    await ctx.db.insert("oauthTokens", { accountId: "a1", clientId: "c1", scopes: ["account"], constraints: null, familyId: "f1", accessTokenHash: "a", refreshTokenHash: "r", accessExpiresAt: now + 60_000, refreshExpiresAt: now + 60_000 });
  });
  return { t, agent: t.withIdentity({ subject: "agent:f1", account: "a1" }), m1: t.withIdentity({ subject: "machine:m1", account: "a1" }), m2: t.withIdentity({ subject: "machine:m2", account: "a1" }) };
}
type Client = Awaited<ReturnType<typeof setup>>["agent"];
let mutations = 0;
const reserve = (client: Client, args: Record<string, unknown> = {}) => client.mutation(ref("images:reserve"), { machineId: "m1", os: "linux", source: fromSandbox, createMutationId: `cli-${++mutations}`, ...args }) as Promise<any>;
const list = async (client: Client) => await client.query(ref("images:list"), {}) as any[];

test("linux is listed with every live machine as a ready holder, is the default, and is never a row", async () => {
  const { t, agent } = await setup();
  const [linux, ...rest] = await list(agent);
  assert.deepEqual(rest, []);
  assert.equal(linux.name, "linux"); assert.equal(linux.default, true);
  assert.deepEqual(linux.holders.map((holder: any) => [holder.machine_name, holder.state]), [["studio", "ready"], ["attic", "ready"]]);
  assert.deepEqual(await t.run(async (ctx) => await ctx.db.query("images").collect()), []);
});

test("linux can't be renamed, deleted, dropped or reserved, and macos can't be used as a name", async () => {
  const { agent } = await setup();
  const image = await reserve(agent, { name: "rails-dev" });
  await assert.rejects(() => agent.mutation(ref("images:rename"), { image: "linux", name: "my-linux" }), code("invalid_input"));
  await assert.rejects(() => agent.mutation(ref("images:remove"), { image: "linux" }), code("invalid_input"));
  await assert.rejects(() => agent.mutation(ref("images:dropHolder"), { image: "linux", machineId: "m1" }), code("invalid_input"));
  for (const name of ["linux", "macos"]) {
    await assert.rejects(() => reserve(agent, { name }), code("invalid_input"), `reserve ${name}`);
    await assert.rejects(() => agent.mutation(ref("images:rename"), { image: image.image_id, name }), code("invalid_input"), `rename to ${name}`);
  }
});

test("macos resolves to the most recent IPSW-built image, and says how to build one when there is none", async () => {
  const { agent } = await setup();
  await assert.rejects(() => agent.mutation(ref("images:rename"), { image: "macos", name: "mac-base" }), (error: any) => error.data?.code === "image_not_found" && /localbox image create --macos/.test(error.data.message));
  await reserve(agent, { name: "old-base", os: "macos", source: { kind: "ipsw", ipswVersion: "27.0" }, minMacOS: "27.0" });
  await new Promise((done) => setTimeout(done, 2));
  const newest = await reserve(agent, { name: "new-base", os: "macos", source: { kind: "ipsw", ipswVersion: "27.0.1" }, minMacOS: "27.0" });
  assert.deepEqual(await agent.mutation(ref("images:rename"), { image: "macos", name: "mac-base" }), { image_id: newest.image_id, name: "mac-base", previous_name: "new-base" });
});

test("deleting the default resets it to linux and says so; deleting another image does not", async () => {
  const { t, agent } = await setup();
  const kept = await reserve(agent, { name: "kept-image" }); const chosen = await reserve(agent, { name: "rails-dev" });
  assert.deepEqual(await agent.mutation(ref("images:setDefault"), { image: "rails-dev" }), { image_id: chosen.image_id, name: "rails-dev" });
  assert.equal((await list(agent)).find((image) => image.default).name, "rails-dev");
  assert.equal((await agent.query(ref("accounts:status"), {}) as any).defaultImageId, chosen.image_id, "account status carries the default");
  const removedOther = await agent.mutation(ref("images:remove"), { image: kept.image_id }) as any;
  assert.equal(removedOther.default_reset_to, null);
  const removed = await agent.mutation(ref("images:remove"), { image: "rails-dev" }) as any;
  assert.deepEqual(removed, { image_id: chosen.image_id, name: "rails-dev", holders: ["m1"], default_reset_to: "linux" });
  assert.equal((await list(agent))[0].default, true);
  assert.deepEqual(await t.run(async (ctx) => await ctx.db.query("imageHolders").collect()), [], "its holders go with it");
});

test("removing or signing out a machine drops its holders; an image with none left stays listed", async () => {
  const { agent, m1, m2 } = await setup();
  const image = await reserve(agent, { name: "rails-dev" });
  await m2.mutation(ref("images:setHolder"), { imageId: image.image_id, state: "copying", operationId: "copy-1" });
  const holders = async () => (await list(agent)).find((row) => row.name === "rails-dev").holders.map((holder: any) => [holder.machine_name, holder.state]);
  assert.deepEqual((await holders()).sort(), [["attic", "copying"], ["studio", "building"]]);
  assert.deepEqual(await agent.mutation(ref("machines:remove"), { machineId: "m2" }), { machine_id: "m2", removed: true, sandboxes_removed: 0, image_holders_removed: 1 });
  assert.deepEqual(await holders(), [["studio", "building"]]);
  assert.deepEqual(await m1.mutation(ref("machines:revokeSelf"), {}), { revoked: true, sandboxes_removed: 0, image_holders_removed: 1 });
  const listed = await agent.query(ref("images:list"), {}) as any[];
  assert.deepEqual(listed.map((row) => [row.name, row.holders.length]), [["linux", 0], ["rails-dev", 0]]);
});

test("names are unique per account and generated when omitted; a replayed reserve returns the same image", async () => {
  const { t, agent } = await setup();
  await t.run(async (ctx) => { await ctx.db.insert("machines", { machineId: "o1", accountId: "a2", credentialHash: "o", name: "other", createdAt: 0, lastSeenAt: 0 }); });
  const first = await reserve(agent, { name: "rails-dev", createMutationId: "cli-same" });
  assert.deepEqual(await reserve(agent, { name: "rails-dev", createMutationId: "cli-same" }), first);
  await assert.rejects(() => reserve(agent, { name: "rails-dev" }), (error: any) => error.data?.code === "name_conflict" && /rails-dev/.test(error.data.message));
  const generated = await reserve(agent);
  assert.match(generated.name, /^[a-z]+-[a-z]+$/);
  assert.deepEqual(generated.holders.map((holder: any) => [holder.machine_name, holder.state]), [["studio", "building"]]);
  await assert.rejects(() => reserve(agent, { machineId: "o1" }), code("machine_not_found"), "another account's machine");
  const renamed = await reserve(agent, { name: "node-dev" });
  await assert.rejects(() => agent.mutation(ref("images:rename"), { image: renamed.image_id, name: "rails-dev" }), code("name_conflict"));
});

test("a ready holder report records the image's size; a machine reports only its own holding, on its own account", async () => {
  const { t, agent, m2 } = await setup();
  const image = await reserve(agent, { name: "rails-dev" });
  assert.equal(image.size_bytes, null, "no size until a holder is ready");
  await m2.mutation(ref("images:setHolder"), { imageId: image.image_id, state: "ready", sizeBytes: 8 * 1024 ** 3 });
  const listed = (await list(agent)).find((row) => row.name === "rails-dev");
  assert.equal(listed.size_bytes, 8 * 1024 ** 3);
  assert.deepEqual(listed.holders.map((holder: any) => holder.machine_id).sort(), ["m1", "m2"]);
  await t.run(async (ctx) => { await ctx.db.insert("machines", { machineId: "o1", accountId: "a2", credentialHash: "o", name: "other", createdAt: 0, lastSeenAt: 0 }); });
  await assert.rejects(() => t.withIdentity({ subject: "machine:o1", account: "a2" }).mutation(ref("images:setHolder"), { imageId: image.image_id, state: "ready" }), code("image_not_found"));
  assert.deepEqual(await agent.mutation(ref("images:dropHolder"), { image: "rails-dev", machineId: "m2" }), { image_id: image.image_id, name: "rails-dev", machine_id: "m2", dropped: true });
});

test("a macOS base's ready report records the oldest macOS that runs it and its IPSW's version, which placement and image list read", async () => {
  const { agent, m1 } = await setup();
  const image = await reserve(agent, { os: "macos", source: { kind: "ipsw" } });
  assert.equal(image.min_macos, null, "unknown until the build finishes");
  await m1.mutation(ref("images:setHolder"), { imageId: image.image_id, state: "ready", sizeBytes: 31 * 1024 ** 3, minMacOS: "27.0", ipswVersion: "27.2.1" });
  const built = await agent.query(ref("images:get"), { image: "macos" }) as any;
  assert.deepEqual([built.image_id, built.min_macos, built.source, built.size_bytes], [image.image_id, "27.0", { kind: "ipsw", ipswVersion: "27.2.1" }, 31 * 1024 ** 3]);
  const captured = await reserve(agent, { name: "rails-dev" });
  await m1.mutation(ref("images:setHolder"), { imageId: captured.image_id, state: "ready", ipswVersion: "27.2.1" });
  assert.deepEqual((await agent.query(ref("images:get"), { image: "rails-dev" }) as any).source, fromSandbox, "only an IPSW-built image has an IPSW version");
});

test("get resolves one image as list shows it; a failed holding carries why and a later report clears it", async () => {
  const { agent, m1 } = await setup();
  assert.deepEqual((await agent.query(ref("images:get"), { image: "linux" }) as any).holders.map((holder: any) => holder.machine_name), ["studio", "attic"]);
  const image = await reserve(agent, { name: "rails-dev", createMutationId: "cli-get" });
  const got = await agent.query(ref("images:get"), { image: "rails-dev" }) as any;
  assert.deepEqual(got, (await list(agent)).find((row) => row.name === "rails-dev"));
  assert.deepEqual(got.holders.map((holder: any) => [holder.machine_id, holder.state, holder.operation_id]), [["m1", "building", "cli-get"]]);
  await assert.rejects(() => agent.query(ref("images:get"), { image: "nope" }), code("image_not_found"));
  const failure = { code: "disk_full", message: "studio has 2 GiB free", nextStep: "free some disk on studio and create it again" };
  await assert.rejects(() => m1.mutation(ref("images:setHolder"), { imageId: image.image_id, state: "failed" }), code("invalid_input"), "a failure says why");
  await assert.rejects(() => m1.mutation(ref("images:setHolder"), { imageId: image.image_id, state: "ready", error: failure }), code("invalid_input"));
  await m1.mutation(ref("images:setHolder"), { imageId: image.image_id, state: "failed", operationId: "cli-get", error: failure });
  const failed = (await agent.query(ref("images:get"), { image: image.image_id }) as any).holders[0];
  assert.deepEqual([failed.state, failed.error], ["failed", { code: "disk_full", message: "studio has 2 GiB free", next_step: "free some disk on studio and create it again" }]);
  await m1.mutation(ref("images:setHolder"), { imageId: image.image_id, state: "ready", operationId: "cli-get-2" });
  assert.equal((await agent.query(ref("images:get"), { image: image.image_id }) as any).holders[0].error, null);
});

test("a machine's mirror lists only the images held on it, with each holding's state", async () => {
  const { agent, m1, m2 } = await setup();
  const one = await reserve(agent, { name: "rails-dev" }); const two = await reserve(agent, { name: "node-dev", machineId: "m2" });
  await m1.mutation(ref("images:setHolder"), { imageId: two.image_id, state: "copying" });
  assert.deepEqual(await m1.query(ref("images:forMachine"), {}), [{ image_id: one.image_id, state: "building" }, { image_id: two.image_id, state: "copying" }].sort((a, b) => a.image_id.localeCompare(b.image_id)));
  assert.deepEqual(await m2.query(ref("images:forMachine"), {}), [{ image_id: two.image_id, state: "building" }]);
  await assert.rejects(() => agent.query(ref("images:forMachine"), {}), code("unauthorized"));
});

test("a machine's mirror lists every holding, past any batch size, since a missing one would read as deleted", async () => {
  const { t, m1 } = await setup();
  await t.run(async (ctx) => {
    for (let index = 0; index < 201; index++) {
      const imageId = `image_${String(index).padStart(3, "0")}`;
      await ctx.db.insert("images", { imageId, accountId: "a1", name: `image-${index}`, os: "linux", source: fromSandbox, createdAt: index, createMutationId: `m-${index}` });
      await ctx.db.insert("imageHolders", { imageId, accountId: "a1", machineId: "m1", state: "ready", updatedAt: index });
    }
  });
  const listed = await m1.query(ref("images:forMachine"), {}) as any[];
  assert.equal(listed.length, 201);
  assert.equal(listed.at(-1).image_id, "image_200");
});

test("an image resolves by its id, else its name in any case, like machines and sandboxes", async () => {
  const { agent } = await setup();
  const image = await reserve(agent, { name: "rails-dev" });
  assert.equal((await agent.query(ref("images:get"), { image: "Rails-Dev" }) as any).image_id, image.image_id);
  assert.equal((await agent.query(ref("images:get"), { image: image.image_id }) as any).name, "rails-dev");
  assert.equal((await agent.query(ref("images:get"), { image: "LINUX" }) as any).image_id, "linux");
  await assert.rejects(() => agent.query(ref("images:get"), { image: image.image_id.toUpperCase() }), code("image_not_found"));
});

test("admin:wipe clears the image tables", async () => {
  const { t, agent } = await setup();
  await reserve(agent, { name: "rails-dev" });
  await t.mutation(ref("admin:wipe"), {});
  assert.deepEqual(await t.run(async (ctx) => [await ctx.db.query("images").collect(), await ctx.db.query("imageHolders").collect()]), [[], []]);
});
