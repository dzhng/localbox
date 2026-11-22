import assert from "node:assert/strict";
import { test } from "node:test";
import { durationText } from "../apps/relay/src/image-state.js";
import { render } from "../apps/cli/src/render.js";
import { HOST_OPERATION_KINDS, type Json, type RequestEnvelope } from "../packages/contract/src/index.js";
import { GIB, hostRecord, ref, relayOverConvex, STUDIO, type Machine } from "./fixtures/relay-over-convex.js";

const capacity = (freeDisk: number | null) => ({ cpus: 8, total_bytes: 16 * GIB, reserved_bytes: 0, room_bytes: 12 * GIB, running: 0, revision: 1, free_disk_bytes: freeDisk, macos_version: "27.0.1" });

/**
 * Account a1 with studio (m1, holds rails-dev ready), attic (m2, 100 GiB free), den (m3, never reported) and loft (m4,
 * free disk unread), the catalog answered by the real Convex functions and each machine's relayed requests by
 * `connectors`. `copy` runs `image copy` as studio.
 */
async function setup(connectors: Record<string, Machine>) {
  const machines = [{ machineId: "m1", name: "studio", capacity: capacity(100 * GIB) }, { machineId: "m2", name: "attic", capacity: capacity(100 * GIB) }, { machineId: "m3", name: "den" }, { machineId: "m4", name: "loft", capacity: capacity(null) }];
  const { op, as, readyImage } = await relayOverConvex({ machines, connectors });
  const studio = as(STUDIO); const attic = as({ accountId: "a1", machineId: "m2" });
  const image = await readyImage("rails-dev", ["m1"], 3 * GIB);
  const copy = async (input: Record<string, unknown>, mutationId: string): Promise<any> => await op("image.copy", { input, mutation_id: mutationId });
  const holders = async () => ((await studio.query(ref("images:get"), { image: "rails-dev" })) as any).holders.map((holder: any) => [holder.machine_name, holder.state]).sort();
  return { copy, holders, image, attic, studio };
}

/** A machine that took its side of the copy, recording what it was told; it answers with its record, `record` merged in. */
const side = (told: RequestEnvelope[], record: Record<string, Json> = {}): Machine => async (request) => {
  told.push(request);
  return hostRecord(request, { kind: HOST_OPERATION_KINDS.copy, state: "running", progress: { phase: "waiting_for_peer" }, ...record });
};

test("image copy tells both Macs under the copy's mutation id and answers copying at once; once copied, it reports size, duration and path", async () => {
  const toldFrom: RequestEnvelope[] = []; const toldTo: RequestEnvelope[] = [];
  const { copy, holders, image, attic } = await setup({ m1: side(toldFrom), m2: side(toldTo) });
  const started = await copy({ image: "rails-dev", to: "ATTIC" }, "cli-copy-1");
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.deepEqual([started.result.state, started.result.name, started.result.progress.phase], ["copying", "rails-dev", "waiting_for_peer"]);
  for (const told of [toldFrom, toldTo]) {
    assert.equal(told.length, 1);
    assert.deepEqual([told[0].mutation_id, told[0].input], ["cli-copy-1", { image: image.image_id, to: "m2" }], "each Mac journals its side under the copy's mutation id; --to resolved to attic's id");
  }
  assert.deepEqual(await holders(), [["attic", "copying"], ["studio", "ready"]]);

  // attic's connector reports the finished copy; a replay then answers with the result.
  await attic.mutation(ref("images:endCopy"), { operationId: "cli-copy-1", state: "succeeded", sizeBytes: 3 * GIB, result: { bytes: 3 * GIB, durationMs: 42_000, path: "local_network" } });
  const replay = await copy({ image: "rails-dev", to: "attic" }, "cli-copy-1");
  assert.equal(replay.result.state, "ready");
  assert.deepEqual(replay.result.report, ["copied image rails-dev from studio to attic (3 GiB, 42 s, local network)", "start a sandbox from it there: localbox sandbox create --image rails-dev --machine attic"]);
  assert.equal(toldTo.length, 1, "the relay's dedupe answered the replay; nothing new reached the machines");
  assert.equal(render(replay, { json: false }).stdout, `${replay.result.report.join("\n")}\n`);
  assert.deepEqual(await holders(), [["attic", "ready"], ["studio", "ready"]]);

  const again = await copy({ image: "rails-dev", to: "attic" }, "cli-copy-2");
  assert.deepEqual([again.result.state, again.result.report], ["ready", ["image rails-dev is already on attic; nothing to copy"]]);
});

test("a copy that couldn't connect fails with copy_unreachable, each path tried and the next step", async () => {
  const error = { code: "copy_unreachable", message: "no direct path between the two Macs; tried local network 10.0.0.1:50000 (timed out), internet 203.0.113.9:61000 (no reply to the punch)", next_step: "put both Macs on the same network once, then copy" };
  const { copy } = await setup({ m1: side([]), m2: side([], { state: "failed", error }) });
  const failed = await copy({ image: "rails-dev", to: "attic" }, "cli-copy-3");
  assert.equal(failed.result.state, "failed");
  assert.deepEqual(failed.result.error, { code: "copy_unreachable", message: `copying rails-dev from studio to attic failed: ${error.message}`, next_step: error.next_step });
});

test("--to resolves like --machine: unknown, offline, unread disk and linux refuse before any copy starts", async () => {
  const { copy, holders } = await setup({});
  let n = 0;
  const refused = async (input: Record<string, unknown>) => (await copy(input, `cli-refused-${++n}`)).error;
  assert.match((await refused({ image: "rails-dev", to: "garage" })).message, /^no machine garage on this account; machines: /);
  assert.equal((await refused({ image: "rails-dev", to: "den" })).code, "machine_offline");
  const disk = await refused({ image: "rails-dev", to: "loft" });
  assert.deepEqual([disk.code, disk.message], ["disk_full", "loft has not reported its free disk, and copying rails-dev there needs 4 GiB"]);
  assert.equal((await refused({ image: "linux", to: "attic" })).code, "invalid_input");
  assert.equal((await refused({ image: "nope", to: "attic" })).code, "image_not_found");
  assert.deepEqual(await holders(), [["studio", "ready"]], "nothing was reserved");
});

test("a Mac that never takes its side cancels the copy: the answer says nothing was copied, and the target's holding goes", async () => {
  const { copy, holders, studio } = await setup({ m1: side([]) });
  const offline = await copy({ image: "rails-dev", to: "attic" }, "cli-copy-4");
  assert.equal(offline.ok, false);
  assert.equal(offline.error.code, "machine_offline");
  assert.match(offline.error.message, /^attic did not start its side of the copy, so nothing was copied: /);
  assert.deepEqual(await holders(), [["studio", "ready"]]);
  const row = await studio.query(ref("images:copyByOperation"), { operationId: "cli-copy-4" }) as any;
  assert.deepEqual([row.state, row.error.next_step], ["failed", "start attic's connector (or sign it in), then copy again"], "the sender's subscription hears the copy failed");
});

test("durations read in the largest sensible units", () => {
  assert.deepEqual([durationText(9_540), durationText(185_000), durationText(3_720_000)], ["9.5 s", "3 min 5 s", "1 h 2 min"]);
});
