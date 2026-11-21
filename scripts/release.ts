import { createHash, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, writeFile, readdir, readFile, mkdir, open, readlink, rm, symlink, rename, stat, unlink } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createZstdDecompress } from "node:zlib";
import { BUILT_IN_IMAGE } from "../packages/contract/src/index.js";

const execFileAsync = promisify(execFile);

export interface ReleaseArtifact { name: string; sha256: string; size: number; arch: "arm64"; }
/**
 * The built-in `linux` image ships beside the app, not in it, as three kinds of artifact: its disk zstd-compressed and
 * split into `parts` (in order, because GitHub caps a release asset at 2 GiB), its boot store (`bootStore`, the EFI
 * variable store) and its `image.json` (`manifest`). An install expands them into `images/linux/` in the release
 * directory, checking the disk against `sha256` and `size`, and keeps only that directory.
 */
export interface ReleaseImage { sha256: string; size: number; parts: string[]; bootStore: string; manifest: string }
export interface ReleaseManifest { schema: "agent-computer.release.v1"; version: string; imageDigest: string; artifacts: ReleaseArtifact[]; image?: ReleaseImage; minimumMacOS: string; signature?: { algorithm: "ed25519"; keyId: string; value: string } }
/** The installed image directory, relative to a release directory. */
export const IMAGE_PATH = `images/${BUILT_IN_IMAGE}`;
/** The image directory's files, as the host daemon's `ImageStore` reads them. */
export const IMAGE_FILES = { manifest: "image.json", disk: "disk.img", bootStore: "boot/efi-vars" } as const;
/** Streamed, because the VM disk is multi-GiB and no single buffer can hold it. */
export async function sha256(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer); return hash.digest("hex"); }
export async function makeManifest(dir: string, version: string, imageDigest: string, minimumMacOS = "14.0", image?: ReleaseImage): Promise<ReleaseManifest> { const names = (await readdir(dir)).filter((n) => n !== "release.json" && n !== "SHA256SUMS"); const artifacts: ReleaseArtifact[] = []; for (const name of names) { const path = join(dir, name); artifacts.push({ name, sha256: await sha256(path), size: (await stat(path)).size, arch: "arm64" }); } return { schema: "agent-computer.release.v1", version, imageDigest, artifacts, ...(image ? { image } : {}), minimumMacOS }; }
export async function writeRelease(dir: string, manifest: ReleaseManifest): Promise<void> { await writeFile(join(dir, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`); await writeFile(join(dir, "SHA256SUMS"), `${manifest.artifacts.map((a) => `${a.sha256}  ${a.name}`).join("\n")}\n`); }
/** Verify a downloaded release: every artifact, the image's included. */
export async function verifyRelease(dir: string, manifest: ReleaseManifest, platformArch = "arm64"): Promise<void> {
  checkManifest(manifest, platformArch);
  for (const artifact of manifest.artifacts) await verifyArtifact(dir, artifact);
}
/** The artifacts an install expands into `images/linux/` and does not keep. */
function imageArtifacts(image: ReleaseImage | undefined): Set<string> { return new Set(image ? [...image.parts, image.bootStore, image.manifest] : []); }
/** Verify an installed release: its artifacts except the image's, which an install does not keep, and the expanded image. */
export async function verifyInstalledRelease(dir: string, manifest: ReleaseManifest, platformArch = "arm64"): Promise<void> {
  checkManifest(manifest, platformArch);
  const expanded = imageArtifacts(manifest.image);
  for (const artifact of manifest.artifacts) if (!expanded.has(artifact.name)) await verifyArtifact(dir, artifact);
  if (manifest.image) await verifyImageDirectory(join(dir, IMAGE_PATH), manifest);
}
async function verifyImageDirectory(directory: string, manifest: ReleaseManifest): Promise<void> {
  const image = manifest.image!;
  const digest = (name: string) => manifest.artifacts.find((artifact) => artifact.name === name)!.sha256;
  const disk = join(directory, IMAGE_FILES.disk);
  if ((await stat(disk)).size !== image.size || await sha256(disk) !== image.sha256
    || await sha256(join(directory, IMAGE_FILES.bootStore)) !== digest(image.bootStore)
    || await sha256(join(directory, IMAGE_FILES.manifest)) !== digest(image.manifest)) throw new Error("checksum mismatch: linux image");
}
function checkManifest(manifest: ReleaseManifest, platformArch: string): void {
  if (manifest.schema !== "agent-computer.release.v1") throw new Error("unsupported release manifest schema");
  if (platformArch !== "arm64") throw new Error(`unsupported architecture: ${platformArch}`);
  if (!manifest.imageDigest.startsWith("sha256:")) throw new Error("invalid image digest");
  for (const artifact of manifest.artifacts) {
    if (basename(artifact.name) !== artifact.name || artifact.name === "." || artifact.name === "..") throw new Error(`invalid artifact name: ${artifact.name}`);
    if (artifact.arch !== "arm64") throw new Error(`unsupported artifact architecture: ${artifact.name}`);
  }
  const image = manifest.image;
  if (image && (!/^[0-9a-f]{64}$/.test(image.sha256) || !Number.isSafeInteger(image.size) || image.size < 1 || image.parts.length === 0
    || ![...image.parts, image.bootStore, image.manifest].every((name) => manifest.artifacts.some((artifact) => artifact.name === name)))) throw new Error("invalid linux image entry");
}
async function verifyArtifact(dir: string, artifact: ReleaseArtifact): Promise<void> {
  if (await sha256(join(dir, artifact.name)) !== artifact.sha256) throw new Error(`checksum mismatch: ${artifact.name}`);
}
/** Just under GitHub's 2 GiB asset cap. */
export const IMAGE_PART_BYTES = 2000 * 1024 * 1024;
/**
 * Write an image directory's release artifacts into `outDir`, named `<prefix>.disk.img.zst.NNN`, `<prefix>.efi-vars`
 * and `<prefix>.image.json`, and return the manifest entry naming them. The disk goes through the `zstd` CLI, which
 * compresses on every core; a 128 MiB window (--long=27) is the most Node's zstd decoder accepts by default.
 */
export async function packImage(imageDir: string, outDir: string, prefix: string, options: { level?: number; partBytes?: number } = {}): Promise<ReleaseImage> {
  const image = JSON.parse(await readFile(join(imageDir, IMAGE_FILES.manifest), "utf8")) as { image_id?: string; os?: string };
  if (image.image_id !== BUILT_IN_IMAGE || image.os !== "linux") throw new Error(`${imageDir} is not the linux image (image.json names ${image.image_id}, ${image.os})`);
  const disk = join(imageDir, IMAGE_FILES.disk);
  const partBytes = options.partBytes ?? IMAGE_PART_BYTES;
  const zstd = spawn("zstd", ["-q", "-T0", `-${options.level ?? 19}`, "--long=27", "-c", disk], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve, reject) => { zstd.on("error", reject); zstd.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`zstd exited ${code}`))); });
  const parts: string[] = [];
  let part: Awaited<ReturnType<typeof open>> | undefined; let written = 0;
  try {
    for await (const chunk of zstd.stdout as AsyncIterable<Buffer>) {
      for (let at = 0; at < chunk.length;) {
        if (!part || written === partBytes) {
          await part?.close();
          const name = `${prefix}.disk.img.zst.${String(parts.length).padStart(3, "0")}`;
          part = await open(join(outDir, name), "wx", 0o644); parts.push(name); written = 0;
        }
        const take = Math.min(chunk.length - at, partBytes - written);
        await part.write(chunk, at, take); at += take; written += take;
      }
    }
  } finally { await part?.close(); }
  await exited;
  const bootStore = `${prefix}.efi-vars`, manifest = `${prefix}.image.json`;
  await copyFile(join(imageDir, IMAGE_FILES.bootStore), join(outDir, bootStore));
  await copyFile(join(imageDir, IMAGE_FILES.manifest), join(outDir, manifest));
  return { sha256: await sha256(disk), size: (await stat(disk)).size, parts, bootStore, manifest };
}
const HOLE_BLOCK = 64 * 1024;
const ZERO_BLOCK = Buffer.alloc(HOLE_BLOCK);
/**
 * Expand a verified release's image artifacts into the image directory `destination`. Zero blocks of the disk are left
 * as holes, so the mostly-empty disk takes only the space its files use; the disk must match the signed size and
 * digest, the boot store and `image.json` their artifacts' digests, or nothing is written.
 */
export async function expandImage(dir: string, manifest: ReleaseManifest, destination: string): Promise<void> {
  const image = manifest.image;
  if (!image) throw new Error("release has no linux image");
  const temporary = join(dirname(destination), `.${basename(destination)}.partial-${process.pid}`);
  await mkdir(join(temporary, dirname(IMAGE_FILES.bootStore)), { recursive: true });
  try {
    const hash = createHash("sha256");
    let offset = 0;
    const handle = await open(join(temporary, IMAGE_FILES.disk), "wx", 0o644);
    try {
      const parts = Readable.from((async function* () { for (const part of image.parts) yield* createReadStream(join(dir, part)); })());
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
    } finally { await handle.close(); }
    if (offset !== image.size || hash.digest("hex") !== image.sha256) throw new Error("linux image disk does not match the signed manifest");
    await copyFile(join(dir, image.bootStore), join(temporary, IMAGE_FILES.bootStore));
    await copyFile(join(dir, image.manifest), join(temporary, IMAGE_FILES.manifest));
    await verifyImageDirectory(temporary, manifest);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }); throw error;
  }
}
/**
 * Make an installed release's image this Mac's `images/linux`: an APFS clone (sharing every block, so it costs no
 * space) assembled under a dot-prefixed name, which `ImageStore` sweeps if a crash leaves it, then swapped in. Install
 * and rollback both run it, so the Mac always runs the image its active release shipped.
 */
export async function installLinuxImage(releaseDir: string, imagesDir: string): Promise<void> {
  const source = join(releaseDir, IMAGE_PATH);
  const destination = join(imagesDir, BUILT_IN_IMAGE);
  const temporary = join(imagesDir, `.${BUILT_IN_IMAGE}.installing-${process.pid}`);
  const replaced = join(imagesDir, `.${BUILT_IN_IMAGE}.replaced-${process.pid}`);
  await rm(temporary, { recursive: true, force: true });
  await mkdir(join(temporary, dirname(IMAGE_FILES.bootStore)), { recursive: true });
  // `cp -c` is clonefile(2); Node's COPYFILE_FICLONE has no clone on macOS and its fallback writes out every hole. A
  // plain `cp` covers images on another volume than the release, where nothing can be cloned.
  for (const file of Object.values(IMAGE_FILES)) {
    const [from, to] = [join(source, file), join(temporary, file)];
    await execFileAsync("cp", ["-c", from, to]).catch(() => execFileAsync("cp", [from, to]));
  }
  const hadImage = await rename(destination, replaced).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
  await rename(temporary, destination);
  if (hadImage) await rm(replaced, { recursive: true, force: true });
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
