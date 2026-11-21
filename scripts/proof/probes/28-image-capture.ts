import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { buildRealVMs, realDaemon } from "../lib/real-daemon.js";
import { machineAccess } from "../lib/machine-access.js";
import { machineRoot, stopConnector } from "../lib/login.js";
import { machinePaths } from "../../../packages/config/src/machine-paths.js";
import { cli, sandboxRecords, signedInWithSandboxes } from "../lib/sandboxes.js";

export const id = "28";
export const tiers = ["u", "l", "v"];

const GIB = 1024 ** 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `image create --from`: a sandbox's disk saved as an image after a short freeze, reported in the map's four lines. */
export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("image create through the relay: routing to the source's machine, the reservation, the result lines; CLI rendering", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/image-capture-relay.test.ts", "tests/catalog-routing.test.ts", "tests/cli-output.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2500));
    })];
  }
  if (ctx.tier === "l") return await fixtureDaemon(ctx);
  return await realVMs(ctx);
}

/**
 * The local stack with fixture daemons: the CLI's `image create --from` reaches Convex, the relay, the connector and
 * the daemon's `image.capture`. A fixture guest has no disk and no control lane, so the sandbox is stopped and given a
 * disk and boot store to save (the stopped path clones without a freeze); tier v freezes a real one.
 */
