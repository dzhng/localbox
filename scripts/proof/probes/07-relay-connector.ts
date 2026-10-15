import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { asMachine } from "../lib/as-machine.js";
import { API_ORIGIN, login, machineRoot, startConnector, stopConnector } from "../lib/login.js";

export const id = "07";
export const tiers = ["u", "l"];

const convexEnv = { CONVEX_AGENT_MODE: "anonymous" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("relay mailbox, connector, agent ops and parity unit tests", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/relay-convex.test.ts", "tests/connector.test.ts", "tests/client-relay.test.ts", "tests/catalog-relay-parity.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2000));
    })];
  }
  const up = await ctx.stack("up", ["a", "b"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const run = Date.now(); let calls = 0; let machineB = "";
  const env = { LOCALBOX_API_ORIGIN: API_ORIGIN };
  const guestRoot = (machine: string) => join(machineRoot(ctx.root, machine), "sandboxes/vm_01/root");
  /** `invoke --machine b` from machine A; returns the parsed envelope. */
  const onB = async (operation: string, input: unknown, options: { mutation?: string; deadlineMs?: number } = {}) => {
    const args = ["invoke", "--json", operation, "--machine", machineB, "--input-json", JSON.stringify(input), "--request-id", `p07-${run}-${calls++}`, ...(options.mutation ? ["--mutation-id", options.mutation] : []), ...(options.deadlineMs ? ["--deadline-ms", String(options.deadlineMs)] : [])];
    const started = Date.now(); const result = await asMachine("a", args, { cwd: ctx.root, env });
    return { ms: Date.now() - started, envelope: JSON.parse(result.stdout.trim() || "{}"), stderr: result.stderr };
  };
  const rows = async (): Promise<any[]> => {
    const data = await ctx.exec("npx", ["convex", "data", "requests", "--format", "jsonLines", "--limit", "1000"], { env: convexEnv });
    assert.equal(data.code, 0, data.stderr);
    return data.stdout.trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  };
  /** Counts Convex function executions while `during` runs, from the local backend's function log. */
  const countCalls = async (during: () => Promise<void>): Promise<number> => {
    let count = 0; const child: ChildProcess = spawn("npx", ["convex", "logs", "--success", "--jsonl", "--history", "0"], { cwd: ctx.root, env: { ...process.env, ...convexEnv }, stdio: ["ignore", "pipe", "ignore"], detached: true });
    child.stdout!.on("data", (chunk: Buffer) => { count += chunk.toString().split("\n").filter((line) => line.includes("\"udfType\"") || line.includes("\"identifier\"")).length; });
    await sleep(3000); count = 0;
    try { await during(); await sleep(2000); } finally { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } }
    return count;
  };
  const connectors: Record<string, ChildProcess | undefined> = {};
  const waitConnected = async (machine: string) => {
    for (let attempt = 0; attempt < 60; attempt++) { if (readFileSync(join(machineRoot(ctx.root, machine), "logs/connector.log"), "utf8").split("started for machine").at(-1)?.includes("state connected")) return; await sleep(250); }
    throw new Error(`machine ${machine}'s connector never reported connected`);
  };
  try {
    const checks: Check[] = [];
    const email = `proof-07-${run}@example.com`;
    checks.push(await ctx.check("A and B sign in and their connectors connect", async () => {
      for (const machine of ["a", "b"]) { const signed = await login(ctx.root, machine, email); assert.equal(signed.code, 0, signed.stderr); }
      machineB = JSON.parse(readFileSync(join(machineRoot(ctx.root, "b"), "credentials.json"), "utf8")).machine_id;
      for (const machine of ["a", "b"]) { writeFileSync(join(machineRoot(ctx.root, machine), "logs/connector.log"), ""); connectors[machine] = startConnector(ctx.root, machine); }
      await waitConnected("a"); await waitConnected("b");
    }));
    const budget: Record<string, unknown> = {};
    checks.push(await ctx.check("from A, shell exec --machine b runs on B; median claim latency under 1 s over 10 runs", async () => {
      const marker = `from-a-${run}`;
      const exec = await asMachine("a", ["shell", "exec", "--machine", machineB, "--json", "--", "touch", marker], { cwd: ctx.root, env });
      assert.equal(JSON.parse(exec.stdout).ok, true, exec.stdout + exec.stderr);
      assert.ok(existsSync(join(guestRoot("b"), marker)), "the command ran in B's guest"); assert.ok(!existsSync(join(guestRoot("a"), marker)), "and not in A's");
      const timings: number[] = [];
      const relayed = await countCalls(async () => { for (let index = 0; index < 10; index++) { const result = await onB("fs.stat", { path: "/" }); assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope)); timings.push(result.ms); } });
      const ours = (await rows()).filter((row) => row.operation === "fs.stat" && row.claimedAt);
      const claim = ours.map((row) => row.claimedAt - row.createdAt);
      assert.equal(claim.length, 10); assert.ok(median(claim) < 1000, `median claim latency ${median(claim)} ms`);
      Object.assign(budget, { claim_latency_ms: claim, round_trip_ms: timings, convex_calls_per_request: relayed / 10, payload_bytes: ours.map((row) => JSON.stringify(row.payload).length) });
    }));
    checks.push(await ctx.check("over 60 s idle neither machine makes a Convex function call", async () => {
      const idle = await countCalls(() => sleep(60_000)); budget.idle_calls_60s = idle;
      assert.equal(idle, 0, `${idle} function calls while idle`);
    }));
    checks.push(await ctx.check("B's connector stopped: A gets machine_offline in under 5 s, the row is abandoned, and B never runs it", async () => {
      stopConnector(connectors.b); await sleep(500);
      const marker = `offline-${run}`;
      const result = await onB("shell.exec", { command: "touch", args: [marker], cwd: "/" }, { mutation: `offline-${run}` });
      assert.equal(result.envelope.error?.code, "machine_offline", JSON.stringify(result.envelope)); assert.ok(result.ms < 5000, `took ${result.ms} ms`);
      assert.match(result.envelope.error.message, /last seen/);
      assert.equal((await rows()).find((row) => row.mutationId === `offline-${run}`)?.status, "abandoned");
      connectors.b = startConnector(ctx.root, "b"); await waitConnected("b"); await sleep(2000);
      assert.ok(!existsSync(join(guestRoot("b"), marker)), "an abandoned request must never run later");
    }));
    checks.push(await ctx.check("connector killed after claim: operation_uncertain, then replaying the mutation id returns the original result", async () => {
      const marker = `uncertain-${run}`; const mutation = `uncertain-${run}`;
      const input = { command: "sh", args: ["-c", `sleep 2; date +%s > ${marker}; echo $$ >> ${marker}; cat ${marker}`], cwd: "/" };
      const pending = onB("shell.exec", input, { mutation, deadlineMs: 2500 });
      for (let attempt = 0; attempt < 40; attempt++) { if ((await rows()).find((row) => row.mutationId === mutation)?.status === "claimed") break; await sleep(100); }
      stopConnector(connectors.b, "SIGKILL");
      const first = await pending; assert.equal(first.envelope.error?.code, "operation_uncertain", JSON.stringify(first.envelope));
      connectors.b = startConnector(ctx.root, "b"); await waitConnected("b");
      const replay = await onB("shell.exec", input, { mutation, deadlineMs: 30_000 });
      assert.equal(replay.envelope.ok, true, JSON.stringify(replay.envelope));
      assert.equal(replay.envelope.result.stdout.trim(), readFileSync(join(guestRoot("b"), marker), "utf8").trim(), "the replay returns the one run's output");
    }));
    checks.push(await ctx.check("a 2 MiB fs.read on B returns 900 KiB with truncated", async () => {
      writeFileSync(join(guestRoot("b"), `big-${run}.txt`), "z".repeat(2 * 1024 * 1024));
      const result = await onB("fs.read", { path: `/big-${run}.txt` });
      assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope).slice(0, 500));
      assert.equal(result.envelope.result.truncated.original_bytes, 2_097_152); assert.ok(result.envelope.result.truncated.returned_bytes <= 900 * 1024);
    }));
    checks.push(await ctx.check("with the daily request limit at usage + 3, the fourth request names the limit and reset", async () => {
      const usage = await ctx.exec("npx", ["convex", "data", "relayUsage", "--format", "jsonLines"], { env: convexEnv });
      const used = usage.stdout.trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).reduce((sum, row) => sum + row.requests, 0);
      const limit = used + 3; assert.equal((await ctx.exec("npx", ["convex", "env", "set", "LOCALBOX_RELAY_DAILY_REQUESTS", String(limit)], { env: convexEnv })).code, 0);
      try {
        for (let index = 0; index < 3; index++) assert.equal((await onB("fs.stat", { path: "/" })).envelope.ok, true);
        const fourth = await onB("fs.stat", { path: "/" });
        assert.equal(fourth.envelope.error?.code, "rate_limited", JSON.stringify(fourth.envelope));
        assert.match(fourth.envelope.error.message, new RegExp(`${limit}.*reset \\d{4}-`));
      } finally { await ctx.exec("npx", ["convex", "env", "remove", "LOCALBOX_RELAY_DAILY_REQUESTS"], { env: convexEnv }); }
    }));
    checks.push(await ctx.check("relay:cleanupExpired with a future cutoff removes the rows", async () => {
      assert.ok((await rows()).length > 0);
      const cleaned = await ctx.exec("npx", ["convex", "run", "relay:cleanupExpired", JSON.stringify({ cutoff: Date.now() + 86_400_000, batch: 5 })], { env: convexEnv });
      assert.equal(cleaned.code, 0, cleaned.stderr);
      for (let attempt = 0; attempt < 20 && (await rows()).length > 0; attempt++) await sleep(250);
      assert.equal((await rows()).length, 0, "self-rescheduling batches delete every row");
    }));
    writeFileSync(join(ctx.evidence, "07-budget.json"), `${JSON.stringify(budget, null, 2)}\n`);
    return checks;
  } finally {
    for (const child of Object.values(connectors)) stopConnector(child);
    if (!ctx.keep) await ctx.stack("down");
  }
}
