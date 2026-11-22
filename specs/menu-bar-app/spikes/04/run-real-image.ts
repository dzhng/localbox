// Spike 04, throwaway: pack the real dev image as a release ships it, fetch it over loopback with one cut at 40%,
// resume, expand and install into a scratch images directory; report time per phase and peak disk.
//
//   node_modules/.bin/tsx specs/menu-bar-app/spikes/04/run-real-image.ts [image dir, default dist/vm-image/images/linux]
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../../../scripts/release.js";
import { startFaultServer } from "./fault-server.js";
import { allocated, listing, out, packRelease, runFetcher, sampleDisk, scratchKeys } from "./harness.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const imageDir = resolve(process.argv[2] ?? join(repo, "dist/vm-image/images/linux"));
const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(2)} GiB`;
const freeNow = async () => { const s = await statfs(tmpdir()); return s.bavail * s.bsize; };
const free = await freeNow();
out(`image ${imageDir}: disk.img ${gib((await stat(join(imageDir, "disk.img"))).size)} long, ${gib(await allocated(imageDir))} allocated; free on the scratch volume ${gib(free)}`);
if (free < 30 * 2 ** 30) { out("SKIPPED: under 30 GiB free, so 20 GiB would not stay free with margin"); process.exit(0); }

const root = await mkdtemp(join(tmpdir(), "spike04-real-"));
out(`scratch ${root}`);
try {
  const keys = await scratchKeys(root);
  const release = join(root, "release"); await mkdir(release);
  let t = Date.now();
  const manifest = await packRelease(imageDir, release, "0.0.4", keys.privateKey);
  const image = manifest.image!;
  out(`pack (packImage defaults: zstd -19 --long=27 -T0, plus sha256 of disk and artifacts): ${((Date.now() - t) / 1000).toFixed(1)} s`);
  const parts = image.parts.map((name) => manifest.artifacts.find((a) => a.name === name)!);
  const partBytes = parts.reduce((sum, a) => sum + a.size, 0);
  out(`parts: ${parts.length}, ${partBytes} bytes (${gib(partBytes)}): ${JSON.stringify(parts.map((p) => p.size))}`);

  const images = join(root, "images"); await mkdir(images);
  const server = await startFaultServer(release, { drop: { name: parts[0]!.name, fraction: 0.4 } });
  const args = { base: server.url, "public-key": keys.publicPath, images, retries: 0 };
  const sampler = sampleDisk(images, join(images, ".linux.fetch"), 100);
  const first = await runFetcher(args, false);
  out(`run 1: exit ${first.code} after ${(first.ms / 1000).toFixed(1)} s: ${JSON.stringify(first.lines.at(-1)!.line)}`);
  assert.equal(first.code, 2);
  for (const row of await listing(images)) out(`  between runs: ${row}`);
  const mark = server.requests.length;
  const second = await runFetcher(args, false);
  const peak = await sampler.stop();
  await server.close();
  out(`run 2: exit ${second.code} after ${(second.ms / 1000).toFixed(1)} s`);
  assert.equal(second.code, 0);
  for (const r of server.requests) out(`  request: ${r.url} range=${r.range ?? "-"} -> ${r.status} sent=${r.sent}${r.dropped ? " DROPPED" : ""}`);
  const resumed = server.requests.slice(mark).find((r) => r.url === `/${parts[0]!.name}`)!;
  assert.equal(resumed.status, 206);

  // Phase times from run 2's lines: a phase lasts from its first line to the next phase's first line.
  const firstAt = (phase: string) => second.lines.find((l) => l.line.phase === phase)!.at;
  const at = { downloading: firstAt("downloading"), expanding: firstAt("expanding"), installing: firstAt("installing"), ready: firstAt("ready") };
  out(`run 2 phases: start-up and manifest ${at.downloading} ms; downloading (loopback, resumed ${resumed.sent} bytes, includes each part's sha256) ${at.expanding - at.downloading} ms; expanding ${at.installing - at.expanding} ms; installing ${at.ready - at.installing} ms`);
  const expandLines = second.lines.filter((l) => l.line.phase === "expanding");
  out(`expanding progress lines: ${expandLines.length}; sample ${JSON.stringify(expandLines.slice(0, 4).map((l) => l.line.done_bytes))}`);

  t = Date.now();
  assert.equal(await sha256(join(images, "linux/disk.img")), image.sha256);
  out(`installed disk matches the signed digest (sha256 of ${gib(image.size)} took ${((Date.now() - t) / 1000).toFixed(1)} s)`);
  assert.deepEqual(await readdir(images), ["linux"]);
  for (const row of await listing(images)) out(`  installed: ${row}`);
  const expanded = await allocated(join(images, "linux"));
  out(`peak disk over both runs (${peak.samples} samples, st_blocks): staging ${peak.staging} (${gib(peak.staging)}); images outside staging ${peak.images} (${gib(peak.images)}); both ${peak.sum} (${gib(peak.sum)}); volume free space fell at most ${peak.freeDrop} (${gib(peak.freeDrop)}, whole-volume, so other processes count)`);
  for (const row of peak.stagingAtPeak) out(`  staging at its peak: ${row}`);
  out(`over the bound by ${peak.staging - partBytes - expanded} bytes (${((peak.staging / (partBytes + expanded) - 1) * 100).toFixed(2)}%)`);
  out(`bound: parts ${partBytes} + expanded ${expanded} = ${partBytes + expanded} (${gib(partBytes + expanded)})`);
  out(`staging peak <= parts + expanded (+1 MiB of small files and block rounding): ${peak.staging <= partBytes + expanded + 2 ** 20}`);
} finally {
  await rm(root, { recursive: true, force: true });
  out(`scratch removed: ${root}; free now ${gib(await freeNow())}`);
}
