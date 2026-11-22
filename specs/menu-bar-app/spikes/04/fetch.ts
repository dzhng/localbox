// Spike 04, throwaway: fetch the built-in image named by a signed release manifest, with Range resume, and install it
// with the release code that exists (`verifyManifestSignature`, `expandImage`, `installLinuxImage`).
//
//   tsx fetch.ts --base <url> --public-key <pem file> --images <dir> [--staging-root <dir>] [--retries n]
//
// Exit 0: ready. Exit 2: interrupted, partial files kept, run again to resume. Exit 1: failed closed.
import { createPublicKey } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expandImage, installLinuxImage, sha256, verifyManifestSignature, IMAGE_FILES, IMAGE_PATH, type ReleaseArtifact, type ReleaseManifest } from "../../../../scripts/release.js";

export type Phase = "downloading" | "expanding" | "installing" | "ready" | "failed";
export interface Progress { phase: Phase; done_bytes: number; total_bytes: number; error?: string; resumable?: boolean; note?: string }
/** The connection ended before the part did: what is on disk is good, and a later run resumes it. */
export class Interrupted extends Error {}

export interface EnsureOptions { base: string; publicKeyPem: string; imagesDir: string; stagingRoot?: string; retries?: number; emit: (line: Progress) => void; userAgent?: string }

const size = (path: string) => stat(path).then((s) => s.size, () => -1);

export async function ensureImage(options: EnsureOptions): Promise<void> {
  const { base, emit } = options;
  const headers = { "user-agent": options.userAgent ?? "image-fetch-spike" };
  const response = await fetch(`${base}/release.json`, { headers });
  if (!response.ok) throw new Error(`release.json: HTTP ${response.status}`);
  const manifest = JSON.parse(await response.text()) as ReleaseManifest;
  // Nothing in the manifest is used before this passes.
  verifyManifestSignature(manifest, createPublicKey(options.publicKeyPem));
  const image = manifest.image;
  if (!image) throw new Error("release has no linux image");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.version)) throw new Error("invalid release version");
  const wanted: ReleaseArtifact[] = [...image.parts, image.bootStore, image.manifest].map((name) => {
    const artifact = manifest.artifacts.find((a) => a.name === name);
    if (!artifact || basename(name) !== name || name.startsWith(".")) throw new Error(`invalid image artifact: ${name}`);
    return artifact;
  });
  const total = wanted.reduce((sum, a) => sum + a.size, 0);
  const staging = join(options.stagingRoot ?? join(options.imagesDir, ".linux.fetch"), manifest.version);
  await mkdir(staging, { recursive: true });
  // `expandImage` names its temporary after its pid, so one a crash left would never be reused: clear it.
  await rm(join(staging, "images"), { recursive: true, force: true });

  let done = 0, last = 0;
  const progress = (force = false) => { const now = Date.now(); if (force || now - last >= 200) { last = now; emit({ phase: "downloading", done_bytes: done, total_bytes: total }); } };
  progress(true);
  for (const artifact of wanted) {
    const final = join(staging, artifact.name), partial = `${final}.partial`;
    // A part under its final name was verified before its rename; hash it again, since it sat on disk across a quit.
    if (await size(final) === artifact.size && await sha256(final) === artifact.sha256) { done += artifact.size; emit({ phase: "downloading", done_bytes: done, total_bytes: total, note: `kept ${artifact.name}` }); continue; }
    await rm(final, { force: true });
    try {
      await download(`${base}/${artifact.name}`, partial, artifact, headers, options.retries ?? 0, (bytes) => { done += bytes; progress(); }, (bytes) => { done -= bytes; });
      if (await sha256(partial) !== artifact.sha256) throw new Error(`checksum mismatch: ${artifact.name}`);
    } catch (error) {
      if (!(error instanceof Interrupted)) await rm(partial, { force: true });
      throw error;
    }
    await rename(partial, final);
    progress(true);
  }

  // `expandImage` reports nothing as it goes; its temporary's length is how far the disk has been written.
  const expanding = join(staging, "images", `.linux.partial-${process.pid}`, IMAGE_FILES.disk);
  emit({ phase: "expanding", done_bytes: 0, total_bytes: image.size });
  const poll = setInterval(() => { void size(expanding).then((n) => { if (n > 0) emit({ phase: "expanding", done_bytes: n, total_bytes: image.size }); }); }, 500);
  try { await mkdir(join(staging, "images"), { recursive: true }); await expandImage(staging, manifest, join(staging, IMAGE_PATH)); } finally { clearInterval(poll); }
  emit({ phase: "expanding", done_bytes: image.size, total_bytes: image.size });
  emit({ phase: "installing", done_bytes: 0, total_bytes: image.size });
  await installLinuxImage(staging, options.imagesDir);
  await rm(staging, { recursive: true, force: true });
  await rmdir(dirname(staging)).catch(() => undefined); // the staging root, when no other version is staged in it
  emit({ phase: "ready", done_bytes: image.size, total_bytes: image.size });
}

