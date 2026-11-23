import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { cachedIpsw, vmlab } from "../lib/macos-lab.js";
import { realDaemon } from "../lib/real-daemon.js";
import { buildGuestAgent } from "../../build-guest-agent.js";

export const id = "45";
export const tiers = ["u", "s", "v", "m"];

const GIB = 1024 ** 3;

/**
 * Disk size chosen per image and per sandbox. Tier u: the contract, CLI, relay and catalog carry `disk_bytes`. Tier s:
 * the GPT code, the recovery partition, the grow and the guest's claim, on fake VMs. Tier v: a Linux sandbox made with a
 * larger disk than its image's shows the larger root in `df`, a resize grows it again, an image saved from it keeps the
 * size (or a larger one asked for, which the next sandbox grows to), and a smaller disk than the image's is refused.
 * Tier m: a macOS base built at a non-default size has no recovery container, and a sandbox from it with a larger disk
 * shows the grown container.
 */
export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("disk_bytes through the contract, the CLI, the relay and the catalog", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/contract.test.ts", "tests/sandbox-catalog.test.ts", "tests/image-capture-relay.test.ts", "tests/macos-build-relay.test.ts", "tests/image-catalog.test.ts", "tests/cli-output.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2500));
    })];
  }
  if (ctx.tier === "s") {
    return [await ctx.check("GPT, recovery partition, grow and claim; sandbox, capture and build disk sizes on fake VMs", async () => {
      const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "GPTTests|DiskGrowthTests|SandboxDiskTests|ImageCaptureTests|MacBaseBuilderTests"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2500));
    })];
  }
  return ctx.tier === "v" ? await linux(ctx) : await macos(ctx);
}

/** The daemon's binaries, built and signed with the virtualization entitlement (ad hoc). */
async function signedDaemon(ctx: ProofContext): Promise<string> {
  const build = await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon"]); assert.equal(build.code, 0, build.stderr.slice(-1500));
  assert.equal((await ctx.exec("sh", ["scripts/proof/lib/sign-dev.sh"])).code, 0, "sign the dev build");
  return (await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim();
}

/** A daemon whose HOME is a scratch directory, so nothing it starts touches this Mac's own. */
function scratchDaemon(ctx: ProofContext, probe: string, env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), `localbox-proof-${probe}-home-`));
  const daemon = realDaemon(ctx, { probe, env: { HOME: home, LOCALBOX_CLI: "", ...env } });
  return { daemon, cleanup: async () => { await daemon.cleanup(); rmSync(home, { recursive: true, force: true }); } };
}

/** `df` of the root in bytes: its size and what is free. */
async function rootSize(sh: (command: string) => Promise<string>): Promise<{ size: number; free: number }> {
  const [size, free] = (await sh("df -k / | awk 'NR==2 {print $2, $4}'")).split(" ").map((field) => Number(field) * 1024);
  return { size, free };
}

