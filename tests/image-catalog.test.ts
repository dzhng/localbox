import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../packages/state/src/index.js";
import { runOps, type Principal } from "../apps/relay/src/ops.js";
import { success, type RequestEnvelope, type ResponseEnvelope } from "../packages/contract/src/index.js";
import { memoryMailbox } from "./fixtures/memory-mailbox.js";

const ref = (name: string) => makeFunctionReference(name) as any;
const GIB = 1024 ** 3;
const machines = [{ machineId: "m1", name: "studio" }, { machineId: "m2", name: "attic" }];

/**
 * Account a1 with machines m1 ("studio") and m2 ("attic"), its image calls answered by the real Convex functions and
 * its relayed requests by `connectors` (a machine with none is offline). `op` runs one agent API call as studio.
 */
async function setup(connectors: Record<string, (request: RequestEnvelope) => Promise<ResponseEnvelope | undefined>> = {}) {
  const t = createConvexTestHarness();
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("accounts", { accountId: "a1", email: "a@example.com", name: "brave-walrus-100", createdAt: now });
    for (const { machineId, name } of machines) await ctx.db.insert("machines", { machineId, accountId: "a1", credentialHash: `h-${machineId}`, name, createdAt: now, lastSeenAt: now });
  });
  const as = (principal: Principal) => t.withIdentity({ subject: `machine:${principal.machineId}`, account: principal.accountId });
  const { deps } = memoryMailbox({ machines, connectors });
  deps.accountCall = async (principal, kind, name, args) => await (as(principal) as any)[kind](ref(name), args);
  let calls = 0;
  const op = async (operation: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<any> => {
    const result = await runOps({ accountId: "a1", machineId: "m1" }, { operation, input, request_id: `req-${++calls}`, mutation_id: `mut-${calls}`, ...extra }, deps);
    return (result.body as { response: ResponseEnvelope }).response;
  };
  const m1 = as({ accountId: "a1", machineId: "m1" }); const m2 = as({ accountId: "a1", machineId: "m2" });
  /** An image built on m1 and copied to m2, both ready. */
  const image = async (name: string) => {
    const reserved = await m1.mutation(ref("images:reserve"), { machineId: "m1", name, os: "linux", source: { kind: "sandbox", sandboxName: "bold-otter" }, createMutationId: `cli-${name}` }) as any;
    await m1.mutation(ref("images:setHolder"), { imageId: reserved.image_id, state: "ready", sizeBytes: 4 * GIB });
    await m2.mutation(ref("images:setHolder"), { imageId: reserved.image_id, state: "ready" });
    return reserved.image_id as string;
  };
  return { t, op, image, m2 };
}

/** A machine that removes whatever image it is told to, recording each request. */
const holder = (told: RequestEnvelope[]) => async (request: RequestEnvelope) => { told.push(request); return success(request, { image: (request.input as { image: string }).image, removed: true }); };

test("image list shows the whole account: linux on every Mac and default, then each image with size, source and holders", async () => {
  const { op, image, m2 } = await setup();
  const id = await image("rails-dev");
  await m2.mutation(ref("images:setHolder"), { imageId: id, state: "copying", operationId: "copy-1" });
  const listed = await op("image.list", {});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.result.images, [
    { name: "linux", os: "linux", size_bytes: null, from: "release", on: ["every Mac"], default: true },
    { name: "rails-dev", os: "linux", size_bytes: 4 * GIB, from: "sandbox bold-otter", on: ["studio", "attic (copying)"], default: false },
  ]);
});

test("image rename follows the catalog's rules: linux is refused, taken names conflict, and the report names both", async () => {
  const { op, image } = await setup();
  await image("rails-dev"); await image("node-dev");
  assert.equal((await op("image.rename", { image: "linux", name: "my-linux" })).error.code, "invalid_input");
  assert.equal((await op("image.rename", { image: "rails-dev", name: "node-dev" })).error.code, "name_conflict");
  assert.equal((await op("image.rename", { image: "rails-dev", name: "macos" })).error.code, "invalid_input");
  const renamed = await op("image.rename", { image: "rails-dev", name: "rails-app" });
  assert.deepEqual(renamed.result.produced, { image_id: renamed.result.produced.image_id, name: "rails-app", previous_name: "rails-dev" });
  assert.match(renamed.result.actions[0].detail, /renamed image rails-dev to rails-app/);
  assert.equal((await op("image.rename", { image: "nope", name: "other" })).error.code, "image_not_found");
});

