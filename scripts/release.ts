import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";

export interface ReleaseArtifact { name: string; sha256: string; size: number; arch: "arm64"; }
export interface ReleaseManifest { schema: "agent-computer.release.v1"; version: string; imageDigest: string; artifacts: ReleaseArtifact[]; minimumMacOS: string; }
export async function sha256(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
export async function makeManifest(dir: string, version: string, imageDigest: string, minimumMacOS = "13.0"): Promise<ReleaseManifest> { const names = (await readdir(dir)).filter((n) => !n.endsWith(".json") && n !== "SHA256SUMS"); const artifacts: ReleaseArtifact[] = []; for (const name of names) { const data = await readFile(join(dir, name)); artifacts.push({ name, sha256: createHash("sha256").update(data).digest("hex"), size: data.length, arch: "arm64" }); } return { schema: "agent-computer.release.v1", version, imageDigest, artifacts, minimumMacOS }; }
export async function writeRelease(dir: string, manifest: ReleaseManifest): Promise<void> { await writeFile(join(dir, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`); await writeFile(join(dir, "SHA256SUMS"), `${manifest.artifacts.map((a) => `${a.sha256}  ${a.name}`).join("\n")}\n`); }
export async function verifyRelease(dir: string, manifest: ReleaseManifest, platformArch = "arm64"): Promise<void> {
  if (manifest.schema !== "agent-computer.release.v1") throw new Error("unsupported release manifest schema");
  if (platformArch !== "arm64") throw new Error(`unsupported architecture: ${platformArch}`);
  if (!manifest.imageDigest.startsWith("sha256:")) throw new Error("invalid image digest");
  for (const artifact of manifest.artifacts) {
    if (artifact.arch !== "arm64") throw new Error(`unsupported artifact architecture: ${artifact.name}`);
    const actual = await sha256(join(dir, artifact.name));
    if (actual !== artifact.sha256) throw new Error(`checksum mismatch: ${artifact.name}`);
  }
}
export const artifactName = basename;
