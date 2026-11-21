import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { cachedIpsw, vmlab } from "../lib/macos-lab.js";
import { realDaemon } from "../lib/real-daemon.js";
import { buildGuestAgent } from "../../build-guest-agent.js";

export const id = "34";
export const tiers = ["u", "s", "m"];

/**
 * `image create --macos`: the account's macOS base built on a Mac from Apple's IPSW with no human step. Tier u: the
 * relay reserves an IPSW image, routes to the target Mac and refuses an old one; the connector carries `min_macos` and
 * the IPSW version onto the row. Tier s: the builder's phases, resumes and the password on a fake VM driver. Tier m: a
 * real build on this Mac to `ready`, then a cached rebuild, each followed phase by phase through `image.wait`, and a
 * sandbox made from the image showing SIP off, Chrome, no Xcode, Remote Login off and no window-picker prompt.
 */
export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("image create --macos through the relay (reservation, routing, host-version refusal) and the holder report", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/macos-build-relay.test.ts", "tests/images-convex.test.ts", "tests/connector.test.ts", "tests/image-capture-relay.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2500));
    })];
  }
  if (ctx.tier === "s") {
    return [await ctx.check("MacBaseBuilderTests: phase order, resume from each checkpoint, password never persisted; the store's wait and sweep", async () => {
      const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "MacBaseBuilderTests|HostOperationStoreTests|ImageStoreTests|ImageCaptureTests"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2500));
    })];
  }
  return await realBuild(ctx);
}

interface Phase { phase: string; at_s: number; done_bytes?: number; total_bytes?: number }

