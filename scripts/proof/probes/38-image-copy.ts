import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { sha256 } from "../../release.js";
import { seedReadyImage } from "../lib/images.js";
import { machineAccess } from "../lib/machine-access.js";
import { stopConnector } from "../lib/login.js";
import { cli, signedInWithSandboxes } from "../lib/sandboxes.js";

export const id = "38";
export const tiers = ["u", "l", "x"];

const MiB = 1024 ** 2;
/** Big enough that the real transfer (gigabits a second over this Mac's LAN address) can be stopped midway. */
const SIZE = 1024 * MiB;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `image copy NAME --to M`: the copy's Convex row is the rendezvous, both Macs journal their side, the receiver
 * commits and its holding turns ready. Tier l runs two fixture daemons on this Mac copying through the real transport
 * (ImageTransfer over this Mac's network address); tier x (two Macs on different networks) is a runbook step.
 */
export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("copy rendezvous in Convex (lifecycle, key visible only to the two Macs, 24 h expiry), the relay's image copy, the connector's exchange", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/copy-rendezvous.test.ts", "tests/image-copy-relay.test.ts", "tests/connector.test.ts", "tests/relay-convex.test.ts", "tests/catalog-routing.test.ts", "tests/convex-auth.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2500));
    })];
  }
  if (ctx.tier === "x") {
    return [await ctx.check("image copy between the user's two Macs on different networks", () => {
      throw new Error("blocked: needs the user's second Mac on another network; follow the two-Mac runbook (specs/durable-sandboxes/two-mac-runbook.md) with `localbox image copy NAME --to MACHINE`");
    })];
  }
  return await loopback(ctx);
}

