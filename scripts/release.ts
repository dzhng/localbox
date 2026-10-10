import { createHash, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { readFile, writeFile, readdir, mkdir, readlink, symlink, rename, unlink } from "node:fs/promises";
import { join, basename } from "node:path";

export interface ReleaseArtifact { name: string; sha256: string; size: number; arch: "arm64"; }
export interface ReleaseManifest { schema: "agent-computer.release.v1"; version: string; imageDigest: string; artifacts: ReleaseArtifact[]; minimumMacOS: string; public_key?: string; signature?: { algorithm: "ed25519"; keyId: string; value: string } }
export async function sha256(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
export async function makeManifest(dir: string, version: string, imageDigest: string, minimumMacOS = "13.0"): Promise<ReleaseManifest> { const names = (await readdir(dir)).filter((n) => !n.endsWith(".json") && n !== "SHA256SUMS"); const artifacts: ReleaseArtifact[] = []; for (const name of names) { const data = await readFile(join(dir, name)); artifacts.push({ name, sha256: createHash("sha256").update(data).digest("hex"), size: data.length, arch: "arm64" }); } return { schema: "agent-computer.release.v1", version, imageDigest, artifacts, minimumMacOS }; }
export async function writeRelease(dir: string, manifest: ReleaseManifest): Promise<void> { await writeFile(join(dir, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`); await writeFile(join(dir, "SHA256SUMS"), `${manifest.artifacts.map((a) => `${a.sha256}  ${a.name}`).join("\n")}\n`); }
export async function verifyRelease(dir: string, manifest: ReleaseManifest, platformArch = "arm64"): Promise<void> {
  if (manifest.schema !== "agent-computer.release.v1") throw new Error("unsupported release manifest schema");
  if (platformArch !== "arm64") throw new Error(`unsupported architecture: ${platformArch}`);
  if (!manifest.imageDigest.startsWith("sha256:")) throw new Error("invalid image digest");
  for (const artifact of manifest.artifacts) {
    if (basename(artifact.name) !== artifact.name || artifact.name === "." || artifact.name === "..") throw new Error(`invalid artifact name: ${artifact.name}`);
    if (artifact.arch !== "arm64") throw new Error(`unsupported artifact architecture: ${artifact.name}`);
    const actual = await sha256(join(dir, artifact.name));
    if (actual !== artifact.sha256) throw new Error(`checksum mismatch: ${artifact.name}`);
  }
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
  await verifyRelease(releaseDir, manifest, platformArch);
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
