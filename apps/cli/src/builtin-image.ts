import { execFileSync } from "node:child_process";
import { createPublicKey, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { machinePaths } from "../../../packages/config/src/index.js";
import { BUILT_IN_IMAGE } from "../../../packages/contract/src/index.js";
import { checkManifest, expandImage, IMAGE_FILES, processAlive, replaceLinuxImage, sha256, verifyManifestSignature, type ReleaseArtifact, type ReleaseManifest } from "../../../scripts/release.js";
import { layout } from "./layout.js";

/**
 * `localbox app image ensure` (specs/menu-bar-app, slice 11): the only writer of this Mac's `images/linux` (invariant
 * 9). It fetches this release's `release.json`, trusts nothing in it until its signature verifies against the pinned
 * key, and, unless the image it names is already installed, downloads the image's artifacts with `Range` resume into
 * `<root>/downloads/linux-<version>/`, checks each one's SHA-256, expands the image there and swaps it into the images
 * directory with one rename. Every step is a progress line; the latest one is also `<root>/builtin-image.json`, which
 * `app status` and the daemon read.
 */
export type ImagePhase = "downloading" | "expanding" | "installing" | "ready" | "failed";
export interface ImageProgress {
  phase: ImagePhase; done_bytes: number; total_bytes: number; error?: string;
  /** The release the line is about. */
  version?: string;
  /** On `ready`: what is installed (the disk's signed digest and `image.json`'s), so the next run can tell it is current. */
  image_sha256?: string; image_json_sha256?: string;
}
/** `running`: another `ensure` holds this version's staging directory; `line` is its latest progress. */
export interface EnsureOutcome { state: "ready" | "failed" | "running"; line: ImageProgress }

export interface EnsureOptions {
  /** This CLI's release (`layout().revision`): the one whose image is installed. */
  version: string;
  /** The folder holding that release's `release.json` and image artifacts: `https:`, `http:` or `file:`. */
  base: string;
  publicKeyPem: string;
  images: string; downloads: string; progressFile: string;
  emit?: (line: ImageProgress) => void;
  /** How many times one run asks again after a connection drops, before it ends `failed` with the partial kept. */
  retries?: number;
}

/** How often a long step's progress is reported: often enough for bytes to visibly climb, rarely enough to cost nothing. */
const PROGRESS_EVERY_MS = 250;
const DEFAULT_REPOSITORY = "dzhng/localbox";

/** The connection ended before the artifact did: what is on disk is good, and a later run resumes it. */
class Interrupted extends Error {}

export async function ensureBuiltinImage(options: EnsureOptions): Promise<EnsureOutcome> {
  const emit = options.emit ?? (() => undefined);
  let last: ImageProgress = { phase: "downloading", done_bytes: 0, total_bytes: 0, version: options.version };
  let reportedAt = 0;
  let trailing: NodeJS.Timeout | undefined;
  /**
   * Emits `line` and makes it the progress file. Within a phase, a line that comes sooner than `PROGRESS_EVERY_MS`
   * after the last one waits for that moment, replaced by any newer one, so a stalled download still shows every byte
   * that arrived.
   */
  const report = async (line: ImageProgress, force = true): Promise<void> => {
    const now = Date.now();
    if (!force && line.phase === last.phase && now - reportedAt < PROGRESS_EVERY_MS) {
      last = line;
      // Any line reported meanwhile cancels this, so it only ever writes the newest line of the same phase.
      trailing ??= setTimeout(() => { trailing = undefined; void report(last); }, PROGRESS_EVERY_MS - (now - reportedAt));
      return;
    }
    if (trailing) { clearTimeout(trailing); trailing = undefined; }
    last = line; reportedAt = now;
    emit(line);
    // A progress file that cannot be written costs only what `app status` shows, never the image.
    await writeProgress(options.progressFile, line).catch(() => undefined);
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(options.version)) {
    const line: ImageProgress = { phase: "failed", done_bytes: 0, total_bytes: 0, error: `this Localbox's version (${options.version}) cannot name a release` };
    await report(line); return { state: "failed", line };
  }
  const staging = join(options.downloads, `linux-${options.version}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const lock = await StagingLock.take(staging);
  if (!lock) {
    const current = await readProgress(options.progressFile) ?? last;
    emit(current);
    return { state: "running", line: current };
  }
  try {
    await clearOtherVersions(options.downloads, staging);
    const line = await install(options, staging, report);
    await report(line);
    return { state: "ready", line };
  } catch (error) {
    const line: ImageProgress = { phase: "failed", done_bytes: last.done_bytes, total_bytes: last.total_bytes, error: (error as Error).message, version: options.version };
    await report(line);
    return { state: "failed", line };
  } finally {
    await lock.release();
    // Empty once a run finished; a failed run's parts stay for the next one to resume.
    await rmdir(staging).catch(() => undefined);
  }
}

type Report = (line: ImageProgress, force?: boolean) => Promise<void>;

async function install(options: EnsureOptions, staging: string, report: Report): Promise<ImageProgress> {
  const { version } = options;
  const installedJson = await sha256(join(options.images, BUILT_IN_IMAGE, IMAGE_FILES.manifest)).catch(() => undefined);
  const record = await readProgress(options.progressFile);
  const installedImage = record?.phase === "ready" && installedJson !== undefined && record.image_json_sha256 === installedJson ? record.image_sha256 : undefined;
  // This release already put its image here: nothing to ask the network (a relaunch, a Mac offline).
  if (installedImage && record?.version === version) return record;

  const manifest = await fetchManifest(options.base, version, options.publicKeyPem);
  const image = manifest.image!;
  const artifact = (name: string) => manifest.artifacts.find((entry) => entry.name === name)!;
  const done = (): ImageProgress => ({ phase: "ready", done_bytes: image.size, total_bytes: image.size, version, image_sha256: image.sha256, image_json_sha256: artifact(image.manifest).sha256 });
  // An update whose image did not change downloads nothing.
  if (installedImage === image.sha256 && installedJson === artifact(image.manifest).sha256) return done();

  const wanted = [...image.parts, image.bootStore, image.manifest].map(artifact);
  const total = wanted.reduce((sum, entry) => sum + entry.size, 0);
  let received = 0;
  const downloading = (force = false) => report({ phase: "downloading", done_bytes: received, total_bytes: total, version }, force);
  await downloading(true);
  for (const entry of wanted) {
    const final = join(staging, entry.name), partial = `${final}.partial`;
    // A finished artifact was checked before its rename; it is checked again, since it sat on disk across a quit.
    if (await size(final) === entry.size && await sha256(final) === entry.sha256) { received += entry.size; await downloading(true); continue; }
    await rm(final, { force: true });
    try {
      await download(`${options.base}/${entry.name}`, partial, entry, options.retries ?? 3, (bytes) => { received += bytes; void downloading(); });
      if (await sha256(partial) !== entry.sha256) throw new Error(`checksum mismatch: ${entry.name}`);
    } catch (error) {
      // Bytes that arrived before a cut are good and resumed; anything else about this artifact is not to be trusted.
      if (!(error instanceof Interrupted)) await rm(partial, { force: true });
      throw error;
    }
    await rename(partial, final);
    await downloading(true);
  }

  const expandedRoot = join(staging, "images"), expanded = join(expandedRoot, BUILT_IN_IMAGE);
  // An expansion a killed run finished but never installed is redone: it was never checked by this run.
  await rm(expanded, { recursive: true, force: true });
  await mkdir(expandedRoot, { recursive: true });
  await report({ phase: "expanding", done_bytes: 0, total_bytes: image.size, version });
  await expandImage(staging, manifest, expanded, (bytes) => { void report({ phase: "expanding", done_bytes: bytes, total_bytes: image.size, version }, false); });
  await report({ phase: "installing", done_bytes: image.size, total_bytes: image.size, version });
  await replaceLinuxImage(expanded, options.images);
  for (const name of await readdir(staging)) if (name !== StagingLock.NAME && !name.startsWith(`${StagingLock.NAME}.`)) await rm(join(staging, name), { recursive: true, force: true });
  return done();
}

/** `release.json` for `version`, used only once its signature verifies and its image entry is whole. */
async function fetchManifest(base: string, version: string, publicKeyPem: string): Promise<ReleaseManifest> {
  let text: string;
  try { text = await readWhole(`${base}/release.json`); } catch (error) { throw new Error(`could not fetch release.json for ${version}: ${(error as Error).message}`); }
  let manifest: ReleaseManifest;
  try { manifest = JSON.parse(text) as ReleaseManifest; } catch { throw new Error(`release.json for ${version} is not JSON`); }
  verifyManifestSignature(manifest, createPublicKey(publicKeyPem));
  checkManifest(manifest);
  if (manifest.version !== version) throw new Error(`release.json is for ${manifest.version}, not this Localbox's ${version}`);
  if (!manifest.image) throw new Error(`release ${version} has no linux image`);
  return manifest;
}

const size = (path: string) => stat(path).then((info) => info.size, () => -1);

/** One artifact's bytes from `from` on, from a web server (`Range`) or a folder. `total` is the whole artifact's size. */
interface Source { start: number; total: number; body: AsyncIterable<Uint8Array>; cancel(): Promise<void> }

async function readWhole(url: string): Promise<string> {
  if (url.startsWith("file:")) return await readFile(fileURLToPath(url), "utf8");
  const response = await fetch(url, { headers: { "user-agent": "localbox-image-ensure" } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  return await response.text();
}

async function openSource(url: string, from: number): Promise<Source> {
  if (url.startsWith("file:")) {
    const path = fileURLToPath(url);
    const total = (await stat(path)).size;
    const stream = createReadStream(path, { start: Math.min(from, total) });
    return { start: Math.min(from, total), total, body: stream, cancel: async () => { stream.destroy(); } };
  }
  const response = await fetch(url, { headers: { "user-agent": "localbox-image-ensure", ...(from > 0 ? { range: `bytes=${from}-` } : {}) } });
  const cancel = async () => { await response.body?.cancel().catch(() => undefined); };
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    if (!range) { await cancel(); throw new Refused(`${basename(url)}: a partial answer without a Content-Range`); }
    return { start: Number(range[1]), total: Number(range[3]), body: response.body as unknown as AsyncIterable<Uint8Array>, cancel };
  }
  // No Range support, or nothing to resume: the body is the whole artifact.
  if (response.status === 200) {
    const length = response.headers.get("content-length");
    return { start: 0, total: length === null ? Number.NaN : Number(length), body: response.body as unknown as AsyncIterable<Uint8Array>, cancel };
  }
  await cancel();
  throw new Refused(`${basename(url)}: HTTP ${response.status}`);
}

/** The server's answer itself is wrong; asking again will not help. */
class Refused extends Error {}

/**
 * Brings `partial` up to the whole artifact, asking only for the bytes it lacks. The resume offset is the file's own
 * length: a reset connection can lose bytes the server already sent (spike 04).
 */
async function download(url: string, partial: string, artifact: ReleaseArtifact, retries: number, received: (bytes: number) => void): Promise<void> {
  let have = Math.max(0, await size(partial));
  if (have > artifact.size) { await rm(partial, { force: true }); have = 0; }
  received(have);
  if (artifact.size === 0) { await writeFile(partial, ""); return; }
  for (let attempt = 0; have < artifact.size; attempt += 1) {
    let source: Source;
    try { source = await openSource(url, have); }
    catch (error) {
      if (error instanceof Refused || (error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      if (attempt < retries) continue;
      throw new Interrupted(`${artifact.name}: ${(error as Error).message}`);
    }
    if (!Number.isNaN(source.total) && source.total !== artifact.size) { await source.cancel(); throw new Error(`${artifact.name}: the server has ${source.total} bytes, the manifest ${artifact.size}`); }
    if (source.start !== have) {
      if (source.start !== 0) { await source.cancel(); throw new Error(`${artifact.name}: asked from byte ${have}, got bytes from ${source.start}`); }
      received(-have); have = 0;
    }
    const file = await open(partial, have > 0 ? "a" : "w", 0o644);
    try {
      for await (const chunk of source.body) {
        if (have + chunk.length > artifact.size) throw new Refused(`${artifact.name}: more bytes than the manifest's ${artifact.size}`);
        await file.write(chunk); have += chunk.length; received(chunk.length);
      }
    } catch (error) {
      if (error instanceof Refused) throw error;
      if (attempt < retries) continue;
      throw new Interrupted(`${artifact.name}: the connection was lost at ${have} of ${artifact.size} bytes (${(error as Error).message})`);
    } finally { await file.sync().catch(() => undefined); await file.close(); }
    // A body that ended cleanly but short: the next request says whether the server really has the rest.
    if (have < artifact.size && attempt >= retries) throw new Interrupted(`${artifact.name}: the server stopped at ${have} of ${artifact.size} bytes`);
  }
}

/**
 * One `ensure` per release at a time: `<staging>/lock` holds the running one's pid, put there by `link(2)`, which
 * either makes the whole file appear or fails. A lock whose process is gone, or is no `localbox app image ensure`
 * (its pid was reused), is stale and taken over.
 */
class StagingLock {
  static readonly NAME = "lock";
  private constructor(private readonly path: string, private readonly token: string) {}

  static async take(staging: string): Promise<StagingLock | undefined> {
    const path = join(staging, StagingLock.NAME);
    const token = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
    const draft = `${path}.${process.pid}-${randomBytes(4).toString("hex")}`;
    await writeFile(draft, token, { mode: 0o600 });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { await link(draft, path); return new StagingLock(path, token); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const holder = Number((await readFile(path, "utf8").catch(() => "")).split(" ")[0]);
          if (StagingLock.running(holder)) return undefined;
          await unlink(path).catch(() => undefined);
        }
      }
      return undefined;
    } finally { await unlink(draft).catch(() => undefined); }
  }

  private static running(pid: number): boolean {
    if (!processAlive(pid)) return false;
    if (pid === process.pid) return true;
    try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes("image ensure"); } catch { return false; }
  }

  /** Removes the lock only while it is still this run's, so a run that took over a stale one keeps it. */
  async release(): Promise<void> {
    if (await readFile(this.path, "utf8").catch(() => "") === this.token) await unlink(this.path).catch(() => undefined);
  }
}

/** A release's staging the app moved past (an update) is only disk: removed, unless an `ensure` for it still runs. */
async function clearOtherVersions(downloads: string, staging: string): Promise<void> {
  for (const name of await readdir(downloads).catch(() => [] as string[])) {
    const other = join(downloads, name);
    if (!name.startsWith("linux-") || other === staging) continue;
    const lock = await StagingLock.take(other).catch(() => undefined);
    if (!lock) continue;
    await rm(other, { recursive: true, force: true });
  }
}

async function readProgress(file: string): Promise<ImageProgress | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as ImageProgress; } catch { return undefined; }
}