async function loopback(ctx: ProofContext): Promise<Check[]> {
  const up = await ctx.stack("up", ["a", "b"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const run = Date.now(); const connectors: Record<string, ChildProcess | undefined> = {};
  const name = `copy-${String(run).slice(-6)}`; const mutation = `p38-${run}`;
  const evidence: string[] = []; const planted: string[] = [];
  try {
    const checks: Check[] = [];
    let a!: Awaited<ReturnType<typeof machineAccess>>; let b!: Awaited<ReturnType<typeof machineAccess>>;
    let imageId = ""; let digest = ""; let first: any;
    const journal = (machine: typeof a) => { const path = join(machine.paths.operations, `${mutation}.json`); return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined; };
    const plant = async (imageName: string, capture: string) => {
      const { imageId: id, files } = await seedReadyImage(b, { name: imageName, createMutationId: capture, disk: { bytes: SIZE, random: true } });
      planted.push(files, join(a.paths.images, id));
      return id;
    };
    checks.push(await ctx.check("A and B sign in; B holds a 1 GiB image (its files in B's image store, its holding ready)", async () => {
      const setup = await signedInWithSandboxes(ctx.root, ["a", "b"], `proof-38-${run}@example.com`, { create: false });
      Object.assign(connectors, setup.connectors);
      a = await machineAccess(ctx.root, "a"); b = await machineAccess(ctx.root, "b");
      imageId = await plant(name, `p38-capture-${run}`);
      digest = await sha256(join(b.paths.images, imageId, "disk.img"));
    }));
    checks.push(await ctx.check("from A, image copy NAME --to A answers at once: copying, both Macs journal their side under the copy's mutation id", async () => {
      const started = await cli(ctx.root, "a", ["image", "copy", name, "--to", a.machineName, "--mutation-id", mutation, "--json"]);
      assert.equal(started.envelope.ok, true, started.stdout + started.stderr);
      first = started.envelope.result;
      assert.deepEqual([first.state, first.name, first.image], ["copying", name, imageId], JSON.stringify(first));
      evidence.push(`$ localbox image copy ${name} --to ${a.machineName} --json\n${started.stdout}`);
      for (const machine of [a, b]) assert.equal(journal(machine)?.kind, "image.copy", `${machine.machineName} journaled its side`);
    }));
    let before = 0;
    checks.push(await ctx.check("A (the receiver) is killed mid-copy and restarted: its side resumes from the transfer's bitmap, not from the start", async () => {
      // Killed once the transfer has saved its resume bitmap beside the temporary (every half second) and 64 MiB are in.
      const bitmap = join(a.paths.images, `.${imageId}.resume-${mutation}.resume`);
      for (let waited = 0; before < 64 * MiB || !existsSync(bitmap); waited += 20) {
        if (waited > 60_000) throw new Error(`the receiver never got 64 MiB in with a bitmap saved: ${JSON.stringify(journal(a))}`);
        await sleep(20); before = journal(a)?.progress?.completed ?? 0;
      }
      assert.ok(before < SIZE, "still copying when killed");
      const restarted = await ctx.stack("restart", ["a"]);
      assert.equal(restarted.code, 0, restarted.stderr);
      for (let waited = 0; ; waited += 100) {
        if (readFileSync(join(a.paths.logs, "hostd.log"), "utf8").includes(`operation ${mutation} resumed`)) break;
        if (waited > 15_000) throw new Error("A's daemon never resumed the copy");
        await sleep(100);
      }
    }));
    checks.push(await ctx.check("image wait follows the copy until it is ready; A's files match B's", async () => {
      for (let attempt = 0; ; attempt++) {
        const waited = await cli(ctx.root, "a", ["image", "wait", name, "--timeout-ms", "20000", "--json"]);
        assert.equal(waited.envelope.ok, true, waited.stdout + waited.stderr);
        if (waited.envelope.result.state === "ready") break;
        assert.equal(waited.envelope.result.state, "copying", JSON.stringify(waited.envelope.result));
        if (attempt > 6) throw new Error(`still copying after ${attempt} waits: ${JSON.stringify(waited.envelope.result)}`);
      }
      assert.equal(await sha256(join(a.paths.images, imageId, "disk.img")), digest);
      const received = journal(a); const sent = journal(b);
      assert.deepEqual([received.state, received.result.role, received.result.path, sent.state, sent.result.role], ["succeeded", "receiver", "local_network", "succeeded", "sender"], JSON.stringify({ received, sent }));
      assert.ok(received.result.bytes < SIZE, `the resumed side moved ${received.result.bytes} bytes, less than the whole image`);
    }));
    checks.push(await ctx.check("a replay of the copy's mutation returns the same operation, now with size, duration and path", async () => {
      const startedAt = journal(a).started_at;
      const replay = await cli(ctx.root, "a", ["image", "copy", name, "--to", a.machineName, "--mutation-id", mutation]);
      assert.equal(replay.code, 0, replay.stdout + replay.stderr);
      const lines = replay.stdout.trimEnd().split("\n");
      assert.match(lines[0], new RegExp(`^copied image ${name} from ${b.machineName} to ${a.machineName} \\(1 GiB, (?:[\\d.]+ s|\\d+ min \\d+ s), local network\\)$`));
      assert.equal(lines[1], `start a sandbox from it there: localbox sandbox create --image ${name} --machine ${a.machineName}`);
      assert.equal(journal(a).started_at, startedAt, "the same journal record, never a second run");
      evidence.push(`$ localbox image copy ${name} --to ${a.machineName} (replay)\n${replay.stdout}`);
    }));
    checks.push(await ctx.check("image list shows both holders, neither still copying", async () => {
      for (let waited = 0; ; waited += 250) {
        const listed = await cli(ctx.root, "a", ["image", "list", "--json"]);
        const row = listed.envelope.result?.images?.find((candidate: any) => candidate.name === name);
        if (row && [...row.on].sort().join(",") === [a.machineName, b.machineName].sort().join(",")) break;
        if (waited > 10_000) throw new Error(`image list never showed ${name} on both: ${listed.stdout}`);
        await sleep(250);
      }
      const text = await cli(ctx.root, "a", ["image", "list"]);
      evidence.push(`$ localbox image list\n${text.stdout}`);
    }));
    checks.push(await ctx.check("an uninterrupted copy of another 1 GiB image through both daemons reports its size, duration and path", async () => {
      const second = `${name}-b`; const secondId = await plant(second, `p38-capture-b-${run}`);
      const started = Date.now();
      const copied = await cli(ctx.root, "a", ["image", "copy", second, "--to", a.machineName, "--mutation-id", `${mutation}-b`, "--json"]);
      assert.equal(copied.envelope.ok, true, copied.stdout + copied.stderr);
      for (let attempt = 0; ; attempt++) {
        const waited = await cli(ctx.root, "a", ["image", "wait", second, "--timeout-ms", "20000", "--json"]);
        assert.equal(waited.envelope.ok, true, waited.stdout + waited.stderr);
        if (waited.envelope.result.state === "ready") break;
        if (attempt > 6) throw new Error(`still copying after ${attempt} waits: ${JSON.stringify(waited.envelope.result)}`);
      }
      const wall = Date.now() - started;
      const done = JSON.parse(readFileSync(join(a.paths.operations, `${mutation}-b.json`), "utf8"));
      assert.equal(done.result.path, "local_network");
      assert.equal(await sha256(join(a.paths.images, secondId, "disk.img")), await sha256(join(b.paths.images, secondId, "disk.img")));
      const gbps = (bytes: number, ms: number) => (bytes * 8 / (ms / 1000) / 1e9).toFixed(2);
      evidence.push(`uninterrupted copy: ${SIZE} bytes; receiver side ${done.result.duration_ms} ms (${gbps(SIZE, done.result.duration_ms)} Gbps), request to ready ${wall} ms (${gbps(SIZE, wall)} Gbps)`);
    }));
    return checks;
  } finally {
    writeFileSync(join(ctx.evidence, "38-image-copy.txt"), evidence.join("\n"));
    for (const child of Object.values(connectors)) stopConnector(child);
    if (!ctx.keep) { await ctx.stack("down"); for (const files of planted) rmSync(files, { recursive: true, force: true }); }
  }
}