async function fixtureDaemon(ctx: ProofContext): Promise<Check[]> {
  const up = await ctx.stack("up", ["a"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const run = Date.now(); let connectors: Record<string, ChildProcess> = {};
  const image = `saved-${String(run).slice(-6)}`; const mutation = `p28-${run}`;
  const paths = machinePaths({ LOCALBOX_MACHINE_ROOT: machineRoot(ctx.root, "a") });
  try {
    const checks: Check[] = [];
    let source = ""; let lines: string[] = []; let imageId = "";
    checks.push(await ctx.check("A signs in with a sandbox, which is stopped and given a disk and boot store", async () => {
      const setup = await signedInWithSandboxes(ctx.root, ["a"], `proof-28-${run}@example.com`);
      connectors = setup.connectors; source = setup.sandboxes.a;
      const stopped = await cli(ctx.root, "a", ["sandbox", "stop", source, "--json"]);
      assert.equal(stopped.envelope.ok, true, stopped.stdout + stopped.stderr);
      const record = sandboxRecords(ctx.root, "a").find((row) => row.name === source)!;
      const directory = join(paths.sandboxes, record.sandbox_id);
      writeFileSync(join(directory, "disk.img"), Buffer.alloc(2 * 1024 * 1024, 7)); writeFileSync(join(directory, "efi-vars"), "efi");
    }));
    checks.push(await ctx.check("image create --from prints the four result lines: saved, how the source got through it, where it lives, the next command", async () => {
      const created = await cli(ctx.root, "a", ["image", "create", "--from", source, "--name", image, "--mutation-id", mutation]);
      assert.equal(created.code, 0, created.stdout + created.stderr);
      lines = created.stdout.trimEnd().split("\n");
      const { machineName } = await machineAccess(ctx.root, "a");
      assert.equal(lines.length, 4, created.stdout);
      assert.match(lines[0], new RegExp(`^image ${image} saved from sandbox ${source} \\(linux, \\d+ (MiB|B)\\)$`));
      assert.equal(lines[1], `${source} was stopped, so its disk was saved as it lay, without a freeze`);
      assert.match(lines[2], new RegExp(`^on machine ${machineName}; copies to other Macs on first use$`));
      assert.equal(lines[3], `start a sandbox from it: localbox sandbox create --image ${image}`);
      writeFileSync(join(ctx.evidence, "28-image-create.txt"), created.stdout);
    }));
    checks.push(await ctx.check("a replay with the same mutation id returns the same operation: same lines, one journal record, one image on disk", async () => {
      const replay = await cli(ctx.root, "a", ["image", "create", "--from", source, "--name", image, "--mutation-id", mutation, "--json"]);
      assert.equal(replay.envelope.ok, true, replay.stdout + replay.stderr);
      assert.deepEqual(replay.envelope.result.report, lines);
      imageId = replay.envelope.result.image;
      const journal = JSON.parse(readFileSync(join(paths.operations, `${mutation}.json`), "utf8"));
      assert.deepEqual([journal.kind, journal.subject, journal.state], ["image.capture", imageId, "succeeded"]);
      assert.equal(readdirSync(paths.operations).filter((name) => name.endsWith(".json")).length, 1);
      assert.ok(existsSync(join(paths.images, imageId, "image.json")) && existsSync(join(paths.images, imageId, "boot", "efi-vars")));
    }));
    checks.push(await ctx.check("the connector reports the holding ready with its size, so image list shows it on A", async () => {
      for (let waited = 0; ; waited += 250) {
        const listed = await cli(ctx.root, "a", ["image", "list", "--json"]);
        const row = listed.envelope.result?.images?.find((candidate: any) => candidate.name === image);
        if (row && row.size_bytes !== null && !row.on.some((holder: string) => holder.includes("("))) { assert.equal(row.from, `sandbox ${source}`); break; }
        if (waited > 15_000) throw new Error(`image list never showed ${image} ready: ${listed.stdout}`);
        await sleep(250);
      }
    }));
    return checks;
  } finally {
    for (const child of Object.values(connectors)) stopConnector(child);
    if (!ctx.keep) await ctx.stack("down");
  }
}

/**
 * A real daemon and a real sandbox: a file written a second before the capture is in a sandbox made from the image,
 * which has its own machine-id, and the source stalled under 2 s. Sandbox create from an image is slice 29's, so the
 * new sandbox is provisioned from the image by vmlab, through the daemon's own `AppleSandboxFactory`.
 */
async function realVMs(ctx: ProofContext): Promise<Check[]> {
  const { machine, start, call, ok, sh, cleanup } = realDaemon(ctx, { probe: "28" });
  const sandboxId = "sandbox_p28_source", imageId = "image_p28";
  const evidence: Record<string, unknown> = {};
  const checks: Check[] = [];
  let bin = ""; let sourceMachineId = ""; let record: any = {};
  try {
    checks.push(await ctx.check("the minimal image, the host daemon and its signature are built", async () => {
      bin = await buildRealVMs(ctx); await start(bin);
    }));
    checks.push(await ctx.check("a running sandbox writes a file; a second later image create saves it, stalling the sandbox under 2 s, and it keeps running", async () => {
      await ok("sandbox.create", sandboxId, { name: "bold-otter", image: "linux", cpus: 2, memory_bytes: 2 * GIB, sleep_after_ms: 3_600_000 });
      sourceMachineId = await sh(sandboxId, "cat /etc/machine-id");
      await sh(sandboxId, "echo written-before-capture > /root/p28-marker");
      await sleep(1_000);
      const created = await call("image.create", null, { from: sandboxId, image: imageId });
      assert.equal(created.ok, true, JSON.stringify(created).slice(0, 1500));
      record = (created as any).result;
      evidence.operation = record;
      assert.equal(record.state, "succeeded", JSON.stringify(record));
      assert.equal(typeof record.result.stall_ms, "number");
      assert.ok(record.result.stall_ms < 2_000, `stalled ${record.result.stall_ms} ms`);
      assert.equal(record.result.disk, "cloned");
      const status = await ok("sandbox.status", sandboxId);
      assert.equal(status.lifecycle, "ready", "running again after the thaw");
      assert.equal(await sh(sandboxId, "echo after > /root/p28-after && cat /root/p28-after"), "after", "and writes again");
      const manifest = JSON.parse(readFileSync(join(machine, "images", imageId, "image.json"), "utf8"));
      evidence.manifest = manifest;
      assert.equal(manifest.os, "linux"); assert.equal(manifest.size_bytes, record.result.size_bytes);
      await ok("sandbox.stop", sandboxId);
    }));
    checks.push(await ctx.check("a sandbox made from the image has the file, and a new machine-id", async () => {
      const result = await ctx.exec(join(bin, "localbox-vmlab"), ["boot", "--image", join(machine, "images", imageId), "--command", "cat /root/p28-marker; cat /etc/machine-id", "--json"]);
      const booted = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
      evidence.new_sandbox = booted;
      assert.equal(booted.ok, true, result.stdout.slice(-1500) + result.stderr.slice(-1500));
      const [marker, machineId] = String(booted.stdout).trim().split("\n");
      assert.equal(marker, "written-before-capture");
      assert.match(machineId, /^[0-9a-f]{32}$/);
      assert.notEqual(machineId, sourceMachineId, "identity regenerated for the new sandbox");
      evidence.source_machine_id = sourceMachineId;
    }));
  } finally {
    await cleanup();
    const directory = join(ctx.root, "specs/sandbox-images/evidence"); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "28-image-capture.json"), `${JSON.stringify({ checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })), stall_ms: record?.result?.stall_ms ?? null, ...evidence }, null, 2)}\n`);
  }
  return checks;
}
