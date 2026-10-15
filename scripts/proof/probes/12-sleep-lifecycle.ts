import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { LocalIPCTransport } from "../../../packages/client/src/index.js";
import { machinePaths } from "../../../packages/config/src/machine-paths.js";
import { PROTOCOL_VERSION } from "../../../packages/contract/src/index.js";
import { machineRoot, stopConnector } from "../lib/login.js";
import { buildRealVMs, realDaemon, screenLocked } from "../lib/real-daemon.js";
import { cli, createSandbox, signedInWithSandboxes } from "../lib/sandboxes.js";

export const id = "12";
export const tiers = ["s", "l", "v"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const GIB = 1024 ** 3;
const kinds = (result: any): string[] => (result?.actions ?? []).map((action: any) => action.kind);
/** `npm run proof -- 12 --tier v --real-sleep` also puts this Mac to sleep (pmset) and checks the restore; never by default. */
const realSleep = process.argv.includes("--real-sleep");

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "s") {
    return [await ctx.check("idle sleep, running jobs, delete-after, power notices and the once-only cold boot report on a fake backend (Swift)", async () => {
      const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "testIdleSleepsAfterTimeout|testRunningJobKeepsAwake|testDeleteAfter|testPowerNoticeHibernatesAll|testColdBootReportedOnce"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2000));
      assert.match(result.stdout + result.stderr, /Executed 5 tests, with 0 failures/);
    })];
  }
  if (ctx.tier === "l") return await localStack(ctx);
  return await realVMs(ctx);
}