/** Written whole and renamed into place, so a reader never sees half a line. */
async function writeProgress(file: string, line: ImageProgress): Promise<void> {
  const draft = `${file}.${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(draft, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  await rename(draft, file);
}

/** The release folder `ensure` reads: `LOCALBOX_RELEASE_URL` when set (a local release), else GitHub's for this version. */
export function releaseBase(version: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LOCALBOX_RELEASE_URL?.replace(/\/+$/, "");
  if (override) return override;
  return `https://github.com/${env.LOCALBOX_RELEASE_REPOSITORY || DEFAULT_REPOSITORY}/releases/download/v${version}`;
}

/** Exit codes: 0 ready, 1 failed (the app retries with backoff), 75 another `ensure` runs (EX_TEMPFAIL: retry later). */
export const ENSURE_EXIT = { ready: 0, failed: 1, running: 75 } as const;

/** `localbox app image ensure [--json]`: one progress line per step on stdout, JSON with `--json`. */
export async function ensureCommand(json: boolean, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const print = (line: ImageProgress) => process.stdout.write(json ? `${JSON.stringify(line)}\n` : `${line.phase} ${line.done_bytes} of ${line.total_bytes} bytes${line.error ? `: ${line.error}` : ""}\n`);
  const here = layout();
  const paths = machinePaths(env);
  const version = here.revision ?? "";
  let publicKeyPem: string;
  try { publicKeyPem = await readFile(here.publicKey, "utf8"); }
  catch (error) {
    const line: ImageProgress = { phase: "failed", done_bytes: 0, total_bytes: 0, error: `no release key at ${here.publicKey}: ${(error as Error).message}` };
    await writeProgress(paths.builtinImage, line).catch(() => undefined); print(line);
    return ENSURE_EXIT.failed;
  }
  const outcome = await ensureBuiltinImage({ version, base: releaseBase(version, env), publicKeyPem, images: paths.images, downloads: paths.downloads, progressFile: paths.builtinImage, emit: print });
  return ENSURE_EXIT[outcome.state];
}
