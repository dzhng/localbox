import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../packages/state/src/index.js";
import { runOps } from "../apps/relay/src/ops.js";
import { render } from "../apps/cli/src/render.js";
import { failure, success, type Json, type RequestEnvelope, type ResponseEnvelope } from "../packages/contract/src/index.js";
import { memoryMailbox } from "./fixtures/memory-mailbox.js";

const ref = (name: string) => makeFunctionReference(name) as any;
const GIB = 1024 ** 3;
const machines = [{ machineId: "m1", name: "studio" }, { machineId: "m2", name: "attic" }];
type Machine = (request: RequestEnvelope) => Promise<ResponseEnvelope | undefined>;

/**
 * Account a1 with machines studio (m1) and attic (m2) and sandbox bold-otter on attic, its catalog answered by the real
 * Convex functions and its relayed requests by `connectors`. `op` runs one agent API call as studio.
 */
async function setup(connectors: Record<string, Machine> = {}) {
  const t = createConvexTestHarness();
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("accounts", { accountId: "a1", email: "a@example.com", name: "brave-walrus-100", createdAt: now });
    for (const { machineId, name } of machines) await ctx.db.insert("machines", { machineId, accountId: "a1", credentialHash: `h-${machineId}`, name, createdAt: now, lastSeenAt: now });
    await ctx.db.insert("sandboxes", { sandboxId: "sandbox_otter", accountId: "a1", machineId: "m2", name: "bold-otter", imageId: "linux", os: "linux", cpus: 2, memoryBytes: 2 * GIB, sleepAfterMs: 1_800_000, createdAt: now });
  });
  const studio = t.withIdentity({ subject: "machine:m1", account: "a1" });
  const { deps } = memoryMailbox({ machines, connectors });
  deps.accountCall = async (_principal, kind, name, args) => await (studio as any)[kind](ref(name), args);
  let calls = 0;
  const op = async (input: Record<string, unknown>, mutationId = `mut-${++calls}`): Promise<any> => {
    const result = await runOps({ accountId: "a1", machineId: "m1" }, { operation: "image.create", input, request_id: `req-${++calls}`, mutation_id: mutationId }, deps);
    return (result.body as { response: ResponseEnvelope }).response;
  };
  const images = async () => (await studio.query(ref("images:list"), {}) as any[]).filter((row) => row.image_id !== "linux");
  return { op, images };
}

/** A machine whose capture finished with `result`, recording each request it was told. */
const capturing = (told: RequestEnvelope[], result: Json, state: "succeeded" | "running" = "succeeded"): Machine => async (request) => {
  told.push(request);
  const input = request.input as { image: string };
  return success(request, { key: request.mutation_id, kind: "image.capture", subject: input.image, state, ...(state === "succeeded" ? { result } : { progress: { phase: "saving" } }), started_at: 1, updated_at: 2 });
};

test("image create --from routes to the source sandbox's machine, reserves the image there, and reports in the map's four lines", async () => {
  const told: RequestEnvelope[] = [];
  const { op, images } = await setup({ m2: capturing(told, { size_bytes: 1.5 * GIB, stall_ms: 840 }) });
  const created = await op({ from: "bold-otter", name: "rails-dev" }, "cli-create-1");
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(told.length, 1, "attic, where bold-otter lives, was told; studio, the caller, was not");
  assert.deepEqual(told[0].input, { from: "sandbox_otter", image: created.result.image });
  assert.equal(told[0].mutation_id, "cli-create-1", "the machine journals the capture under the create's mutation id");
  assert.equal(created.result.state, "ready");
  assert.deepEqual(created.result.report, [
    "image rails-dev saved from sandbox bold-otter (linux, 1.5 GiB)",
    "bold-otter froze for 0.8 s while its disk was saved, and is running again",
    "on machine attic; copies to other Macs on first use",
    "start a sandbox from it: localbox sandbox create --image rails-dev",
  ]);
  const [row] = await images();
  assert.deepEqual([row.name, row.os, row.source], ["rails-dev", "linux", { kind: "sandbox", sandboxName: "bold-otter" }]);
  assert.deepEqual(row.holders.map((holder: any) => [holder.machine_name, holder.state, holder.operation_id]), [["attic", "building", "cli-create-1"]], "ready once attic's connector reports the outcome");

  const text = render(created, { json: false });
  assert.equal(text.stdout, `${created.result.report.join("\n")}\n`, "the CLI prints the report lines as they are");
});

