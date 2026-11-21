import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { machineAccess } from "../lib/machine-access.js";
import { startConnector, stopConnector } from "../lib/login.js";
import { cli, signedInWithSandboxes, waitConnected } from "../lib/sandboxes.js";

export const id = "26";
export const tiers = ["s", "l"];

const convexEnv = { CONVEX_AGENT_MODE: "anonymous" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const STEPS = 60;
const STEP_MS = 500;

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "s") {
    return [await ctx.check("HostOperationStoreTests and ImageHostTests: resume after restart, replay returns the same record, bounded wait, kinds off the SandboxHost actor, outcomes reported once", async () => {
      const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "HostOperationStoreTests|ImageHostTests"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-3000));
      assert.match(result.stdout + result.stderr, /Executed \d+ tests, with 0 failures/);
    })];
  }
  const up = await ctx.stack("up", ["a", "b"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const run = Date.now(); const connectors: Record<string, ChildProcess | undefined> = {};
  const name = `proof-image-${String(run).slice(-6)}`; const mutation = `p26-build-${run}`;
  const evidence: Record<string, unknown> = {};
  const wait = async (timeoutMs: number, extra: string[] = []) => (await cli(ctx.root, "a", ["image", "wait", name, "--timeout-ms", String(timeoutMs), "--json", ...extra])).envelope;
  const rows = async (): Promise<any[]> => {
    const data = await ctx.exec("npx", ["convex", "data", "requests", "--format", "jsonLines", "--limit", "1000"], { env: convexEnv });
    assert.equal(data.code, 0, data.stderr);
    return data.stdout.trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  };
  try {
    const checks: Check[] = [];
    let b!: Awaited<ReturnType<typeof machineAccess>>; let imageId = "";
    const journal = () => JSON.parse(readFileSync(join(b.paths.operations, `${mutation}.json`), "utf8"));
    checks.push(await ctx.check("A and B sign in; B reserves an image and its daemon starts a long operation on it (sleep_steps, the fixture kind)", async () => {
      const setup = await signedInWithSandboxes(ctx.root, ["a", "b"], `proof-26-${run}@example.com`, { create: false });
      Object.assign(connectors, setup.connectors);
      b = await machineAccess(ctx.root, "b");
      const image = await b.mutation("images:reserve", { machineId: b.machineId, name, os: "linux", source: { kind: "sandbox", sandboxName: "proof" }, createMutationId: mutation });
      imageId = image.image_id;
      assert.deepEqual(image.holders.map((holder: any) => [holder.machine_id, holder.state, holder.operation_id]), [[b.machineId, "building", mutation]]);
      const begun = await b.daemon("host.begin_operation", { kind: "sleep_steps", key: mutation, subject: imageId, checkpoint: { done: 0, steps: STEPS, step_ms: STEP_MS } });
      assert.equal(begun.ok, true, JSON.stringify(begun));
      const replayed = await b.daemon("host.begin_operation", { kind: "sleep_steps", key: mutation, subject: imageId, checkpoint: { done: 0, steps: STEPS, step_ms: STEP_MS } });
      assert.equal(replayed.ok && (replayed.result as any).started_at, begun.ok && (begun.result as any).started_at, "the same key returns the record, never a second run");
    }));
    checks.push(await ctx.check("from A, image wait asks B and shows the operation building, with progress", async () => {
      await sleep(3 * STEP_MS);
      const state = await wait(1_000);
      assert.equal(state.ok, true, JSON.stringify(state));
      assert.equal(state.result.state, "building"); assert.equal(state.result.name, name); assert.equal(state.result.image, imageId);
      assert.ok(state.result.progress.done_bytes >= 1 && state.result.progress.total_bytes === STEPS, JSON.stringify(state.result));
      evidence.first_wait = state.result;
    }));
    checks.push(await ctx.check("B's daemon killed mid-operation (SIGKILL) and restarted: the operation continues from its last checkpoint, not from step 1", async () => {
      const before = journal().progress.completed;
      const restarted = await ctx.stack("restart", ["b"]);
      assert.equal(restarted.code, 0, restarted.stderr);
      const seen: number[] = [];
      for (let attempt = 0; attempt < 40 && (seen.at(-1) ?? 0) <= before; attempt++) { seen.push(journal().progress.completed); await sleep(100); }
      assert.ok(seen.every((done) => done >= before), `the journal never went back below ${before}: ${seen.join(",")}`);
      assert.ok(seen.at(-1)! > before, `it advanced past ${before} after the restart: ${seen.join(",")}`);
      assert.match(readFileSync(join(b.paths.logs, "hostd.log"), "utf8"), new RegExp(`operation ${mutation} resumed`));
      const state = await wait(1_000);
      assert.equal(state.result?.state, "building", JSON.stringify(state)); assert.ok(state.result.progress.done_bytes >= before);
      evidence.resumed_from = before; evidence.after_restart = seen;
    }));
    checks.push(await ctx.check("B's connector killed while it holds an image wait: the answer is lost, then a replay of that request returns the live state", async () => {
      const requestId = `p26-wait-${run}`;
      const pending = wait(4_000, ["--request-id", requestId]);
      for (let attempt = 0; attempt < 50; attempt++) { if ((await rows()).find((row) => row.requestId === requestId)?.status === "claimed") break; await sleep(100); }
      const before = journal().progress.completed;
      stopConnector(connectors.b, "SIGKILL");
      const lost = await pending;
      assert.equal(lost.error?.code, "operation_uncertain", JSON.stringify(lost));
      connectors.b = startConnector(ctx.root, "b"); await waitConnected(ctx.root, "b");
      const replay = await wait(4_000, ["--request-id", requestId]);
      assert.equal(replay.ok, true, JSON.stringify(replay));
      assert.ok(["building", "ready"].includes(replay.result.state), JSON.stringify(replay.result));
      if (replay.result.state === "building") assert.ok(replay.result.progress.done_bytes > before, `live progress past ${before}: ${JSON.stringify(replay.result)}`);
      evidence.replay = replay.result;
    }));
    checks.push(await ctx.check("when the operation finishes, B's connector reports the holder ready with its size, and image wait answers from the catalog without asking B", async () => {
      let holder: any;
      for (let attempt = 0; attempt < 2 * STEPS; attempt++) { holder = (await b.query("images:get", { image: imageId })).holders[0]; if (holder.state === "ready") break; await sleep(STEP_MS); }
      assert.equal(holder?.state, "ready", JSON.stringify(holder));
      assert.equal((await b.query("images:get", { image: imageId })).size_bytes, STEPS * 1_048_576);
      const asked = (await rows()).filter((row) => row.operation === "image.wait").length;
      const state = await wait(1_000);
      assert.deepEqual(state.result, { image: imageId, name, os: "linux", state: "ready" });
      assert.equal((await rows()).filter((row) => row.operation === "image.wait").length, asked, "no request went to B");
      assert.equal(journal().state, "succeeded"); assert.equal(typeof journal().reported_at, "number", "the daemon recorded the report");
    }));
    if (existsSync(ctx.evidence)) writeFileSync(join(ctx.evidence, "26-host-operations.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    return checks;
  } finally {
    for (const child of Object.values(connectors)) stopConnector(child);
    if (!ctx.keep) await ctx.stack("down");
  }
}