async function linux(ctx: ProofContext): Promise<Check[]> {
  const { daemon, cleanup } = scratchDaemon(ctx, "45");
  const evidence: Record<string, unknown> = {};
  const checks: Check[] = [];
  const base = { cpus: 2, memory_bytes: 2 * GIB, sleep_after_ms: 3_600_000 };
  const a = "sandbox_p45_a", b = "sandbox_p45_b", c = "sandbox_p45_c";
  const saved = `image_p45_${Date.now()}`, larger = `image_p45l_${Date.now()}`;
  let imageDisk = 0;
  try {
    checks.push(await ctx.check("the daemon starts with the dev linux image, whose manifest records its disk size", async () => {
      await daemon.start(await signedDaemon(ctx));
      const manifest = JSON.parse(readFileSync(join(daemon.machine, "images", "linux", "image.json"), "utf8"));
      imageDisk = manifest.disk_bytes;
      assert.equal(imageDisk, Number(execFileSync("stat", ["-f", "%z", join(daemon.machine, "images", "linux", "disk.img")], { encoding: "utf8" }).trim()), "the disk's length");
      evidence.image_disk_bytes = imageDisk;
    }));
    if (!checks[0].ok) return checks;

    checks.push(await ctx.check("the image ships the tools the guest grows its root with", async () => {
      const created = await daemon.ok("sandbox.create", a, { name: "disk-a", image: "linux", ...base, disk_bytes: 16 * GIB });
      evidence.create = created;
      assert.equal(created.produced.disk_bytes, 16 * GIB);
      evidence.tools = await daemon.sh(a, "for t in resize2fs findmnt /usr/lib/systemd/systemd-growfs; do command -v $t || ls $t 2>/dev/null || echo \"missing $t\"; done; findmnt -n -o SOURCE,FSTYPE /");
      assert.doesNotMatch(String(evidence.tools), /missing (resize2fs|findmnt)/);
    }));

    checks.push(await ctx.check("a sandbox created with --disk 16G, twice its image's, sees a 16 GiB root in df", async () => {
      const boot = (evidence.create as any).actions.find((action: any) => action.kind === "cold_booted");
      assert.match(boot.detail, /its filesystem grew into its 16 GiB disk$/);
      const root = await rootSize((command) => daemon.sh(a, command)); evidence.df_created = root;
      assert.ok(root.size > 15 * GIB && root.size <= 16 * GIB, `df says ${root.size}`);
      evidence.partitions_created = await daemon.sh(a, "lsblk -b -o NAME,SIZE,TYPE,MOUNTPOINT /dev/vda");
      assert.equal(daemon.record(a).disk_claim_pending, false);
      const allocated = Number(execFileSync("stat", ["-f", "%b", join(daemon.sandboxes, a, "disk.img")], { encoding: "utf8" }).trim()) * 512;
      evidence.host_allocated_bytes = allocated;
      assert.ok(allocated < 8 * GIB, `the grown disk stays sparse on the Mac: ${allocated} bytes allocated`);
    }));

    checks.push(await ctx.check("sandbox resize --disk 20G restarts it and its root grows again; a smaller disk is refused", async () => {
      await daemon.sh(a, "echo kept > /root/marker && sync");
      const resized = await daemon.ok("sandbox.resize", a, { disk_bytes: 20 * GIB });
      evidence.resize = resized.actions;
      assert.match(resized.actions[0].detail, /^restarted disk-a at 2 CPUs, 2 GiB of memory and 20 GiB of disk; .*; its filesystem grew into its 20 GiB disk$/);
      const root = await rootSize((command) => daemon.sh(a, command)); evidence.df_resized = root;
      assert.ok(root.size > 19 * GIB && root.size <= 20 * GIB, `df says ${root.size}`);
      assert.equal(await daemon.sh(a, "cat /root/marker"), "kept", "the disk's contents survive");
      const shrink = await daemon.call("sandbox.resize", a, { disk_bytes: 18 * GIB });
      assert.equal(!shrink.ok && shrink.error.message, "a sandbox's disk only grows: disk-a's is 20 GiB, and 18 GiB was asked for");
    }));

    checks.push(await ctx.check("an image saved from it keeps 20 GiB as its minimum; a sandbox from it gets 20 GiB with no --disk", async () => {
      await daemon.ok("sandbox.stop", a);
      const captured = await daemon.ok("image.create", null, { from: a, image: saved });
      assert.equal(captured.state, "succeeded", JSON.stringify(captured).slice(0, 1500));
      assert.equal(captured.result.disk_bytes, 20 * GIB);
      assert.equal(JSON.parse(readFileSync(join(daemon.machine, "images", saved, "image.json"), "utf8")).disk_bytes, 20 * GIB);
      const created = await daemon.ok("sandbox.create", b, { name: "disk-b", image: saved, ...base });
      assert.equal(created.produced.disk_bytes, 20 * GIB);
      const root = await rootSize((command) => daemon.sh(b, command)); evidence.df_from_saved = root;
      assert.ok(root.size > 19 * GIB, `df says ${root.size}`);
      assert.equal(await daemon.sh(b, "cat /root/marker"), "kept");
    }));

    checks.push(await ctx.check("an image saved with a larger --disk sets that minimum, which a sandbox from it grows to at its first boot", async () => {
      const captured = await daemon.ok("image.create", null, { from: a, image: larger, disk_bytes: 24 * GIB });
      assert.equal(captured.state, "succeeded", JSON.stringify(captured).slice(0, 1500));
      assert.equal(captured.result.disk_bytes, 24 * GIB);
      const created = await daemon.ok("sandbox.create", c, { name: "disk-c", image: larger, ...base });
      assert.equal(created.produced.disk_bytes, 24 * GIB);
      const root = await rootSize((command) => daemon.sh(c, command)); evidence.df_from_larger = root;
      assert.ok(root.size > 23 * GIB && root.size <= 24 * GIB, `df says ${root.size}`);
    }));

    checks.push(await ctx.check("a disk smaller than its image's is refused, naming the image's size, and leaves nothing behind", async () => {
      const refused = await daemon.call("sandbox.create", "sandbox_p45_small", { name: "disk-small", image: larger, ...base, disk_bytes: 16 * GIB });
      assert.equal(!refused.ok && refused.error.code, "invalid_input");
      assert.equal(!refused.ok && refused.error.message, `could not create disk-small: image ${larger}'s disk is 24 GiB, the least a sandbox from it gets, and 16 GiB was asked for`);
      assert.equal(existsSync(join(daemon.sandboxes, "sandbox_p45_small")), false);
      const tooSmallImage = await daemon.call("image.create", null, { from: a, image: `image_p45s_${Date.now()}`, disk_bytes: 10 * GIB });
      assert.equal(!tooSmallImage.ok && tooSmallImage.error.message, "an image's disk can't be smaller than its sandbox's: disk-a's is 20 GiB, and 10 GiB was asked for");
    }));
  } finally {
    writeFileSync(join(ctx.evidence, "45-disk-size-linux.json"), `${JSON.stringify({ checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })), ...evidence }, null, 2)}\n`);
    await cleanup();
  }
  return checks;
}