test("image default reports the image it replaced; linux clears it", async () => {
  const { op, image } = await setup();
  await image("rails-dev");
  const made = await op("image.default", { image: "rails-dev" });
  assert.deepEqual([made.result.actions[0].kind, made.result.produced.previous_default], ["made_default", "linux"]);
  assert.match(made.result.actions[0].detail, /rails-dev is now the default image \(was linux\)/);
  assert.equal((await op("image.default", { image: "rails-dev" })).result.actions[0].kind, "left_alone");
  const back = await op("image.default", { image: "linux" });
  assert.deepEqual([back.result.produced.name, back.result.produced.previous_default], ["linux", "rails-dev"]);
  assert.equal((await op("image.list", {})).result.images[0].default, true);
});

test("image delete drops the catalog row first, tells every holder, and says the default reset to linux and sandboxes are unaffected", async () => {
  const told: RequestEnvelope[] = [];
  const { t, op, image } = await setup({ m1: holder(told), m2: holder(told) });
  const id = await image("rails-dev");
  await op("image.default", { image: "rails-dev" });
  assert.equal((await op("image.delete", { image: "rails-dev", confirm: "rails-app" })).error.code, "invalid_input", "confirm must be its name");
  assert.equal((await op("image.delete", { image: "linux" })).error.code, "invalid_input");
  const deleted = await op("image.delete", { image: "rails-dev", confirm: "rails-dev" });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.deepEqual(deleted.result.produced, { image_id: id, name: "rails-dev", removed: ["account catalog entry", "files on studio", "files on attic"], default_reset_to: "linux" });
  assert.match(deleted.result.actions[0].detail, /the default is now linux/);
  assert.match(deleted.result.actions[0].detail, /sandboxes made from rails-dev are unaffected/);
  assert.deepEqual(told.map((request) => [request.operation, request.input]), [["image.delete", { image: id }], ["image.delete", { image: id }]]);
  assert.deepEqual(await t.run(async (ctx) => [await ctx.db.query("images").collect(), await ctx.db.query("imageHolders").collect()]), [[], []]);
  assert.equal((await op("image.list", {})).result.images[0].default, true);
  const replay = await op("image.delete", { image: "rails-dev", confirm: "rails-dev" });
  assert.equal(replay.result.actions[0].kind, "left_alone", "a replay finds it already deleted");
});

test("an offline holder deletes later; --machine drops only that Mac's holding and files", async () => {
  const told: RequestEnvelope[] = [];
  const { op, image } = await setup({ m1: holder(told) });
  await image("rails-dev");
  const deleted = await op("image.delete", { image: "rails-dev" });
  assert.deepEqual(deleted.result.produced.removed, ["account catalog entry", "files on studio"]);
  assert.match(deleted.result.actions[0].detail, /attic did not answer and removes its files when it reconnects/);

  const id = await image("node-dev"); told.length = 0;
  const fromOne = await op("image.delete", { image: "node-dev" }, { machine: "studio" });
  assert.equal(fromOne.ok, true, JSON.stringify(fromOne));
  assert.deepEqual([fromOne.result.produced.machine, fromOne.result.produced.removed, fromOne.result.produced.default_reset_to], ["studio", ["files on studio"], null]);
  assert.match(fromOne.result.actions[0].detail, /the image stays on the account, on attic/);
  assert.deepEqual(told.map((request) => request.input), [{ image: id }]);
  assert.deepEqual((await op("image.list", {})).result.images.find((row: any) => row.name === "node-dev").on, ["attic"]);
});
