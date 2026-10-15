import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { asMachine } from "../lib/as-machine.js";
import { API_ORIGIN, machineRoot, stopConnector } from "../lib/login.js";
import { buildRealVMs, realDaemon, screenLocked } from "../lib/real-daemon.js";
import { cli, createSandbox, signedInWithSandboxes } from "../lib/sandboxes.js";

export const id = "11";
export const tiers = ["u", "l", "v"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const GIB = 1024 ** 3;
const madeRoom = (envelope: any): string[] => (envelope.result?.actions ?? []).filter((action: any) => action.kind === "made_room").map((action: any) => action.detail);

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [
      await ctx.check("place() table: default, --machine, auto, remote, ties, offline machines, no caller machine; the create route and the connector's capacity writes", async () => {
        const result = await ctx.exec("npx", ["tsx", "--test", "tests/placement.test.ts", "tests/sandbox-catalog.test.ts", "tests/connector.test.ts"]);
        assert.equal(result.code, 0, result.stdout.slice(-2000));
      }),
      await ctx.check("admission sleeps the least recently used sandbox and never one running a job (Swift, fake backend)", async () => {
        const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "testAdmitSleepsLeastRecentlyUsed|testRunningJobIsNeverSleptForRoom"]);
        assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2000));
        assert.match(result.stdout + result.stderr, /Executed 2 tests, with 0 failures/);
      }),
    ];
  }
  if (ctx.tier === "l") return await localStack(ctx);
  return await realVMs(ctx);
}

