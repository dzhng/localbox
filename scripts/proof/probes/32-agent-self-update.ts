import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { buildRealVMs, realDaemon } from "../lib/real-daemon.js";
import { BUN_VERSION, agentBinaryName, buildGuestAgent, bunVersion } from "../../build-guest-agent.js";

export const id = "32";
export const tiers = ["u", "s", "v"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const GIB = 1024 ** 3;

/** The host keeps every guest agent at its own build: pushed over the control lane, swapped in place, never a sandbox restart. */
export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("guest self-update: chunk integrity, sha mismatch refused, atomic swap, deferral while a job runs; binaries announce their version", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/guest-self-update.test.ts", "tests/agent-binary.test.ts"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2000));
    })];
  }
  if (ctx.tier === "s") {
    return [await ctx.check("AgentUpdaterTests: an expected close re-dials, an unexpected close still stops, jobs defer the push", async () => {
      const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "AgentUpdaterTests"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2000));
      assert.match(result.stdout + result.stderr, /Executed 5 tests, with 0 failures/);
    })];
  }
  if (bunVersion() !== BUN_VERSION) throw new Error(`blocked: building a second agent needs bun ${BUN_VERSION}`);
  // The image carries the build `npm run image:boot` made; the host starts out shipping the same one, then a build
  // with another version (the same agent under another release) stands in for the next release's agent.
  const hostAgent = mkdtempSync(join(tmpdir(), "localbox-proof-32-agent-"));
  const nextBuild = mkdtempSync(join(tmpdir(), "localbox-proof-32-next-"));
  const daemon = realDaemon(ctx, { probe: "32", env: { LOCALBOX_GUEST_AGENT: hostAgent } });
  const evidence: Record<string, unknown> = { machine_root: daemon.machine };
  const checks: Check[] = [];
  const first = "sandbox_p32_alpha", second = "sandbox_p32_bravo";
  let imageVersion = "", nextVersion = "";
  const reported: string[] = [];
  /** An update is reported once, with whichever result for that sandbox comes next, so every result is read for it. */
  const collect = (result: any) => { reported.push(...(result.actions ?? []).filter((action: any) => action.kind === "agent_updated").map((action: any) => action.detail)); return result; };
  const info = async (sandboxId: string) => collect(await daemon.ok("system.info", sandboxId));
  const facts = async (sandboxId: string) => {
    const [bootId, uptime] = collect(await daemon.ok("shell.exec", sandboxId, { command: "cat /proc/sys/kernel/random/boot_id; cut -d' ' -f1 /proc/uptime", cwd: "/" })).stdout.trim().split("\n");
    return { bootId, uptime: Number(uptime) };
  };
  const untilVersion = async (sandboxId: string, version: string, withinMs: number) => {
    const started = Date.now();
    for (;;) {
      if ((await info(sandboxId)).agent_version === version) return Date.now() - started;
      if (Date.now() - started > withinMs) throw new Error(`${sandboxId} still runs agent ${(await info(sandboxId)).agent_version} after ${withinMs} ms`);
      await sleep(250);
    }
  };
  try {
    checks.push(await ctx.check("the minimal image, the host daemon, and a next agent build with another version", async () => {
      const bin = await buildRealVMs(ctx);
      cpSync(join(ctx.root, "dist/guest-agent"), hostAgent, { recursive: true });
      imageVersion = JSON.parse(readFileSync(join(hostAgent, "agent-version.json"), "utf8")).version;
      nextVersion = (await buildGuestAgent(nextBuild, "0.0.0-probe32")).version;
      assert.notEqual(nextVersion, imageVersion);
      Object.assign(evidence, { image_agent: imageVersion, next_agent: nextVersion });
      await daemon.start(bin);
    }));
    checks.push(await ctx.check("a host shipping the image's own agent leaves it alone", async () => {
      await daemon.ok("sandbox.create", first, { name: "alpha-p32", cpus: 2, memory_bytes: 2 * GIB, sleep_after_ms: 3_600_000 });
      assert.equal((await info(first)).agent_version, imageVersion);
    }));
    let job = "", pid = "", before = { bootId: "", uptime: 0 };
    checks.push(await ctx.check("a new host build while a job runs: the push waits for the job", async () => {
      job = (await daemon.ok("shell.exec", first, { command: "sleep 15", background: true })).job_id;
      pid = await daemon.sh(first, "nohup sleep 100000 >/dev/null 2>&1 & echo $!");
      before = await facts(first);
      for (const os of ["linux", "darwin"] as const) cpSync(join(nextBuild, agentBinaryName(os)), join(hostAgent, agentBinaryName(os)));
      writeFileSync(join(hostAgent, "agent-version.json.tmp"), readFileSync(join(nextBuild, "agent-version.json")));
      renameSync(join(hostAgent, "agent-version.json.tmp"), join(hostAgent, "agent-version.json"));
      await sleep(5_000);
      assert.equal((await info(first)).agent_version, imageVersion, "deferred while the job runs");
      assert.equal((await daemon.ok("job.status", first, { job_id: job })).status, "running");
    }));
    checks.push(await ctx.check("the deferred update lands once the job ends: same boot, uptime kept, a background process still alive", async () => {
      const waited = collect(await daemon.ok("job.wait", first, { job_id: job, timeout_ms: 30_000 }));
      assert.equal(waited.status, "completed");
      evidence.landed_after_job_ms = await untilVersion(first, nextVersion, 20_000);
      const after = await facts(first);
      Object.assign(evidence, { before, after });
      assert.equal(after.bootId, before.bootId, "the guest kernel never rebooted");
      assert.ok(after.uptime > before.uptime, `uptime ${after.uptime} s continues from ${before.uptime} s`);
      assert.equal(collect(await daemon.ok("shell.exec", first, { command: `kill -0 ${pid} && echo alive`, cwd: "/" })).stdout.trim(), "alive");
      assert.equal((await daemon.ok("sandbox.status", first)).state, "running");
      assert.equal(daemon.record(first).cold_boot_pending ?? null, null);
    }));
    checks.push(await ctx.check("a sandbox that boots with the older agent gets the host's build at connect", async () => {
      const created = await daemon.ok("sandbox.create", second, { name: "bravo-p32", cpus: 2, memory_bytes: 2 * GIB, sleep_after_ms: 3_600_000 });
      const booted = await facts(second);
      evidence.connect_update_ms = await untilVersion(second, nextVersion, 30_000);
      evidence.second_created = created.actions;
      assert.equal((await facts(second)).bootId, booted.bootId);
      assert.equal(collect(await daemon.ok("shell.exec", second, { command: "echo ok", cwd: "/" })).stdout.trim(), "ok");
      evidence.reported = reported;
      assert.equal(reported.filter((detail) => detail.includes(`to ${nextVersion} without restarting the sandbox`)).length, 2, JSON.stringify(reported));
    }));
  } finally {
    if (checks.some((check) => !check.ok)) {
      for (const sandboxId of [first, second]) {
        evidence[`${sandboxId}_status`] = await daemon.call("sandbox.status", sandboxId, {}, false).catch((error) => String(error));
      }
    }
    await daemon.cleanup();
    rmSync(hostAgent, { recursive: true, force: true }); rmSync(nextBuild, { recursive: true, force: true });
  }
  const directory = join(ctx.root, "specs/sandbox-images/evidence"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "32-agent-update.json"), `${JSON.stringify({ checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })), ...evidence }, null, 2)}\n`);
  return checks;
}
