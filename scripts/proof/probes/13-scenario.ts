import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { asMachine } from "../lib/as-machine.js";
import { countConvexCalls } from "../lib/convex-admin.js";
import { API_ORIGIN, login, machineRoot, startConnector, stopConnector } from "../lib/login.js";
import { mcp, registerClient, signInAgent } from "../lib/mcp.js";
import { buildRealVMs, realDaemon, screenLocked } from "../lib/real-daemon.js";
import { guestRoot, inAnyGuestRoot, waitConnected } from "../lib/sandboxes.js";

export const id = "13";
export const tiers = ["l", "v"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const kinds = (result: any): string[] => (result?.actions ?? []).map((action: any) => action.kind);
const RELAYED = 5;
const SERVER_PORT = 8713;

/**
 * The whole product on one Mac: machines A and B signed in to one account with their connectors running. Tier l runs
 * both as fixture daemons; tier v makes A a real daemon (Apple backend, minimal image), so A's sandbox is a real VM.
 */
export async function run(ctx: ProofContext): Promise<Check[]> {
  const real = ctx.tier === "v";
  const daemonA = real ? realDaemon(ctx, { probe: "13" }) : undefined;
  const locked = real ? screenLocked() : false;
  const roots: Record<"a" | "b", string> = { a: daemonA?.machine ?? machineRoot(ctx.root, "a"), b: machineRoot(ctx.root, "b") };
  const names = { a: "proof-a", b: "proof-b" };
  const run = Date.now(); const email = `proof-13-${run}@example.com`;
  const transcript: string[] = []; const evidence: Record<string, unknown> = { tier: ctx.tier, machine_a: real ? "real (Apple Virtualization, minimal image)" : "fixture", machine_b: "fixture", screen_locked: locked };
  const connectors: Partial<Record<"a" | "b", ChildProcess>> = {};
  const sandboxes = { a: "", b: "", auto: "" };
  let calls = 0; let sandboxIdA = "";

  const as = async (machine: "a" | "b", args: string[]) => {
    const result = await asMachine(machine, args, { cwd: ctx.root, env: { LOCALBOX_API_ORIGIN: API_ORIGIN, LOCALBOX_MACHINE_ROOT: roots[machine] } });
    transcript.push(`$ [${machine}] localbox ${args.join(" ")}\n${result.stdout}${result.stderr}(exit ${result.code})\n`);
    let envelope: any = {};
    if (args.includes("--json")) { try { envelope = JSON.parse(result.stdout.trim() || "{}"); } catch { envelope = { unparsed: result.stdout }; } }
    return { ...result, envelope };
  };
  /** `sandbox create --json` from A, retried while the target's connector has not yet reported its size. */
  const create = async (extra: string[]) => {
    for (let attempt = 0; ; attempt++) {
      const created = await as("a", ["sandbox", "create", "--json", "--cpus", "1", "--memory", "2G", ...extra]);
      if (created.envelope.ok) return created.envelope.result as { produced: Record<string, any>; actions: Array<{ kind: string; detail: string }> };
      if (created.envelope.error?.code !== "machine_offline" || attempt >= 20) throw new Error(`sandbox create ${extra.join(" ")} failed: ${created.stdout}${created.stderr}`);
      await sleep(250);
    }
  };
  const exec = async (sandbox: string, command: string[]) => as("a", ["shell", "exec", "--sandbox", sandbox, "--json", "--", ...command]);
  const machineId = (machine: "a" | "b") => JSON.parse(readFileSync(join(roots[machine], "credentials.json"), "utf8")).machine_id as string;
  const connect = async (machine: "a" | "b") => {
    mkdirSync(join(roots[machine], "logs"), { recursive: true }); writeFileSync(join(roots[machine], "logs/connector.log"), "");
    connectors[machine] = startConnector(ctx.root, machine, roots[machine]);
    await waitConnected(ctx.root, machine, roots[machine]);
  };

  const checks: Check[] = [];
  try {
    const up = await ctx.stack("up", real ? ["b:512G"] : ["a:8G", "b:16G"]);
    if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
    if (daemonA) {
      checks.push(await ctx.check("A: the minimal image, the host daemon and its signature are built, and the real daemon starts", async () => {
        await daemonA.start(await buildRealVMs(ctx));
      }));
      if (!checks.at(-1)!.ok) return checks;
    }

    checks.push(await ctx.check("A and B sign in with one email: the account shows 2 machines, both connectors connect and report their room", async () => {
      for (const machine of ["a", "b"] as const) {
        const signed = await login(ctx.root, machine, email, { LOCALBOX_MACHINE_ROOT: roots[machine] });
        transcript.push(`$ [${machine}] localbox login --email ${email} [--code from the dev log]\n${signed.stdout}${signed.stderr}(exit ${signed.code})\n`);
        assert.equal(signed.code, 0, signed.stdout + signed.stderr);
        if (machine === "b") assert.match(signed.stdout, /2 machines/);
        const renamed = await as(machine, ["machine", "rename", machineId(machine), names[machine]]);
        assert.equal(renamed.code, 0, renamed.stdout + renamed.stderr);
      }
      await connect("a"); await connect("b");
      let machines: any[] = [];
      for (let attempt = 0; attempt < 60 && machines.filter((row) => row.capacity).length < 2; attempt++) { machines = (await as("a", ["machine", "list", "--json"])).envelope.result ?? []; await sleep(250); }
      assert.deepEqual(machines.map((row) => row.name).sort(), [names.a, names.b]);
      assert.equal(machines.filter((row) => row.capacity).length, 2, JSON.stringify(machines));
      evidence.machines = machines.map((row) => ({ name: row.name, capacity: row.capacity }));
    }));

    checks.push(await ctx.check(`a create from A with no option lands on A${real ? " as a real VM" : ""}, with --sleep-after 5s`, async () => {
      const created = await create(["--sleep-after", "5s"]);
      assert.equal(created.produced.machine, names.a); assert.equal(created.produced.sleep_after_ms, 5_000);
      assert.match(created.produced.placement_reason, new RegExp(`^on ${names.a}, this machine`));
      assert.deepEqual(kinds(created), ["created", "cold_booted"]);
      sandboxes.a = created.produced.name; sandboxIdA = created.produced.sandbox_id; evidence.create_local = created.produced;
      const arch = await exec(sandboxes.a, ["uname", "-m"]);
      assert.equal(arch.envelope.ok, true, arch.stdout + arch.stderr);
      if (real) assert.equal(arch.envelope.result.stdout.trim(), "aarch64", "a Linux guest");
    }));
    if (real) {
      checks.push(await ctx.check("a background Node server starts in A's real sandbox", async () => {
        const server = `require("http").createServer((q, s) => s.end(String(process.pid))).listen(${SERVER_PORT})`;
        const started = await exec(sandboxes.a, ["sh", "-c", `nohup node -e '${server}' >/dev/null 2>&1 & echo $!`]);
        assert.equal(started.envelope.ok, true, started.stdout + started.stderr);
        const pid = started.envelope.result.stdout.trim(); assert.match(pid, /^\d+$/);
        let served = "";
        for (let attempt = 0; attempt < 40 && served !== pid; attempt++) { served = (await exec(sandboxes.a, ["sh", "-c", fetchServer()])).envelope.result?.stdout?.trim() ?? ""; await sleep(250); }
        assert.equal(served, pid, "the server answers with its own PID"); evidence.node_server_pid = pid;
      }));
    }

    checks.push(await ctx.check("--machine <B> from A lands on B", async () => {
      const created = await create(["--machine", machineId("b")]);
      assert.equal(created.produced.machine, names.b); sandboxes.b = created.produced.name; evidence.create_on_b = created.produced;
    }));
    checks.push(await ctx.check("--placement auto from A lands on B, the machine with the most room, and says why", async () => {
      const created = await create(["--placement", "auto"]);
      assert.equal(created.produced.machine, names.b);
      assert.match(created.produced.placement_reason, new RegExp(`^on ${names.b}, the machine with the most room`));
      sandboxes.auto = created.produced.name; evidence.create_auto = created.produced;
    }));

    checks.push(await ctx.check(`shell exec from A on B's sandbox runs on B; Convex function calls per relayed request (over ${RELAYED})`, async () => {
      const marker = `from-a-${run}`;
      const ran = await exec(sandboxes.b, ["touch", marker]);
      assert.equal(ran.envelope.ok, true, ran.stdout + ran.stderr);
      assert.ok(existsSync(join(guestRoot(ctx.root, "b", sandboxes.b), marker)), "the command ran in B's guest");
      if (!real) assert.ok(!inAnyGuestRoot(ctx.root, "a", marker), "and not in A's");
      const timings: number[] = [];
      const counted = await countConvexCalls(ctx.root, async () => {
        for (let index = 0; index < RELAYED; index++) {
          const started = Date.now();
          const relayed = await as("a", ["invoke", "--json", "fs.stat", "--sandbox", sandboxes.b, "--input-json", JSON.stringify({ path: "/" }), "--request-id", `p13-${run}-${calls++}`]);
          assert.equal(relayed.envelope.ok, true, relayed.stdout + relayed.stderr); timings.push(Date.now() - started);
        }
      });
      evidence.convex_calls_per_relayed_request = counted / RELAYED; evidence.relayed_round_trip_ms = timings;
    }));

    checks.push(await ctx.check(`an MCP tools/call from a signed-in agent runs shell.exec in A's sandbox${real ? " (the real VM)" : ""}`, async () => {
      const { metadata, clientId } = await registerClient("Proof Cloud Agent");
      const tokens = await signInAgent(ctx.root, metadata, clientId, email);
      const called = await mcp(tokens.access_token, "tools/call", { name: "shell.exec", arguments: { sandbox: sandboxes.a, command: "uname", args: ["-m"], cwd: "/" } });
      assert.equal(called.status, 200); assert.notEqual(called.body.result.isError, true, JSON.stringify(called.body));
      const arch = called.body.result.structuredContent.stdout.trim();
      if (real) assert.equal(arch, "aarch64"); else assert.ok(arch.length > 0);
      evidence.mcp_shell_exec = { sandbox: sandboxes.a, stdout: arch, actions: called.body.result.structuredContent.actions ?? [] };
    }));

    checks.push(await ctx.check("B's connector stopped: A's next call on B gets machine_offline; restarted, B serves again", async () => {
      stopConnector(connectors.b); await sleep(500);
      const started = Date.now(); const offline = await exec(sandboxes.b, ["true"]);
      assert.equal(offline.envelope.error?.code, "machine_offline", offline.stdout + offline.stderr);
      evidence.machine_offline = { ms: Date.now() - started, message: offline.envelope.error.message };
      await connect("b");
      const back = await exec(sandboxes.b, ["echo", "back"]);
      assert.equal(back.envelope.ok, true, back.stdout + back.stderr); assert.equal(back.envelope.result.stdout.trim(), "back");
    }));

    checks.push(await ctx.check(real
      ? (locked ? "A's sandbox sleeps when idle (paused in memory: the screen is locked) and the next exec reports woke; the Node server kept its PID" : "A's sandbox hibernates when idle and the next exec reports woke; the Node server kept its PID")
      : "A's sandbox sleeps when idle and the next exec reports woke", async () => {
      const idleFrom = Date.now(); let status: any;
      for (;;) {
        status = (await as("a", ["sandbox", "status", sandboxes.a, "--json"])).envelope.result;
        if (status?.state === "sleeping") break;
        if (Date.now() - idleFrom > 30_000) throw new Error(`${sandboxes.a} still ${status?.state} 30 s later`);
        await sleep(500);
      }
      evidence.asleep = status;
      if (real) {
        // The daemon's own view says which kind of sleep it was.
        const local = await daemonA!.ok("sandbox.status", sandboxIdA);
        evidence.asleep_on_daemon = { lifecycle: local.lifecycle, detail: local.detail };
        if (locked) assert.equal(local.lifecycle, "paused", JSON.stringify(local)); else assert.equal(local.lifecycle, "asleep", JSON.stringify(local));
      }
      const woke = await exec(sandboxes.a, real ? ["sh", "-c", fetchServer()] : ["echo", "awake"]);
      assert.equal(woke.envelope.ok, true, woke.stdout + woke.stderr);
      assert.deepEqual(kinds(woke.envelope.result), ["woke"]); evidence.woke = woke.envelope.result.actions;
      assert.equal(woke.envelope.result.stdout.trim(), real ? evidence.node_server_pid : "awake");
    }));

    checks.push(await ctx.check("machine remove <B> from A: B's connector exits with code 0, A's account shows 1 machine and none of B's sandboxes", async () => {
      const child = connectors.b!; const exited = new Promise<number | null>((resolve) => { if (child.exitCode !== null) resolve(child.exitCode); else child.once("exit", (code) => resolve(code)); });
      const started = Date.now();
      const removed = await as("a", ["machine", "remove", machineId("b"), "--json"]);
      assert.equal(removed.envelope.ok, true, removed.stdout + removed.stderr);
      const code = await Promise.race([exited, sleep(60_000).then(() => "timeout" as const)]);
      assert.equal(code, 0, `B's connector ${code === "timeout" ? "was still running 60 s after the removal" : `exited with ${code}`}`);
      evidence.connector_exit = { code, ms: Date.now() - started, log: readFileSync(join(roots.b, "logs/connector.log"), "utf8").split("\n").filter((line) => /revoked|stopping/.test(line)) };
      delete connectors.b;
      const machines = (await as("a", ["machine", "list", "--json"])).envelope.result ?? [];
      assert.deepEqual(machines.map((row: any) => row.name), [names.a]);
      // B and its disks are gone from the account, so its sandboxes' catalog rows went with it.
      assert.ok(removed.envelope.result.sandboxes_removed >= 1, JSON.stringify(removed.envelope));
      const listed = (await as("a", ["sandbox", "list", "--json"])).envelope.result.sandboxes as any[];
      assert.ok(!listed.some((row) => row.name === sandboxes.b), JSON.stringify(listed));
    }));
    return checks;
  } finally {
    for (const child of Object.values(connectors)) stopConnector(child);
    await daemonA?.cleanup();
    if (!ctx.keep) await ctx.stack("down");
    writeFileSync(join(ctx.evidence, "13-transcript.txt"), transcript.join("\n"));
    const file = real ? "13-scenario.json" : "13-scenario-l.json";
    writeFileSync(join(ctx.evidence, file), `${JSON.stringify({ ...evidence, checks: checks.map(({ name, ok, detail }) => ({ name, ok, ...(detail ? { detail } : {}) })) }, null, 2)}\n`);
    mkdirSync(join(ctx.root, "specs/durable-sandboxes/evidence"), { recursive: true });
    copyFileSync(join(ctx.evidence, file), join(ctx.root, "specs/durable-sandboxes/evidence", file));
  }
}

/** A shell command that asks the sandbox's Node server for its PID. */
function fetchServer(): string {
  return `node -e 'fetch("http://127.0.0.1:${SERVER_PORT}").then((r) => r.text()).then(console.log)'`;
}
