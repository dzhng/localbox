// Spike 04, throwaway: what the fixture run and the real-image run share.
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readdir, lstat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeManifest, packImage, signManifest, writeRelease, type ReleaseManifest } from "../../../../scripts/release.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../..");

export const out = (line: string) => process.stdout.write(`${line}\n`);

/** A scratch Ed25519 pair; the public half is written to `dir` for the fetcher to pin. */
export async function scratchKeys(dir: string, name = "pinned") {
  const keys = generateKeyPairSync("ed25519");
  const publicPath = join(dir, `${name}.pem`);
  await writeFile(publicPath, keys.publicKey.export({ type: "spki", format: "pem" }));
  return { ...keys, publicPath };
}

/** Pack `imageDir` into `releaseDir` and write its signed `release.json`. */
export async function packRelease(imageDir: string, releaseDir: string, version: string, privateKey: Parameters<typeof signManifest>[1], options: { level?: number; partBytes?: number } = {}): Promise<ReleaseManifest> {
  const image = await packImage(imageDir, releaseDir, `localbox-linux-${version}`, options);
  const manifest = signManifest(await makeManifest(releaseDir, version, `sha256:${image.sha256}`, undefined, image), privateKey, "scratch");
  await writeRelease(releaseDir, manifest);
  return manifest;
}

export interface FetchRun { code: number | null; lines: { at: number; line: Record<string, unknown> }[]; stderr: string; ms: number }
/** One fetcher process, its JSON lines stamped with milliseconds since it started. */
export function runFetcher(args: Record<string, string | number>, echo = true): Promise<FetchRun> {
  const started = Date.now();
  const child = spawn(join(repo, "node_modules/.bin/tsx"), [join(here, "fetch.ts"), ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, String(v)])], { stdio: ["ignore", "pipe", "pipe"] });
  const lines: FetchRun["lines"] = []; let buffer = "", stderr = "";
  child.stdout.on("data", (data: Buffer) => {
    buffer += data.toString();
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const text = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      lines.push({ at: Date.now() - started, line: JSON.parse(text) as Record<string, unknown> });
      if (echo) out(`    fetcher +${String(Date.now() - started).padStart(6)}ms ${text}`);
    }
  });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  return new Promise((resolve) => child.on("exit", (code) => { if (stderr.trim()) out(`    fetcher stderr: ${stderr.trim()}`); resolve({ code, lines, stderr, ms: Date.now() - started }); }));
}

/** Bytes allocated (`st_blocks`) under `dir`; a clone's shared blocks count once per file, as `du` counts them. */
export async function allocated(dir: string): Promise<number> {
  let sum = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sum += await allocated(path);
    else sum += await lstat(path).then((s) => s.blocks * 512, () => 0);
  }
  return sum;
}

/** Every file under `dir` with its length and allocated bytes. */
export async function listing(dir: string, prefix = ""): Promise<string[]> {
  const rows: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) rows.push(...await listing(path, `${prefix}${entry.name}/`));
    else { const s = await lstat(path); rows.push(`${prefix}${entry.name} size=${s.size} allocated=${s.blocks * 512}`); }
  }
  return rows;
}

/**
 * Samples, until stopped, what the staging directory and the rest of the images directory hold, and how far the
 * volume's free space has fallen since the start (the only figure that sees a clone as free).
 */
export function sampleDisk(imagesDir: string, stagingRoot: string, everyMs = 100) {
  const peak = { staging: 0, images: 0, sum: 0, freeDrop: 0, samples: 0, stagingAtPeak: [] as string[] };
  let stop = false;
  const free = async () => { const s = await statfs(imagesDir); return s.bavail * s.bsize; };
  const loop = (async () => {
    const before = await free();
    while (!stop) {
      const staging = await allocated(stagingRoot);
      const images = stagingRoot.startsWith(imagesDir) ? await allocated(imagesDir) - staging : await allocated(imagesDir);
      // The files behind the staging peak, listed a moment after the sum was taken.
      if (staging > peak.staging) peak.stagingAtPeak = await listing(stagingRoot);
      peak.staging = Math.max(peak.staging, staging); peak.images = Math.max(peak.images, images); peak.sum = Math.max(peak.sum, staging + images);
      peak.freeDrop = Math.max(peak.freeDrop, before - await free()); peak.samples += 1;
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  })();
  return { peak, stop: async () => { stop = true; await loop; return peak; } };
}
