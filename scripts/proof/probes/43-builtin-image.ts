import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { sha256 } from "../../release.js";
import { imageRelease, startFaultServer, type FaultServer } from "../lib/image-release.js";
import { packagedApp } from "../lib/packaged-app.js";

// Menu bar app, slice 11: a Mac with no `images/linux` gets the built-in image by itself. The dev app is launched
// against a local release folder (a scratch-key-signed image, served with a fault server, never GitHub) with no image:
// `app status` shows the download, a create meanwhile is told to wait with its progress, a quit mid-download and a
// relaunch resume it from the bytes on disk, and once it is ready a create works on the fixture backend.
//
//   npm run proof -- 43 --tier a

export const id = "43";
export const tiers = ["a"];

const VERSION = "0.43.0";
const SANDBOX = "sandbox_p43_early", NAME = "early-otter";
const CREATE = { name: NAME, image: "linux", cpus: 2, memory_bytes: 2 * 1024 ** 3, sleep_after_ms: 60 * 60_000 };

export async function run(ctx: ProofContext): Promise<Check[]> {
  const app = packagedApp(ctx, { probe: "43", backend: "process-fixture" });
  const checks: Check[] = [];
  const release = join(app.scratch, "release"), key = join(app.scratch, "release-public.pem");
  const keys = generateKeyPairSync("ed25519");
  let server: FaultServer | undefined;
  let held = 0;
  const staging = join(app.root, "downloads", `linux-${VERSION}`);
  try {
    const manifest = await imageRelease(release, VERSION, keys.privateKey, { diskBytes: 64 * 1024 ** 2, dataBytes: 8 * 1024 ** 2, parts: 3 });
    const parts = manifest.image!.parts;
    writeFileSync(key, keys.publicKey.export({ type: "spki", format: "pem" }));
    // The second part stops halfway until the probe lets it go, so the download is caught in the middle.
    server = await startFaultServer(release, { hold: { name: parts[1], fraction: 0.5 } });
    const url = server.url;

    checks.push(await ctx.check("build: a dev bundle that pins a scratch release key", async () => {
      assert.equal((await ctx.exec("npm", ["run", "-s", "build"])).code, 0, "npm run build");
      const bundle = await app.build({ version: VERSION, publicKey: key });
      assert.equal(readFileSync(join(bundle, "Contents/Resources/release-public.pem"), "utf8"), readFileSync(key, "utf8"));
    }));

    checks.push(await ctx.check("launched with no image, the app downloads it: app status shows it downloading with bytes arriving", async () => {
      assert.ok(!existsSync(join(app.paths.images, "linux")));
      await app.start({ LOCALBOX_RELEASE_URL: url });
      await Promise.race([server!.held, new Promise((_, reject) => setTimeout(() => reject(new Error(`the download never reached the second part; ${app.log("image.log").slice(-1500)}`)), 60_000))]);
      let status: any;
      await app.until(async () => { status = await app.cli(["app", "status"]); return (status.images.find((row: any) => row.name === "linux")?.progress?.done_bytes ?? 0) > 0; }, "app status to show the download's bytes");
      assert.equal(status.builtin_image, "downloading", JSON.stringify(status));
      const row = status.images.find((entry: any) => entry.name === "linux");
      assert.equal(row.state, "downloading"); assert.ok(row.progress.done_bytes < row.progress.total_bytes, JSON.stringify(row));
      held = row.progress.done_bytes;
      // The one-shot's own lines: bytes only climb.
      const lines = app.log("image.log").trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.phase === "downloading");
      assert.ok(lines.length >= 2 && lines.every((line, index) => index === 0 || line.done_bytes >= lines[index - 1].done_bytes), JSON.stringify(lines));
      assert.ok(status.warnings.every((warning: any) => !warning.code.startsWith("builtin_image")), "a download in progress is not a warning");
      mkdirSync(ctx.evidence, { recursive: true });
      writeFileSync(join(ctx.evidence, "43-app-status-downloading.json"), `${JSON.stringify(status, null, 2)}\n`);
    }));

    checks.push(await ctx.check("a create from linux meanwhile is refused sandbox_not_ready, retryable, with the download's progress", async () => {
      const refused: any = await app.request("sandbox.create", SANDBOX, CREATE);
      assert.equal(refused.ok, false, JSON.stringify(refused));
      assert.equal(refused.error.code, "sandbox_not_ready");
      assert.equal(refused.error.retryable, true);
      assert.match(refused.error.message, /^the built-in image is still downloading \(\d+ MB of \d+ MB\); try again when `localbox app status` shows it ready$/);
      assert.equal(refused.error.details.progress.done_bytes, held);
      assert.ok(!existsSync(join(app.paths.sandboxes, SANDBOX)), "nothing was laid down");
    }));

    checks.push(await ctx.check("quit mid-download: the one-shot stops with the app, its partial part stays, images/linux is not there", async () => {
      await app.stop(() => undefined);
      assert.deepEqual(app.processes().imageEnsures, [], "the image's one-shot went with the app");
      assert.ok(!existsSync(join(app.paths.images, "linux")));
      assert.ok(statSync(join(staging, `${parts[1]}.partial`)).size > 0, "the bytes that arrived are kept");
    }));

    checks.push(await ctx.check("reopened, it resumes: the finished part is not asked for again, the cut one from its partial's length, and app status reaches ready", async () => {
      const partial = statSync(join(staging, `${parts[1]}.partial`)).size;
      const mark = server!.requests.length;
      await app.start({ LOCALBOX_RELEASE_URL: url });
      let status: any;
      await app.until(async () => { status = await app.cli(["app", "status"]); return status.builtin_image === "ready"; }, "the built-in image to be ready", 120_000);
      const asked = server!.requests.slice(mark);
      assert.ok(!asked.some((request) => request.name === parts[0]), `part 0 was kept: ${JSON.stringify(asked)}`);
      const resumed = asked.find((request) => request.name === parts[1]);
      assert.deepEqual([resumed?.range, resumed?.status], [`bytes=${partial}-`, 206], JSON.stringify(asked));
      assert.equal(await sha256(join(app.paths.images, "linux/disk.img")), manifest.image!.sha256);
      assert.ok(!existsSync(staging), "the staging directory is gone");
      assert.deepEqual(status.images, [], "nothing in progress"); assert.ok(status.warnings.every((warning: any) => !warning.code.startsWith("builtin_image")));
      await app.until(() => app.processes().imageEnsures.length === 0, "the one-shot to finish and not be restarted", 10_000);
      writeFileSync(join(ctx.evidence, "43-app-status-ready.json"), `${JSON.stringify(status, null, 2)}\n`);
    }));

    checks.push(await ctx.check("a create afterwards succeeds on the fixture backend", async () => {
      const created = await app.ok("sandbox.create", SANDBOX, CREATE);
      assert.equal(created.actions[0]?.kind, "created", JSON.stringify(created));
      await app.stop(() => undefined);
    }));
    return checks;
  } finally {
    server?.release();
    await server?.close();
    await app.cleanup();
  }
}