async function realBuild(ctx: ProofContext): Promise<Check[]> {
  const version = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  if (Number(version.split(".")[0]) < 27) throw new Error(`blocked: building a macOS image needs a macOS 27 host; this Mac runs ${version}`);
  const ipsw = cachedIpsw();
  if (!ipsw) throw new Error("blocked: no cached IPSW; run npm run proof -- 16 --tier m");
  const evidence: Record<string, unknown> = { host_macos: version, uncached_build: "not measured: an uncached build needs the 25.6 GB IPSW plus the 50 GB disk free, more than this Mac has; the IPSW cache was seeded from the lab's by APFS clone" };
  const directory = join(ctx.root, "specs/sandbox-images/evidence"); mkdirSync(directory, { recursive: true });
  const agents = join(ctx.root, "dist/guest-agent");
  const daemon = realDaemon(ctx, { probe: "34", env: { LOCALBOX_GUEST_AGENT: agents } });
  const checks: Check[] = [];
  try {
    checks.push(await ctx.check("the daemon starts with the guest agent build (darwin/ included) and an IPSW cache seeded by APFS clone", async () => {
      await buildGuestAgent(agents);
      assert.ok(existsSync(join(agents, "darwin", "localbox-desktop")) && existsSync(join(agents, "darwin", "install.sh")));
      // vmlab's run builds and signs the daemon beside it. The build needs no linux image, so the machine gets an empty
      // stand-in instead of the dev image (which would need Docker).
      const { verdict } = await vmlab(ctx, ["macos-latest", "--json"]);
      evidence.ipsw = verdict;
      mkdirSync(join(daemon.machine, "images", "linux"), { recursive: true });
      await daemon.start((await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim());
      if (!ipsw.endsWith(`/${verdict.file_name}`) || statSync(ipsw).size !== verdict.size_bytes) throw new Error(`blocked: Apple now serves ${verdict.file_name} (${verdict.size_bytes} bytes); the cached IPSW is ${ipsw}`);
      const cache = join(daemon.machine, "images", ".ipsw"); mkdirSync(cache, { recursive: true });
      execFileSync("cp", ["-c", ipsw, join(cache, String(verdict.file_name))]);
    }));

    /** One build to its end through `image.create` and `image.wait`, every phase timed. */
    const build = async (image: string): Promise<{ record: any; phases: Phase[]; seconds: number }> => {
      const started = Date.now();
      const phases: Phase[] = [];
      // A phase starts when the build journals it: an answer that brings a new phase has `updated_at` at that report.
      const note = (record: any) => {
        const phase = record.progress?.phase;
        if (phase && phases.at(-1)?.phase !== phase) phases.push({ phase, at_s: Math.round((record.updated_at - record.started_at) / 1000), ...(record.progress.total ? { done_bytes: record.progress.completed, total_bytes: record.progress.total } : {}) });
      };
      let record = await daemon.ok("image.create", null, { macos: true, image });
      note(record);
      while (record.state === "running") {
        const waited = await daemon.call("image.wait", null, { image, timeout_ms: 110_000 }, false);
        assert.equal(waited.ok, true, JSON.stringify(waited).slice(0, 1500));
        record = (waited as any).result; note(record);
        if (Date.now() - started > 90 * 60_000) throw new Error(`the build is still in ${record.progress?.phase} after 90 minutes`);
      }
      return { record, phases, seconds: Math.round((Date.now() - started) / 1000) };
    };

    let firstImage = "";
    checks.push(await ctx.check("image create --macos builds to ready with no human step; image.wait answers at every phase", async () => {
      firstImage = `image_p34a${Date.now().toString(36)}`;
      const { record, phases, seconds } = await build(firstImage);
      evidence.first_build = { seconds, phases, result: record.result ?? null, error: record.error ?? null };
      assert.equal(record.state, "succeeded", JSON.stringify(record).slice(0, 2000));
      assert.deepEqual(phases.map((entry) => entry.phase).filter((phase) => phase !== "download"), ["install", "provision", "bootstrap", "sip", "tcc", "finish"]);
      const manifest = JSON.parse(readFileSync(join(daemon.machine, "images", firstImage, "image.json"), "utf8"));
      evidence.manifest = { ...manifest, hardware_model: manifest.hardware_model ? "(set)" : null };
      assert.deepEqual([manifest.os, manifest.min_macos, typeof manifest.hardware_model], ["macos", "27.0", "string"]);
      assert.equal(record.result.min_macos, "27.0"); assert.ok(record.result.ipsw_version);
    }));

    checks.push(await ctx.check("a sandbox from the image: SIP disabled, Chrome present, no Xcode, Remote Login off, no window-picker prompt", async () => {
      const { verdict, stderr } = await vmlab(ctx, ["macos-image", "--image", join(daemon.machine, "images", firstImage), "--evidence", directory, "--json"]);
      evidence.image_check = verdict;
      assert.equal(verdict.ok, true, JSON.stringify(verdict).slice(0, 2500) + stderr.slice(-1500));
    }));

    checks.push(await ctx.check("a cached rebuild skips the download and reaches ready again", async () => {
      // Two bases don't fit beside each other on this Mac's free disk; the first goes, as a user deleting it would.
      assert.equal((await daemon.call("image.delete", null, { image: firstImage })).ok, true);
      const second = `image_p34b${Date.now().toString(36)}`;
      const { record, phases, seconds } = await build(second);
      evidence.cached_rebuild = { seconds, phases, result: record.result ?? null, error: record.error ?? null };
      assert.equal(record.state, "succeeded", JSON.stringify(record).slice(0, 2000));
      const download = phases.find((entry) => entry.phase === "download");
      assert.ok(!download || download.done_bytes === download.total_bytes, `the IPSW was fetched again: ${JSON.stringify(download)}`);
      assert.ok(!existsSync(join(daemon.machine, "images", ".ipsw", `${String((evidence.ipsw as any).file_name)}.partial`)), "nothing was downloaded");
    }));
  } finally {
    writeFileSync(join(directory, "34-macos-base-build.json"), `${JSON.stringify({ checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })), ...evidence }, null, 2)}\n`);
    await daemon.cleanup();
  }
  return checks;
}