/** A macOS base built at a size other than the default, then a sandbox from it with a larger disk still. */
async function macos(ctx: ProofContext): Promise<Check[]> {
  const version = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  if (Number(version.split(".")[0]) < 27) throw new Error(`blocked: building a macOS image needs a macOS 27 host; this Mac runs ${version}`);
  const ipsw = cachedIpsw();
  if (!ipsw) throw new Error("blocked: no cached IPSW; run npm run proof -- 16 --tier m");
  const agents = join(ctx.root, "dist/guest-agent");
  const { daemon, cleanup } = scratchDaemon(ctx, "45m", { LOCALBOX_GUEST_AGENT: agents });
  const evidence: Record<string, unknown> = { host_macos: version };
  const checks: Check[] = [];
  const image = `image_p45m${Date.now().toString(36)}`, sandbox = "sandbox_p45_mac";
  const baseDisk = 60 * GIB, sandboxDisk = 72 * GIB;
  try {
    checks.push(await ctx.check(`image create --macos --disk 60G builds a base whose disk is 60 GiB`, async () => {
      await buildGuestAgent(agents);
      const { verdict } = await vmlab(ctx, ["macos-latest", "--json"]);
      mkdirSync(join(daemon.machine, "images", "linux"), { recursive: true });
      await daemon.start(await signedDaemon(ctx));
      const cache = join(daemon.machine, "images", ".ipsw"); mkdirSync(cache, { recursive: true });
      execFileSync("cp", ["-c", ipsw, join(cache, String(verdict.file_name))]);
      const started = Date.now();
      let built = await daemon.ok("image.create", null, { macos: true, image, disk_bytes: baseDisk });
      while (built.state === "running") {
        const waited = await daemon.call("image.wait", null, { image, timeout_ms: 110_000 }, false);
        assert.equal(waited.ok, true, JSON.stringify(waited).slice(0, 1500));
        built = (waited as any).result;
        if (Date.now() - started > 90 * 60_000) throw new Error(`the build is still in ${built.progress?.phase} after 90 minutes`);
      }
      evidence.build = { seconds: Math.round((Date.now() - started) / 1000), result: built.result ?? null, error: built.error ?? null };
      assert.equal(built.state, "succeeded", JSON.stringify(built).slice(0, 2000));
      const manifest = JSON.parse(readFileSync(join(daemon.machine, "images", image, "image.json"), "utf8"));
      evidence.manifest = { ...manifest, hardware_model: "(set)" };
      assert.equal(manifest.disk_bytes, baseDisk);
    }));
    if (!checks[0].ok) return checks;

    checks.push(await ctx.check("a sandbox from it with --disk 72G: no recovery container, and the main container fills the 72 GiB disk", async () => {
      const created = await daemon.ok("sandbox.create", sandbox, { name: "disk-mac", image, cpus: 4, memory_bytes: 4 * GIB, disk_bytes: sandboxDisk, sleep_after_ms: 3_600_000 });
      evidence.create = created;
      assert.equal(created.produced.disk_bytes, sandboxDisk);
      assert.match(created.actions.find((action: any) => action.kind === "cold_booted").detail, /its filesystem grew into its 72 GiB disk$/);
      evidence.diskutil_list = await daemon.sh(sandbox, "diskutil list physical");
      assert.doesNotMatch(String(evidence.diskutil_list), /Apple_APFS_Recovery/, "the base dropped its recovery container");
      evidence.apfs_list = await daemon.sh(sandbox, "diskutil apfs list");
      const capacity = Number(/Size \(Capacity Ceiling\):\s+(\d+) B/.exec(String(evidence.apfs_list))?.[1]);
      evidence.container_bytes = capacity;
      assert.ok(capacity > sandboxDisk - 2 * GIB && capacity <= sandboxDisk, `the container is ${capacity} bytes`);
      const root = await rootSize((command) => daemon.sh(sandbox, command)); evidence.df = root;
      assert.ok(root.size > sandboxDisk - 2 * GIB, `df / says ${root.size}`);
    }));

    checks.push(await ctx.check("its next cold boot finds nothing left to claim", async () => {
      await daemon.ok("sandbox.stop", sandbox);
      const started = await daemon.ok("sandbox.start", sandbox);
      evidence.restart = started.actions;
      assert.doesNotMatch(JSON.stringify(started.actions), /filesystem/, "no claim ran");
      assert.equal(daemon.record(sandbox).disk_claim_pending, false);
    }));
  } finally {
    writeFileSync(join(ctx.evidence, "45-disk-size-macos.json"), `${JSON.stringify({ checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })), ...evidence }, null, 2)}\n`);
    await cleanup();
  }
  return checks;
}
