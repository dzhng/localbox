import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { seedReadyImage } from "../lib/images.js";
import { machineAccess } from "../lib/machine-access.js";
import { stopConnector } from "../lib/login.js";
import { buildRealVMs, realDaemon } from "../lib/real-daemon.js";
import { cli, createSandbox, sandboxRecords, signedInWithSandboxes } from "../lib/sandboxes.js";

export const id = "29";
export const tiers = ["u", "l", "v"];

const GIB = 1024 ** 3;
const MACOS_GUIDANCE = "no macOS image yet; build one with: localbox image create --macos";

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("image resolution, holders and the stored image id (relay and Convex), placement and CLI output", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/sandbox-catalog.test.ts", "tests/placement.test.ts", "tests/cli-output.test.ts", "tests/images-convex.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2500));
    })];
  }
  return ctx.tier === "v" ? await realVMs(ctx) : await fixtureStack(ctx);
}

/** Two fixture Macs on the local stack: B holds an image the account makes its default; A does not hold it. */
async function fixtureStack(ctx: ProofContext): Promise<Check[]> {
  const up = await ctx.stack("up", ["a", "b"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const run = Date.now(); const name = `bold-${String(run).slice(-6)}`;
  const connectors: Record<string, ChildProcess | undefined> = {};
  const a = (args: string[]) => cli(ctx.root, "a", args);
  try {
    const checks: Check[] = [];
    let image!: { image_id: string }; let aName = ""; let bName = "";
    checks.push(await ctx.check("A and B sign in; B holds an image (files on disk, holder ready) and A makes it the account default", async () => {
      const setup = await signedInWithSandboxes(ctx.root, ["a", "b"], `proof-29-${run}@example.com`, { create: false });
      Object.assign(connectors, setup.connectors);
      // Proof machines share this Mac's host name; distinct names make `--machine` and the holder list unambiguous.
      const b = await machineAccess(ctx.root, "b"); const suffix = String(run).slice(-6);
      aName = `studio-${suffix}`; bName = `attic-${suffix}`;
      for (const [machine, id, wanted] of [["a", (await machineAccess(ctx.root, "a")).machineId, aName], ["b", b.machineId, bName]]) {
        const renamed = await cli(ctx.root, machine, ["machine", "rename", id, wanted]);
        assert.equal(renamed.code, 0, renamed.stdout + renamed.stderr);
      }
      image = { image_id: (await seedReadyImage(b, { name, createMutationId: `p29-${run}`, disk: { bytes: 1024 * 1024 }, reportedBytes: GIB })).imageId };
      const made = await a(["image", "default", name, "--json"]);
      assert.equal(made.envelope.result?.actions?.[0]?.kind, "made_default", made.stdout + made.stderr);
    }));
    checks.push(await ctx.check("sandbox create on B with no --image lands on the default image: the creation line names it and B's record keeps its id", async () => {
      const created = await createSandbox(ctx.root, "a", ["--machine", bName]);
      const report = created.envelope.result;
      assert.deepEqual([report.produced.image, report.produced.image_reason, report.produced.machine], [name, "the account default", bName]);
      const line = report.actions.find((action: any) => action.kind === "created");
      assert.match(line.detail, new RegExp(`^created ${report.produced.name} with \\d+ CPUs and \\d+ GiB; image ${name} \\(the account default\\)$`));
      assert.equal(sandboxRecords(ctx.root, "b").find((row) => row.name === report.produced.name)?.image_id, image.image_id);
      const listed = await a(["sandbox", "list", "--json"]);
      assert.equal(listed.envelope.result.sandboxes.find((row: any) => row.name === report.produced.name)?.image_id, image.image_id, "the catalog row keeps the image");
      const text = await a(["sandbox", "create", "--machine", bName, "--image", name]);
      assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, new RegExp(`created \\S+ with \\d+ CPUs and \\d+ GiB; image ${name} \\(as asked\\)`));
      writeFileSync(join(ctx.evidence, "29-create-default.txt"), `${JSON.stringify(report, null, 2)}\n\n${text.stdout}`);
    }));
    checks.push(await ctx.check("on A, which does not hold it, the create no longer refuses: it waits for the image's copy from B (probe 39 follows the copy)", async () => {
      const waiting = await a(["sandbox", "create", "--machine", aName, "--image", name, "--json"]);
      assert.equal(waiting.envelope.ok, true, waiting.stdout + waiting.stderr);
      assert.deepEqual([waiting.envelope.result.produced.state, waiting.envelope.result.produced.copying_from], ["copying", bName]);
      assert.match(waiting.envelope.result.actions[0].detail, new RegExp(`^sandbox \\S+ on ${aName} is waiting for image ${name} to copy \\(1 GiB\\); localbox image wait ${name}$`));
    }));
    checks.push(await ctx.check("--image linux works on any Mac; --image macos before any macOS build prints the guidance", async () => {
      const linux = await createSandbox(ctx.root, "a", ["--machine", aName, "--image", "linux"]);
      assert.equal(linux.envelope.result.produced.image, "linux");
      assert.equal(sandboxRecords(ctx.root, "a").find((row) => row.name === linux.envelope.result.produced.name)?.image_id, "linux");
      const macos = await a(["sandbox", "create", "--machine", aName, "--image", "macos", "--json"]);
      assert.deepEqual([macos.envelope.error?.code, macos.envelope.error?.message], ["image_not_found", MACOS_GUIDANCE]);
      const text = await a(["sandbox", "create", "--image", "macos"]);
      assert.notEqual(text.code, 0); assert.ok((text.stdout + text.stderr).includes(MACOS_GUIDANCE), text.stdout + text.stderr);
    }));
    return checks;
  } finally {
    for (const child of Object.values(connectors)) stopConnector(child);
    if (!ctx.keep) await ctx.stack("down");
  }
}

/**
 * One real daemon: a sandbox from `linux` writes a marker and stops; its disk and boot store become an image (what
 * `image create --from` does to a stopped sandbox), and two sandboxes boot from it with the marker and
 * their own identity.
 */
async function realVMs(ctx: ProofContext): Promise<Check[]> {
  const daemon = realDaemon(ctx, { probe: "29" });
  const evidence: Record<string, unknown> = { machine_root: daemon.machine };
  const imageId = `image_p29_${Date.now()}`; const source = "sandbox_p29_source"; const clones = ["sandbox_p29_one", "sandbox_p29_two"];
  const marker = `/root/made-before-capture`;
  const create = (sandboxId: string, name: string, image: string) => daemon.call("sandbox.create", sandboxId, { name, image, cpus: 2, memory_bytes: 2 * GIB, sleep_after_ms: 30 * 60_000 });
  const identity = async (sandboxId: string) => { const [machineId, mac] = (await daemon.sh(sandboxId, "cat /etc/machine-id; cat /sys/class/net/e*/address | head -1")).split("\n"); return { machineId, mac }; };
  const checks: Check[] = [];
  try {
    checks.push(await ctx.check("the dev linux image, the host daemon and its signature are built", async () => { await daemon.start(await buildRealVMs(ctx)); }));
    if (!checks[0].ok) return checks;
    checks.push(await ctx.check("a sandbox from linux writes a marker and stops; its disk and boot store are saved as an image", async () => {
      const created = await create(source, "source-otter", "linux");
      assert.equal(created.ok, true, JSON.stringify(created).slice(0, 1500));
      await daemon.sh(source, `echo captured > ${marker} && sync`);
      evidence.source_identity = await identity(source);
      await daemon.ok("sandbox.stop", source);
      const images = join(daemon.machine, "images"); const files = join(images, imageId);
      mkdirSync(join(files, "boot"), { recursive: true });
      execFileSync("cp", ["-c", join(daemon.sandboxes, source, "disk.img"), join(files, "disk.img")]);
      copyFileSync(join(daemon.sandboxes, source, "efi-vars"), join(files, "boot", "efi-vars"));
      const manifest = JSON.parse(readFileSync(join(images, "linux", "image.json"), "utf8"));
      writeFileSync(join(files, "image.json"), JSON.stringify({ ...manifest, image_id: imageId }));
    }));
    checks.push(await ctx.check("two sandboxes boot from the image: each record names it, both have the marker, and each has its own machine-id and MAC", async () => {
      const seen = { machineId: new Set([(evidence.source_identity as any).machineId]), mac: new Set([(evidence.source_identity as any).mac]) };
      for (const [index, sandboxId] of clones.entries()) {
        const created = await create(sandboxId, `clone-${index}`, imageId);
        assert.equal(created.ok, true, JSON.stringify(created).slice(0, 1500));
        evidence[`${sandboxId}_create`] = (created as any).result;
        assert.equal((created as any).result.produced.disk, "cloned");
        assert.equal(daemon.record(sandboxId).image_id, imageId);
        assert.equal(await daemon.sh(sandboxId, `cat ${marker}`), "captured", "the disk is the saved one");
        const own = await identity(sandboxId); evidence[`${sandboxId}_identity`] = own;
        assert.match(own.machineId, /^[0-9a-f]{32}$/); assert.equal(own.mac, daemon.record(sandboxId).mac);
        seen.machineId.add(own.machineId); seen.mac.add(own.mac);
      }
      assert.equal(seen.machineId.size, 3, "machine-id regenerated in each sandbox"); assert.equal(seen.mac.size, 3, "a new MAC for each");
    }));
    checks.push(await ctx.check("an image this Mac does not hold is refused image_not_found and leaves no directory", async () => {
      const refused = await create("sandbox_p29_absent", "absent", "image_absent");
      assert.equal(!refused.ok && refused.error.code, "image_not_found", JSON.stringify(refused));
      assert.equal(!refused.ok && refused.error.message, "could not lay down absent: image image_absent is not on this Mac");
      assert.equal(existsSync(join(daemon.sandboxes, "sandbox_p29_absent")), false);
    }));
  } finally {
    await daemon.cleanup();
    writeFileSync(join(ctx.evidence, "29-create-from-image.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  return checks;
}
