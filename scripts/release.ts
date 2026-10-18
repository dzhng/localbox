import { createHash, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile, readdir, mkdir, open, readlink, symlink, rename, stat, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

export interface ReleaseArtifact { name: string; sha256: string; size: number; arch: "arm64"; }
/**
 * The VM template ships beside the app, not in it: zstd-compressed and split into artifacts (`parts`, in order) because
 * GitHub caps a release asset at 2 GiB. An install keeps only the expanded disk, `vm/template.img`, checked against
 * `sha256` and `size`.
 */
export interface ReleaseTemplate { sha256: string; size: number; parts: string[] }
export interface ReleaseManifest { schema: "agent-computer.release.v1"; version: string; imageDigest: string; artifacts: ReleaseArtifact[]; template?: ReleaseTemplate; minimumMacOS: string; signature?: { algorithm: "ed25519"; keyId: string; value: string } }
/** The installed template, relative to a release directory. */
export const TEMPLATE_PATH = "vm/template.img";
/** Streamed, because the VM template is multi-GiB and no single buffer can hold it. */
export async function sha256(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer); return hash.digest("hex"); }
export async function makeManifest(dir: string, version: string, imageDigest: string, minimumMacOS = "14.0", template?: ReleaseTemplate): Promise<ReleaseManifest> { const names = (await readdir(dir)).filter((n) => !n.endsWith(".json") && n !== "SHA256SUMS"); const artifacts: ReleaseArtifact[] = []; for (const name of names) { const path = join(dir, name); artifacts.push({ name, sha256: await sha256(path), size: (await stat(path)).size, arch: "arm64" }); } return { schema: "agent-computer.release.v1", version, imageDigest, artifacts, ...(template ? { template } : {}), minimumMacOS }; }
export async function writeRelease(dir: string, manifest: ReleaseManifest): Promise<void> { await writeFile(join(dir, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`); await writeFile(join(dir, "SHA256SUMS"), `${manifest.artifacts.map((a) => `${a.sha256}  ${a.name}`).join("\n")}\n`); }
/** Verify a downloaded release: every artifact, the template's parts included. */
export async function verifyRelease(dir: string, manifest: ReleaseManifest, platformArch = "arm64"): Promise<void> {
  checkManifest(manifest, platformArch);
  for (const artifact of manifest.artifacts) await verifyArtifact(dir, artifact);
}
/** Verify an installed release: its artifacts except the template's parts, which an install does not keep, and the expanded template. */
export async function verifyInstalledRelease(dir: string, manifest: ReleaseManifest, platformArch = "arm64"): Promise<void> {
  checkManifest(manifest, platformArch);
  const parts = new Set(manifest.template?.parts ?? []);
  for (const artifact of manifest.artifacts) if (!parts.has(artifact.name)) await verifyArtifact(dir, artifact);
  if (manifest.template) {
    const path = join(dir, TEMPLATE_PATH);
    if ((await stat(path)).size !== manifest.template.size || await sha256(path) !== manifest.template.sha256) throw new Error("checksum mismatch: VM template");
  }
}
function checkManifest(manifest: ReleaseManifest, platformArch: string): void {
  if (manifest.schema !== "agent-computer.release.v1") throw new Error("unsupported release manifest schema");
  if (platformArch !== "arm64") throw new Error(`unsupported architecture: ${platformArch}`);
  if (!manifest.imageDigest.startsWith("sha256:")) throw new Error("invalid image digest");
  for (const artifact of manifest.artifacts) {
    if (basename(artifact.name) !== artifact.name || artifact.name === "." || artifact.name === "..") throw new Error(`invalid artifact name: ${artifact.name}`);
    if (artifact.arch !== "arm64") throw new Error(`unsupported artifact architecture: ${artifact.name}`);
  }
  const template = manifest.template;
  if (template && (!/^[0-9a-f]{64}$/.test(template.sha256) || !Number.isSafeInteger(template.size) || template.size < 1 || template.parts.length === 0
    || !template.parts.every((part) => manifest.artifacts.some((artifact) => artifact.name === part)))) throw new Error("invalid VM template entry");
}
async function verifyArtifact(dir: string, artifact: ReleaseArtifact): Promise<void> {
  if (await sha256(join(dir, artifact.name)) !== artifact.sha256) throw new Error(`checksum mismatch: ${artifact.name}`);
}
const HOLE_BLOCK = 64 * 1024;
const ZERO_BLOCK = Buffer.alloc(HOLE_BLOCK);
/**
 * Expand a verified release's template parts into `destination`. Zero blocks are left as holes, so the mostly-empty
 * disk takes only the space its files use; the result must match the signed size and digest or nothing is written.
 */
export async function expandTemplate(dir: string, template: ReleaseTemplate, destination: string): Promise<void> {
  const temporary = `${destination}.partial-${process.pid}`;
  const hash = createHash("sha256");
  let offset = 0;
  const handle = await open(temporary, "wx", 0o644);
  try {
    const parts = Readable.from((async function* () { for (const part of template.parts) yield* createReadStream(join(dir, part)); })());
    await pipeline(parts, createZstdDecompress(), async (disk: AsyncIterable<Buffer>) => {
      for await (const chunk of disk) {
        hash.update(chunk);
        for (let at = 0; at < chunk.length; at += HOLE_BLOCK) {
          const block = chunk.subarray(at, at + HOLE_BLOCK);
          if (!block.equals(ZERO_BLOCK.subarray(0, block.length))) await handle.write(block, 0, block.length, offset + at);
        }
        offset += chunk.length;
      }
    });
    await handle.truncate(offset);
    await handle.sync();
  } catch (error) {
    await handle.close(); await unlink(temporary).catch(() => undefined); throw error;
  }
  await handle.close();
  if (offset !== template.size || hash.digest("hex") !== template.sha256) { await unlink(temporary); throw new Error("VM template does not match the signed manifest"); }
  await rename(temporary, destination);
}
/** Sign the canonical manifest fields with a release Ed25519 private key. */
export function signManifest(manifest: ReleaseManifest, privateKey: string | Buffer | KeyObject, keyId: string): ReleaseManifest {
  const unsigned = { ...manifest, signature: undefined };
  const payload = Buffer.from(JSON.stringify(unsigned));
  const value = sign(null, payload, privateKey).toString("base64url");
  return { ...manifest, signature: { algorithm: "ed25519", keyId, value } };
}
/** Verify an Ed25519 manifest signature before an installer accepts artifacts. */
export function verifyManifestSignature(manifest: ReleaseManifest, publicKey: string | Buffer | KeyObject): void {
  if (!manifest.signature || manifest.signature.algorithm !== "ed25519") throw new Error("release signature is missing or unsupported");
  const unsigned = { ...manifest, signature: undefined };
  const valid = verify(null, Buffer.from(JSON.stringify(unsigned)), publicKey, Buffer.from(manifest.signature.value, "base64url"));
  if (!valid) throw new Error("release signature verification failed");
}
/** Atomically switch the product's active release symlink after verification. */
export async function activateRelease(root: string, version: string, manifest: ReleaseManifest, platformArch = "arm64"): Promise<void> {
  validateVersion(version);
  if (manifest.version !== version) throw new Error("release version mismatch");
  const releaseDir = join(root, version);
  await verifyInstalledRelease(releaseDir, manifest, platformArch);
  await mkdir(root, { recursive: true });
  const temporary = join(root, `.active-${process.pid}-${randomUUID()}`);
  await symlink(version, temporary, "dir");
  try { await rename(temporary, join(root, "active")); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
/** Return the version currently selected by the atomic active symlink. */
export async function activeRelease(root: string): Promise<string | undefined> {
  try {
    const version = await readlink(join(root, "active"));
    validateVersion(version);
    return version;
  } catch { return undefined; }
}
/** Select a previously verified release using the same atomic switch as install. */
export async function rollbackRelease(root: string, version: string, manifest: ReleaseManifest, platformArch = "arm64"): Promise<void> {
  await activateRelease(root, version, manifest, platformArch);
}
function validateVersion(version: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) throw new Error("invalid release version");
}
export const artifactName = basename;