/** Fixture machines A (8 GiB) and B (16 GiB), signed in to one account with their connectors running. */
async function localStack(ctx: ProofContext): Promise<Check[]> {
  const up = await ctx.stack("up", ["a:8G", "b:16G"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const run = Date.now(); const transcript: string[] = [];
  const as = async (machine: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
    const result = env.LOCALBOX_MACHINE_ROOT ? await asMachine(machine, args, { cwd: ctx.root, env: { LOCALBOX_API_ORIGIN: API_ORIGIN, ...env } }).then((out) => ({ ...out, envelope: args.includes("--json") ? JSON.parse(out.stdout.trim() || "{}") : {} })) : await cli(ctx.root, machine, args);
    transcript.push(`$ [${env.LOCALBOX_MACHINE_ROOT ? `${machine}, no local daemon` : machine}] localbox ${args.join(" ")}\n${result.stdout}${result.stderr}(exit ${result.code})\n`);
    return result;
  };
  const machineId = (machine: string) => JSON.parse(readFileSync(join(machineRoot(ctx.root, machine), "credentials.json"), "utf8")).machine_id as string;
  let setup: Awaited<ReturnType<typeof signedInWithSandboxes>> | undefined;
  const names = { a: "", b: "" }; const onA: string[] = [];
  try {
    const checks: Check[] = [];
    checks.push(await ctx.check("A (8 GiB) and B (16 GiB) sign in with one email, connect, and report their capacity", async () => {
      setup = await signedInWithSandboxes(ctx.root, ["a", "b"], `proof-11-${run}@example.com`, { create: false });
      // Both fixture machines start as this Mac's hostname; distinct names make "which machine" readable.
      for (const machine of ["a", "b"] as const) {
        names[machine] = `proof-${machine}`;
        const renamed = await as(machine, ["machine", "rename", machineId(machine), names[machine]]);
        assert.equal(renamed.code, 0, renamed.stdout + renamed.stderr);
      }
      let machines: any[] = [];
      for (let attempt = 0; attempt < 40 && machines.filter((row) => row.capacity).length < 2; attempt++) { machines = (await as("a", ["machine", "list", "--json"])).envelope.result ?? []; await sleep(250); }
      const capacity = Object.fromEntries(machines.map((row) => [row.name, row.capacity]));
      assert.equal(capacity[names.a]?.total_bytes, 8 * GIB); assert.equal(capacity[names.a]?.room_bytes, 6 * GIB, "75% of 8 GiB");
      assert.equal(capacity[names.b]?.total_bytes, 16 * GIB); assert.equal(capacity[names.b]?.room_bytes, 12 * GIB);
    }));
    checks.push(await ctx.check("a create from A with no option lands on A and says why", async () => {
      const created = await createSandbox(ctx.root, "a", ["--cpus", "1", "--memory", "2G"]);
      transcript.push(`$ [a] localbox sandbox create --cpus 1 --memory 2G --json\n${created.stdout}`);
      assert.equal(created.envelope.result.produced.machine, names.a);
      assert.equal(created.envelope.result.produced.placement_reason, `on ${names.a}, this machine (6 GiB free)`);
      onA.push(created.envelope.result.produced.name);
    }));
    checks.push(await ctx.check("--placement auto from A lands on B, the machine with the most room", async () => {
      const created = await as("a", ["sandbox", "create", "--placement", "auto", "--cpus", "1", "--memory", "2G", "--json"]);
      assert.equal(created.envelope.ok, true, created.stdout + created.stderr);
      assert.equal(created.envelope.result.produced.machine, names.b);
      assert.match(created.envelope.result.produced.placement_reason, new RegExp(`^on ${names.b}, the machine with the most room \\(12 GiB free\\)`));
      const text = await as("a", ["sandbox", "create", "--placement", "remote", "--cpus", "1", "--memory", "2G"]);
      assert.equal(text.code, 0, text.stderr); assert.match(text.stdout, new RegExp(`placement_reason: on ${names.b}, the remote machine with the most room`));
    }));
    checks.push(await ctx.check("a CLI with no local daemon fails with no option, listing both machines with their room", async () => {
      const bare = mkdtempSync(join(tmpdir(), "localbox-proof-11-nodaemon-"));
      try {
        mkdirSync(bare, { recursive: true }); copyFileSync(join(machineRoot(ctx.root, "a"), "credentials.json"), join(bare, "credentials.json"));
        const refused = await as("a", ["sandbox", "create", "--json"], { LOCALBOX_MACHINE_ROOT: bare });
        assert.equal(refused.envelope.ok, false, refused.stdout);
        assert.equal(refused.envelope.error.code, "invalid_input");
        assert.match(refused.envelope.error.message, /name a machine or use --placement auto/);
        for (const name of [names.a, names.b]) assert.match(refused.envelope.error.message, new RegExp(`${name} \\(\\d+(\\.\\d)? GiB free of \\d+ GiB\\)`));
        assert.deepEqual(refused.envelope.error.details.machines.map((row: any) => row.name).sort(), [names.a, names.b].sort());
        const text = await as("a", ["sandbox", "create"], { LOCALBOX_MACHINE_ROOT: bare });
        assert.notEqual(text.code, 0); assert.match(text.stdout + text.stderr, /name a machine or use --placement auto/);
      } finally { rmSync(bare, { recursive: true, force: true }); }
    }));
    checks.push(await ctx.check("A filled to 75% (three 2 GiB sandboxes): one more start sleeps the least recently used and says so", async () => {
      for (let index = 0; index < 2; index++) {
        const created = await as("a", ["sandbox", "create", "--cpus", "1", "--memory", "2G", "--json"]);
        assert.equal(created.envelope.ok, true, created.stdout + created.stderr); assert.deepEqual(madeRoom(created.envelope), [], "it still fits");
        onA.push(created.envelope.result.produced.name);
      }
      const fourth = await as("a", ["sandbox", "create", "--cpus", "1", "--memory", "2G", "--json"]);
      assert.equal(fourth.envelope.ok, true, fourth.stdout + fourth.stderr);
      assert.equal(fourth.envelope.result.produced.machine, names.a, "a full default machine is still chosen: it makes room");
      assert.deepEqual(madeRoom(fourth.envelope), [`slept ${onA[0]} (2 GiB) to make room`]);
      assert.deepEqual(fourth.envelope.result.actions.map((action: any) => action.kind), ["created", "made_room", "cold_booted"]);
      onA.push(fourth.envelope.result.produced.name);
      // Waking the slept one makes room again, from the next least recently used.
      const woke = await as("a", ["sandbox", "start", onA[0]]);
      assert.equal(woke.code, 0, woke.stdout + woke.stderr);
      assert.match(woke.stdout, new RegExp(`^- made_room: slept ${onA[1]} \\(2 GiB\\) to make room$`, "m")); assert.match(woke.stdout, /^- woke: /m);
      let listed: any[] = [];
      for (let attempt = 0; attempt < 40; attempt++) { listed = (await as("b", ["sandbox", "list", "--json"])).envelope.result.sandboxes; if (listed.find((row) => row.name === onA[1])?.state === "sleeping") break; await sleep(250); }
      assert.deepEqual(Object.fromEntries(listed.filter((row) => row.machine_name === names.a).map((row) => [row.name, row.state])), { [onA[0]]: "running", [onA[1]]: "sleeping", [onA[2]]: "running", [onA[3]]: "running" });
      const capacity = (await as("b", ["machine", "list", "--json"])).envelope.result.find((row: any) => row.name === names.a).capacity;
      assert.equal(capacity.room_bytes, 0); assert.equal(capacity.reserved_bytes, 6 * GIB); assert.equal(capacity.running, 3);
    }));
    return checks;
  } finally {
    writeFileSync(join(ctx.evidence, "11-transcript.txt"), transcript.join("\n"));
    for (const child of Object.values(setup?.connectors ?? {})) stopConnector(child);
    if (!ctx.keep) await ctx.stack("down");
  }
}

/**
 * Machine A real (Apple backend, minimal image) with the admission budget capped at 6 GiB: three 2 GiB sandboxes
 * fill it, a fourth start sleeps the least recently used one, and the VM service memory it held is measured.
 */
async function realVMs(ctx: ProofContext): Promise<Check[]> {
  const { machine, start, ok, sh, record, vmRSS, cleanup } = realDaemon(ctx, { probe: "11", env: { LOCALBOX_DEV_ADMISSION_BYTES: String(6 * GIB) } });
  const locked = screenLocked();
  const evidence: Record<string, unknown> = { machine_root: machine, screen_locked: locked, admission_bytes: 6 * GIB };
  const ids = ["sandbox_p11_alpha", "sandbox_p11_beta", "sandbox_p11_gamma", "sandbox_p11_delta"];
  const names = ["alpha-otter", "beta-heron", "gamma-lynx", "delta-wren"];
  const checks: Check[] = [];
  try {
    checks.push(await ctx.check("the minimal image, the host daemon and its signature are built; the daemon runs with a 6 GiB admission budget", async () => {
      await start(await buildRealVMs(ctx));
      const capacity = (await ok("host.watch", null, { since: 0 })).capacity;
      evidence.capacity_empty = capacity;
      assert.equal(capacity.room_bytes, 6 * GIB);
    }));
    checks.push(await ctx.check("three 2 GiB sandboxes boot; the first, least recently used, holds 1000 MiB of written memory", async () => {
      for (const [index, sandboxId] of ids.slice(0, 3).entries()) {
        const created = await ok("sandbox.create", sandboxId, { name: names[index], cpus: 2, memory_bytes: 2 * GIB });
        assert.deepEqual(created.actions.map((action: any) => action.kind), ["created", "cold_booted"], JSON.stringify(created));
        // Fill alpha's memory before the others boot, so it is the least recently used and its VM holds real RAM.
        // Random bytes, because macOS compresses a VM's zero pages out of its resident size.
        if (index === 0) evidence.alpha_fill = await sh(sandboxId, "head -c 1000M /dev/urandom > /dev/shm/fill; ls -l /dev/shm/fill; free -m | head -2");
      }
      const capacity = (await ok("host.watch", null, { since: 0 })).capacity;
      evidence.capacity_full = capacity;
      assert.equal(capacity.room_bytes, 0); assert.equal(capacity.running, 3);
    }));
    checks.push(await ctx.check(locked ? "a fourth start stops the least recently used (hibernate unavailable while the screen is locked) and its VM's RAM is released" : "a fourth start hibernates the least recently used and its VM's RAM is released", async () => {
      const before = vmRSS();
      assert.equal(before.size, 3, `one VM service per running sandbox: ${JSON.stringify([...before])}`);
      const created = await ok("sandbox.create", ids[3], { name: names[3], cpus: 2, memory_bytes: 2 * GIB });
      evidence.fourth_create = created;
      await sleep(2_000);
      const after = vmRSS();
      const gone = [...before.keys()].filter((pid) => !after.has(pid));
      evidence.vm_rss_kb_before = Object.fromEntries(before); evidence.vm_rss_kb_after = Object.fromEntries(after);
      evidence.vm_rss_total_kb_before = [...before.values()].reduce((sum, kb) => sum + kb, 0); evidence.vm_rss_total_kb_after = [...after.values()].reduce((sum, kb) => sum + kb, 0);
      assert.equal(gone.length, 1, `exactly one VM service exited: before ${JSON.stringify([...before])}, after ${JSON.stringify([...after])}`);
      evidence.released_kb = before.get(gone[0]);
      assert.ok((before.get(gone[0]) ?? 0) > 768 * 1024, `the slept VM held the memory it wrote, over 768 MiB (it held ${before.get(gone[0])} KiB)`);
      const made = created.actions.filter((action: any) => action.kind === "made_room").map((action: any) => action.detail);
      assert.deepEqual(made, [locked ? `stopped ${names[0]} (2 GiB) to make room: hibernate unavailable while the screen is locked` : `slept ${names[0]} (2 GiB) to make room`]);
      const slept = record(ids[0]); evidence.alpha_record = slept;
      // Asleep either way: it waits for its next use, which restores it or (locked) cold-boots it and says why.
      assert.equal(slept.lifecycle, "asleep");
      if (locked) assert.equal(slept.cold_boot_pending, "could not save its state: hibernate unavailable while the screen is locked");
      assert.equal((await ok("sandbox.status", ids[3])).state, "running");
      const capacity = (await ok("host.watch", null, { since: 0 })).capacity;
      evidence.capacity_after = capacity;
      assert.equal(capacity.reserved_bytes, 6 * GIB); assert.equal(capacity.running, 3);
    }));
  } finally {
    await cleanup();
    writeFileSync(join(ctx.evidence, "11-placement-capacity.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  return checks;
}