test("a replay reserves nothing new and returns the same operation", async () => {
  const told: RequestEnvelope[] = [];
  const { op, images } = await setup({ m2: capturing(told, { size_bytes: GIB, stall_ms: 500 }) });
  const first = await op({ from: "bold-otter" }, "cli-create-2");
  const replay = await op({ from: "bold-otter" }, "cli-create-2");
  assert.equal(replay.result.image, first.result.image);
  assert.equal(replay.result.name, first.result.name, "the generated name too");
  assert.equal(told.length, 1, "the relay's dedupe answers the replay with the first answer");
  assert.equal((await images()).length, 1);
});

test("a sleeping source says it woke, and one slept for room is named; a stopped one says it was saved without a freeze", async () => {
  const woke = await setup({ m2: capturing([], { size_bytes: 300 * 1024 ** 2, stall_ms: 1_210, woke: "restored bold-otter from its saved state", made_room: ["slept quiet-fox (2 GiB) to make room"] }) });
  assert.deepEqual((await woke.op({ from: "bold-otter", name: "woken" })).result.report.slice(0, 3), [
    "image woken saved from sandbox bold-otter (linux, 300 MiB)",
    "bold-otter woke from sleep, then froze for 1.2 s while its disk was saved, and is running again",
    "made room for it: slept quiet-fox (2 GiB) to make room",
  ]);
  const stopped = await setup({ m2: capturing([], { size_bytes: GIB, stall_ms: null }) });
  assert.equal((await stopped.op({ from: "bold-otter", name: "cold" })).result.report[1], "bold-otter was stopped, so its disk was saved as it lay, without a freeze");
});

test("a capture still running answers building with its phase; the client follows it with image.wait", async () => {
  const { op } = await setup({ m2: capturing([], null, "running") });
  const created = await op({ from: "bold-otter", name: "slow" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.result.state, "building");
  assert.equal(created.result.progress.phase, "saving");
  assert.equal(created.result.report, undefined);
});

test("a machine that refused or never got the capture releases the reservation; an uncertain one keeps it and says so", async () => {
  const refusing: Machine = async (request) => failure(request, { code: "sandbox_not_found", message: "no sandbox sandbox_otter on this machine", retryable: false });
  const refused = await setup({ m2: refusing });
  assert.equal((await refused.op({ from: "bold-otter", name: "gone" })).error.code, "sandbox_not_found");
  assert.equal((await refused.images()).length, 0);

  const offline = await setup();
  assert.equal((await offline.op({ from: "bold-otter", name: "offline" })).error.code, "machine_offline");
  assert.equal((await offline.images()).length, 0, "attic never claimed it, so nothing was saved");

  const uncertain = await setup({ m2: async (request) => failure(request, { code: "internal", message: "the daemon lost track", retryable: false }) });
  const kept = await uncertain.op({ from: "bold-otter", name: "maybe" }, "cli-create-3");
  assert.match(kept.error.message, /the save may still complete on attic: image maybe stays reserved \(replay with mutation id cli-create-3 to get its result\)$/);
  assert.equal((await uncertain.images()).length, 1);
});

test("image create refuses what it can't do before reserving anything", async () => {
  const { op, images } = await setup({ m2: capturing([], { size_bytes: GIB, stall_ms: 1 }) });
  assert.equal((await op({ from: "bold-otter", image: "image_mine" })).error.code, "invalid_input", "image is the agent API's own");
  assert.equal((await op({ from: "nope" })).error.code, "sandbox_not_found");
  assert.equal((await op({ from: "bold-otter", macos: true })).error.code, "invalid_input", "exactly one of from and macos");
  assert.equal((await images()).length, 0);
});