/** Bring `partial` up to the whole artifact, asking only for the bytes it lacks. */
async function download(url: string, partial: string, artifact: ReleaseArtifact, headers: Record<string, string>, retries: number, received: (bytes: number) => void, discarded: (bytes: number) => void): Promise<void> {
  let have = Math.max(0, await size(partial));
  if (have > artifact.size) { await rm(partial, { force: true }); have = 0; }
  received(have);
  for (let attempt = 0; have < artifact.size || artifact.size === 0; attempt += 1) {
    let response: Response;
    try { response = await fetch(url, { headers: have > 0 ? { ...headers, range: `bytes=${have}-` } : headers }); }
    catch (error) { if (attempt < retries) continue; throw new Interrupted(`${artifact.name}: ${(error as Error).message}`); }
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
      if (!range || Number(range[1]) !== have) { await response.body?.cancel(); throw new Error(`${artifact.name}: asked from ${have}, got Content-Range ${response.headers.get("content-range")}`); }
      if (Number(range[3]) !== artifact.size) { await response.body?.cancel(); throw new Error(`${artifact.name}: the server has ${range[3]} bytes, the manifest ${artifact.size}`); }
    } else if (response.status === 200) {
      // No Range support (or nothing to resume): the body is the whole part, so start it over.
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) !== artifact.size) { await response.body?.cancel(); throw new Error(`${artifact.name}: the server has ${length} bytes, the manifest ${artifact.size}`); }
      discarded(have); have = 0;
    } else { await response.body?.cancel(); throw new Error(`${artifact.name}: HTTP ${response.status}`); }
    const file = await open(partial, have > 0 ? "a" : "w", 0o644);
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (have + chunk.length > artifact.size) throw new Error(`${artifact.name}: more bytes than the manifest's ${artifact.size}`);
        await file.write(chunk); have += chunk.length; received(chunk.length);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("more bytes than")) throw error;
      if (attempt < retries) continue;
      throw new Interrupted(`${artifact.name}: connection lost at ${have} of ${artifact.size} (${(error as Error).message})`);
    } finally { await file.sync().catch(() => undefined); await file.close(); }
    if (artifact.size === 0) break;
    // A body that ended cleanly but short: the next request's 206/416 decides whether the server really has the rest.
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1]!);
  const emit = (line: Progress) => process.stdout.write(`${JSON.stringify(line)}\n`);
  ensureImage({ base: args.get("base")!, publicKeyPem: await readFile(args.get("public-key")!, "utf8"), imagesDir: args.get("images")!, stagingRoot: args.get("staging-root"), retries: Number(args.get("retries") ?? 0), emit })
    .then(() => process.exit(0), (error: Error) => {
      const resumable = error instanceof Interrupted;
      emit({ phase: "failed", done_bytes: 0, total_bytes: 0, error: error.message, resumable });
      process.exit(resumable ? 2 : 1);
    });
}