/** Fixture machines A and B signed in to one account with their connectors running; a fixture sleeps with SIGSTOP. */
async function localStack(ctx: ProofContext): Promise<Check[]> {
  const up = await ctx.stack("up", ["a:16G", "b:16G"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const transcript: string[] = []; const evidence: Record<string, unknown> = {};
  const as = async (machine: string, args: string[]) => {
    const result = await cli(ctx.root, machine, args);
    transcript.push(`$ [${machine}] localbox ${args.join(" ")}\n${result.stdout}${result.stderr}(exit ${result.code})\n`);
    return result;
  };
  const create = async (extra: string[]) => {
    const created = await createSandbox(ctx.root, "a", ["--cpus", "1", "--memory", "2G", ...extra]);
    transcript.push(`$ [a] localbox sandbox create --json --cpus 1 --memory 2G ${extra.join(" ")}\n${created.stdout}`);
    return created.envelope.result.produced as { name: string; sandbox_id: string; sleep_after_ms: number; delete_after_ms: number | null };
  };
  const state = async (name: string) => (await as("a", ["sandbox", "status", name, "--json"])).envelope.result?.state as string;
  /** Polls until `name` reads `wanted`; returns the ms from `since`, or fails after `withinMs`. */
  const until = async (name: string, wanted: string, since: number, withinMs: number) => {
    for (;;) {
      if (await state(name) === wanted) return Date.now() - since;
      if (Date.now() - since > withinMs) throw new Error(`${name} did not read ${wanted} within ${withinMs} ms`);
      await sleep(250);
    }
  };
  const paths = machinePaths({ LOCALBOX_MACHINE_ROOT: machineRoot(ctx.root, "a") });
  const daemonA = new LocalIPCTransport({ socketPath: paths.socket, tokenFile: paths.ipcToken });
  const simulate = async (event: string) => {
    const response: any = await daemonA.dispatch({ protocol_version: PROTOCOL_VERSION, request_id: `p12-power-${event}-${Date.now()}`, operation: "host.simulate_power", sandbox_id: null, deadline_ms: 60_000, mutation_id: null, input: { event } } as any);
    transcript.push(`$ [a socket] host.simulate_power ${event}\n${JSON.stringify(response)}\n`);
    assert.equal(response.ok, true, JSON.stringify(response)); return response.result;
  };
  let setup: Awaited<ReturnType<typeof signedInWithSandboxes>> | undefined;
  const checks: Check[] = [];
  try {
    checks.push(await ctx.check("A and B sign in with one email and connect", async () => {
      setup = await signedInWithSandboxes(ctx.root, ["a", "b"], `proof-12-${Date.now()}@example.com`, { create: false });
    }));
    checks.push(await ctx.check("--sleep-after 5s: asleep by 7 s, and the next shell exec wakes it and reports woke", async () => {
      const sandbox = await create(["--sleep-after", "5s"]); const created = Date.now();
      assert.equal(sandbox.sleep_after_ms, 5_000);
      evidence.asleep_after_ms = await until(sandbox.name, "sleeping", created, 7_000);
      const woke = await as("a", ["shell", "exec", "--sandbox", sandbox.name, "--json", "--", "echo", "awake"]);
      assert.equal(woke.envelope.ok, true, woke.stdout + woke.stderr);
      assert.deepEqual(kinds(woke.envelope.result), ["woke"]); assert.equal(woke.envelope.result.stdout.trim(), "awake");
      evidence.woke = woke.envelope.result.actions;
      const text = await as("a", ["shell", "exec", "--sandbox", sandbox.name, "--", "true"]);
      assert.doesNotMatch(text.stdout, /woke/, "an awake sandbox reports nothing");
    }));
    checks.push(await ctx.check("a 10 s background job keeps a --sleep-after 5s sandbox awake past 5 s; it sleeps once the job ends", async () => {
      const sandbox = await create(["--sleep-after", "5s"]);
      const job = await as("a", ["shell", "exec", "--sandbox", sandbox.name, "--background", "--json", "--", "sleep", "10"]); const started = Date.now();
      assert.equal(job.envelope.ok, true, job.stdout + job.stderr);
      await sleep(8_000);
      assert.equal(await state(sandbox.name), "running", "8 s in, the job still runs");
      evidence.job_asleep_after_ms = await until(sandbox.name, "sleeping", started, 19_000);
      assert.ok((evidence.job_asleep_after_ms as number) >= 14_000, `slept 5 s after the job ended, not before: ${evidence.job_asleep_after_ms} ms`);
    }));
    checks.push(await ctx.check("--delete-after 10s removes the sandbox from the Convex list, with the reason", async () => {
      const sandbox = await create(["--delete-after", "10s"]); const created = Date.now();
      assert.equal(sandbox.delete_after_ms, 10_000);
      let listed: any[] = [];
      for (;;) {
        listed = (await as("b", ["sandbox", "list", "--json"])).envelope.result?.sandboxes ?? [];
        if (!listed.some((row) => row.name === sandbox.name)) break;
        if (Date.now() - created > 16_000) throw new Error(`${sandbox.name} is still listed ${Date.now() - created} ms after create`);
        await sleep(500);
      }
      evidence.deleted_after_ms = Date.now() - created;
      const connectorLog = readFileSync(join(machineRoot(ctx.root, "a"), "logs/connector.log"), "utf8");
      const line = connectorLog.split("\n").find((entry) => entry.includes(`removed ${sandbox.name} (${sandbox.sandbox_id}) from the catalog: `));
      assert.ok(line, "A's connector logs the removal");
      assert.match(line!, /idle for \d+ s, past its delete-after of 10 s$/);
      evidence.deleted_reason = line;
      const hostdLog = readFileSync(join(machineRoot(ctx.root, "a"), "logs/hostd.log"), "utf8");
      assert.match(hostdLog, new RegExp(`deleted ${sandbox.name}: idle for \\d+ s`));
    }));
    checks.push(await ctx.check("host.simulate_power will_sleep sleeps every running sandbox; did_wake brings them back and the next result says woke", async () => {
      const awake = [await create([]), await create([])];
      const slept = await simulate("will_sleep");
      evidence.will_sleep = slept;
      for (const sandbox of awake) assert.equal(await state(sandbox.name), "sleeping");
      assert.ok(slept.sandboxes.length >= awake.length && slept.sandboxes.every((row: any) => row.kind === "slept"), JSON.stringify(slept));
      evidence.did_wake = await simulate("did_wake");
      for (const sandbox of awake) {
        const next = await as("a", ["shell", "exec", "--sandbox", sandbox.name, "--json", "--", "true"]);
        assert.deepEqual(kinds(next.envelope.result), ["woke"], next.stdout);
      }
    }));
    return checks;
  } finally {
    writeFileSync(join(ctx.evidence, "12-transcript.txt"), transcript.join("\n"));
    writeFileSync(join(ctx.evidence, "12-sleep-lifecycle-l.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    for (const child of Object.values(setup?.connectors ?? {})) stopConnector(child);
    if (!ctx.keep) await ctx.stack("down");
  }
}

/**
 * Machine A real (Apple backend, minimal image): a --sleep-after 5s sandbox with a background process sleeps, the
 * next exec wakes it with the process alive, and a kill -9 of the daemon makes the next result report cold_booted.
 */
async function realVMs(ctx: ProofContext): Promise<Check[]> {
  const { machine, start, stop, ok, sh, record, vmRSS, cleanup } = realDaemon(ctx, { probe: "12" });
  const locked = screenLocked();
  const evidence: Record<string, unknown> = { machine_root: machine, screen_locked: locked, real_sleep: realSleep };
  const sandboxId = "sandbox_p12_alpha", name = "alpha-otter";
  let bin = ""; let pid = "";
  const checks: Check[] = [];
  try {
    checks.push(await ctx.check("the minimal image, the host daemon and its signature are built", async () => {
      bin = await buildRealVMs(ctx); await start(bin);
    }));
    checks.push(await ctx.check(locked ? "--sleep-after 5s with a background process: asleep by ~7 s, paused in memory (hibernate needs an unlocked screen)" : "--sleep-after 5s with a background process: hibernated by ~7 s, its memory released", async () => {
      const created = await ok("sandbox.create", sandboxId, { name, cpus: 2, memory_bytes: 2 * GIB, sleep_after_ms: 5_000 });
      assert.deepEqual(kinds(created), ["created", "cold_booted"]);
      pid = await sh(sandboxId, "nohup sleep 100000 >/dev/null 2>&1 & echo $!");
      assert.match(pid, /^\d+$/);
      const idleFrom = Date.now(); const before = [...vmRSS().values()].reduce((sum, kb) => sum + kb, 0);
      let status: any;
      for (;;) {
        status = await ok("sandbox.status", sandboxId);
        if (status.state === "sleeping") break;
        if (Date.now() - idleFrom > 30_000) throw new Error(`still ${status.state} 30 s after its last request`);
        await sleep(250);
      }
      evidence.asleep_after_ms = Date.now() - idleFrom; evidence.status_asleep = status;
      evidence.vm_footprint_kb_awake = before; evidence.vm_footprint_kb_asleep = [...vmRSS().values()].reduce((sum, kb) => sum + kb, 0);
      // The last request (the background start) ends the idle clock's reset; a save adds its own seconds.
      assert.ok((evidence.asleep_after_ms as number) <= (locked ? 7_500 : 15_000), `asleep after ${evidence.asleep_after_ms} ms`);
      if (locked) {
        assert.equal(status.lifecycle, "paused"); assert.equal(status.detail, "paused in memory: hibernate needs an unlocked screen");
        assert.equal(record(sandboxId).lifecycle, "sleeping");
      } else {
        assert.equal(status.lifecycle, "asleep"); assert.equal(record(sandboxId).lifecycle, "asleep");
        assert.equal(vmRSS().size, 0, "the VM service exited: its memory is released");
      }
    }));
    checks.push(await ctx.check(locked ? "the next exec wakes it (resume) and reports woke; the background PID survived the pause" : "the next exec restores it and reports woke; the background PID survived the hibernate", async () => {
      const woke = await ok("shell.exec", sandboxId, { command: `kill -0 ${pid} && echo alive`, cwd: "/" });
      evidence.wake = woke.actions;
      assert.deepEqual(kinds(woke), ["woke"]);
      assert.equal(woke.actions[0].detail, locked ? `woke ${name} from sleep` : `restored ${name} from its saved state`);
      assert.equal(woke.stdout.trim(), "alive", `PID ${pid} survived`);
    }));
    checks.push(await ctx.check("kill -9 of the daemon and a relaunch: the next result reports cold_booted exactly once", async () => {
      // Keep it awake from here on (a mirror push sets the catalog's policy), so the daemon dies while it runs.
      await ok("sandbox.mirror", null, { sandboxes: [{ sandbox_id: sandboxId, name, sleep_after_ms: 3_600_000, delete_after_ms: null }] });
      assert.equal((await ok("sandbox.status", sandboxId)).state, "running");
      await stop("SIGKILL", 10_000);
      // The VM service outlives a SIGKILLed daemon briefly; ours only (Colima's VM is one too).
      for (let waited = 0; waited < 10_000 && vmRSS().size; waited += 250) await sleep(250);
      for (const service of vmRSS().keys()) { try { process.kill(service, "SIGKILL"); } catch { /* gone */ } }
      rmSync(join(machine, "agent.sock"), { force: true });
      await start(bin);
      // Wait on host.watch, which names no sandbox: any sandbox operation would be the "next result" itself.
      for (let waited = 0; waited < 180_000; waited += 500) {
        const watched = await ok("host.watch", null, { since: 0 });
        if (watched.sandboxes.find((row: any) => row.sandbox_id === sandboxId)?.state === "running") break;
        await sleep(500);
      }
      const first = await ok("shell.exec", sandboxId, { command: `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`, cwd: "/" });
      evidence.after_crash = first.actions;
      assert.deepEqual(first.actions, [{ kind: "cold_booted", detail: `cold-booted ${name}: the daemon exited without saving it` }]);
      assert.equal(first.stdout.trim(), "gone", "a cold boot starts fresh processes");
      const second = await ok("shell.exec", sandboxId, { command: "true", cwd: "/" });
      assert.equal(second.actions, undefined, "reported once");
    }));
    if (realSleep) {
      checks.push(await ctx.check("--real-sleep: the Mac sleeps (pmset), the sandbox sleeps with it and runs again after the wake", async () => {
        pid = await sh(sandboxId, "nohup sleep 100000 >/dev/null 2>&1 & echo $!");
        execFileSync("sudo", ["-n", "pmset", "relative", "wake", "90"]); execFileSync("sudo", ["-n", "pmset", "sleepnow"]);
        await sleep(150_000);
        const log = readFileSync(join(ctx.evidence, "12-hostd.log"), "utf8");
        assert.match(log, /will_sleep sandbox_p12_alpha slept/); evidence.real_sleep_log = log.split("\n").filter((line) => /will_sleep|did_wake/.test(line));
        const after = await ok("shell.exec", sandboxId, { command: `kill -0 ${pid} && echo alive`, cwd: "/" });
        assert.equal(after.stdout.trim(), "alive");
      }));
    }
  } finally {
    await cleanup();
    writeFileSync(join(ctx.evidence, "12-sleep-lifecycle.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  return checks;
}
