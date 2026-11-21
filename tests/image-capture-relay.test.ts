import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "../apps/cli/src/render.js";
import { HOST_OPERATION_KINDS, failure, type Json, type RequestEnvelope } from "../packages/contract/src/index.js";
import { runOps } from "../apps/relay/src/ops.js";
import { GIB, hostRecord, relayOverConvex, STUDIO, type Machine } from "./fixtures/relay-over-convex.js";

const machines = [{ machineId: "m1", name: "studio" }, { machineId: "m2", name: "attic" }];

/**
 * Account a1 with machines studio (m1) and attic (m2) and sandbox bold-otter on attic, its catalog answered by the real
 * Convex functions and its relayed requests by `connectors`. `op` runs `image create` as studio.
 */
async function setup(connectors: Record<string, Machine> = {}) {
  const { op: run, images, deps } = await relayOverConvex({ machines, sandboxes: [{ sandboxId: "sandbox_otter", machineId: "m2", name: "bold-otter" }, { sandboxId: "sandbox_mac", machineId: "m2", name: "mac-box", os: "macos", minMacOS: "27.0" }], connectors });
  const op = async (input: Record<string, unknown>, mutationId?: string, deadlineMs?: number) => await run("image.create", { input, ...(mutationId ? { mutation_id: mutationId } : {}), ...(deadlineMs ? { deadline_ms: deadlineMs } : {}) });
  return { op, images, deps };
}

/** A machine whose capture finished with `result`, recording each request it was told. */
const capturing = (told: RequestEnvelope[], result: Json, state: "succeeded" | "running" = "succeeded"): Machine => async (request) => {
  told.push(request);
  return hostRecord(request, { kind: HOST_OPERATION_KINDS.capture, state, ...(state === "succeeded" ? { result } : { progress: { phase: "saving" } }) });
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

test("a capture the machine refused, failed or never got releases the reservation; a lost answer keeps it and says so", async () => {
  const refused = await setup({ m2: async (request) => failure(request, { code: "sandbox_not_found", message: "no sandbox sandbox_otter on this machine", retryable: false }) });
  assert.equal((await refused.op({ from: "bold-otter", name: "gone" })).error.code, "sandbox_not_found");
  assert.equal((await refused.images()).length, 0);

  const failed = await setup({ m2: async (request) => failure(request, { code: "internal", message: "the daemon lost track", retryable: false }) });
  assert.equal((await failed.op({ from: "bold-otter", name: "broken" })).error.message, "the daemon lost track");
  assert.equal((await failed.images()).length, 0, "the relay keeps that answer for the mutation id, so a replay could never finish it");

  const offline = await setup();
  assert.equal((await offline.op({ from: "bold-otter", name: "offline" })).error.code, "machine_offline");
  assert.equal((await offline.images()).length, 0, "attic never claimed it, so nothing was saved");

  const lost = await setup({ m2: async () => undefined });
  const kept = await lost.op({ from: "bold-otter", name: "maybe" }, "cli-create-3", 100);
  assert.equal(kept.error.code, "operation_uncertain");
  assert.match(kept.error.message, /the save may still complete on attic: image maybe stays reserved \(replay with mutation id cli-create-3 to get its result\)$/);
  assert.equal((await lost.images()).length, 1);
});

test("a capture answered after the first call's wait is finished on the continuation as the first call would have", async () => {
  const gate = () => { let open!: () => void; const opened = new Promise<void>((resolve) => { open = resolve; }); return { open: () => open(), opened }; };
  const saved = gate(); const refused = gate();
  const { images, deps } = await setup({ m2: async (request) => {
    const name = (request.input as { image: string }).image;
    const row = (await images()).find((image) => image.image_id === name);
    if (row.name === "late") { await saved.opened; return hostRecord(request, { kind: HOST_OPERATION_KINDS.capture, state: "succeeded", result: { size_bytes: GIB, stall_ms: 400 } }); }
    await refused.opened; return failure(request, { code: "sandbox_not_found", message: "no sandbox sandbox_otter on this machine", retryable: false });
  } });
  deps.maxWaitMs = 50;
  const started = async (name: string, mutationId: string) => (await runOps(STUDIO, { operation: "image.create", mutation_id: mutationId, input: { from: "bold-otter", name } }, deps)).body as { status: string; request_id: string; deadline_at: number };
  const resume = async (pending: { request_id: string; deadline_at: number }) => ((await runOps(STUDIO, { continue: pending.request_id, deadline_at: pending.deadline_at }, deps)).body as any).response;

  const late = await started("late", "cli-late-1");
  assert.equal(late.status, "pending");
  saved.open();
  const done = await resume(late);
  assert.deepEqual([done.ok, done.result.state, done.result.report[0]], [true, "ready", "image late saved from sandbox bold-otter (linux, 1 GiB)"], "the continuation reads as an operation state with its report");

  const gone = await started("gone", "cli-late-2");
  assert.equal(gone.status, "pending");
  refused.open();
  assert.equal((await resume(gone)).error.code, "sandbox_not_found");
  assert.deepEqual((await images()).map((image) => image.name), ["late"], "the refused capture's reservation was released on the continuation");
});

test("a saved macOS sandbox makes a macOS image that needs what its source needed", async () => {
  const { op, images } = await setup({ m2: capturing([], { size_bytes: 30 * GIB, stall_ms: 900 }) });
  const created = await op({ from: "mac-box", name: "mac-dev" });
  assert.equal(created.result.os, "macos");
  const [row] = await images();
  assert.deepEqual([row.os, row.min_macos], ["macos", "27.0"]);
});

test("image create refuses what it can't do before reserving anything", async () => {
  const { op, images } = await setup({ m2: capturing([], { size_bytes: GIB, stall_ms: 1 }) });
  assert.equal((await op({ from: "bold-otter", image: "image_mine" })).error.code, "invalid_input", "image is the agent API's own");
  assert.equal((await op({ from: "nope" })).error.code, "sandbox_not_found");
  assert.equal((await op({ from: "bold-otter", macos: true })).error.code, "invalid_input", "exactly one of from and macos");
  assert.equal((await images()).length, 0);
});
