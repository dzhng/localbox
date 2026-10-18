import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { layout } from "./layout.js";
import { verifyManifestSignature, verifyRelease, type ReleaseManifest } from "../../../scripts/release.js";

const execFileAsync = promisify(execFile);
const INSTALL_ROOT = process.env.LOCALBOX_INSTALL_ROOT ?? join(homedir(), "Library/Application Support/Localbox");
const DEFAULT_RELEASE_REPOSITORY = "dzhng/localbox";
function releaseRepository(): string { return process.env.LOCALBOX_RELEASE_REPOSITORY || DEFAULT_RELEASE_REPOSITORY; }

export interface UpdateCheck { repository: string; currentVersion?: string; latestVersion: string; tag: string; updateAvailable: boolean; releaseUrl?: string; }
export interface UpdateInstall extends UpdateCheck { installed: boolean; error?: string; }

function version(value: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}
function newer(candidate: string, current?: string): boolean { if (!current) return true; const a = version(candidate), b = version(current); for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] > b[index]; return false; }
async function currentVersion(): Promise<string | undefined> {
  if (process.env.LOCALBOX_CURRENT_VERSION) return process.env.LOCALBOX_CURRENT_VERSION;
  try { return (JSON.parse(await readFile(join(INSTALL_ROOT, "releases/active/release.json"), "utf8")) as { version?: string }).version; } catch { return undefined; }
}
function apiUrl(): string {
  if (process.env.LOCALBOX_RELEASE_API_URL) return process.env.LOCALBOX_RELEASE_API_URL;
  return `https://api.github.com/repos/${releaseRepository()}/releases/latest`;
}
async function githubRelease(): Promise<{ tag: string; url?: string; assets: { name: string; browser_download_url: string }[] }> {
  const response = await fetch(apiUrl(), { headers: { accept: "application/vnd.github+json", "user-agent": "localbox-updater" } });
  if (!response.ok) throw new Error(`GitHub release lookup failed: HTTP ${response.status}`);
  const value = await response.json() as { tag_name?: string; html_url?: string; assets?: { name?: string; browser_download_url?: string }[] };
  if (!value.tag_name || !Array.isArray(value.assets)) throw new Error("GitHub release response is incomplete");
  return { tag: value.tag_name, url: value.html_url, assets: value.assets.filter((asset): asset is { name: string; browser_download_url: string } => Boolean(asset.name && asset.browser_download_url)) };
}
export async function checkForUpdate(): Promise<UpdateCheck> {
  const release = await githubRelease();
  const current = await currentVersion();
  return { repository: releaseRepository(), currentVersion: current, latestVersion: release.tag.replace(/^v/, ""), tag: release.tag, updateAvailable: newer(release.tag, current), releaseUrl: release.url };
}
async function publicKey(): Promise<string | undefined> {
  const configured = process.env.LOCALBOX_RELEASE_PUBLIC_KEY || join(INSTALL_ROOT, "release-public.pem");
  if (configured.includes("BEGIN PUBLIC KEY")) return configured;
  try { return await readFile(configured, "utf8"); } catch { return undefined; }
}
/** Streamed to disk: the template's parts are up to 2 GiB each. */
async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url, { headers: { accept: "application/octet-stream", "user-agent": "localbox-updater" } });
  if (!response.ok || !response.body) throw new Error(`Release download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(path, { flags: "wx" }));
}
export async function installLatest(options: { automatic?: boolean } = {}): Promise<UpdateInstall> {
  const checked = await checkForUpdate();
  if (!checked.updateAvailable) return { ...checked, installed: false };
  const release = await githubRelease();
  const manifestAsset = release.assets.find((asset) => asset.name === "release.json");
  if (!manifestAsset) throw new Error("GitHub release is missing release.json");
  const stage = await mkdtemp(join(tmpdir(), "localbox-update-"));
  try {
    const manifestPath = join(stage, "release.json");
    await download(manifestAsset.browser_download_url, manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ReleaseManifest;
    if (manifest.version !== release.tag.replace(/^v/, "")) throw new Error("GitHub release tag and manifest version differ");
    // The key is pinned by the installer or operator environment. Never trust a
    // key downloaded in the same manifest it is meant to authenticate.
    const key = await publicKey();
    if (!key) throw new Error("Localbox release public key is missing; refusing an unauthenticated update");
    verifyManifestSignature(manifest, key);
    for (const artifact of manifest.artifacts) {
      const asset = release.assets.find((candidate) => candidate.name === artifact.name);
      if (!asset) throw new Error(`GitHub release is missing ${artifact.name}`);
      await download(asset.browser_download_url, join(stage, artifact.name));
    }
    await verifyRelease(stage, manifest, "arm64");
    const keyPath = join(stage, "release-public.pem"); await writeFile(keyPath, key, { mode: 0o600 });
    const result = await execFileAsync("sh", [layout().installer, stage], {
      env: {
        ...process.env,
        RELEASE_PUBLIC_KEY: keyPath,
        ...(options.automatic ? { LOCALBOX_AUTO_UPDATE: "1", LOCALBOX_SKIP_UPDATER_RELOAD: "1" } : {}),
      },
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ...checked, installed: true, ...(result.stderr ? { error: result.stderr.trim() } : {}) };
  } finally {
    // The installer owns its extracted release tree; this directory only holds verified inputs.
    await import("node:fs/promises").then(({ rm }) => rm(stage, { recursive: true, force: true }));
  }
}

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
