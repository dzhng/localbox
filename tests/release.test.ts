import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, writeFile, readFile, readdir, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { stat } from "node:fs/promises";
import { zstdCompressSync } from "node:zlib";
import { expandImage, installLinuxImage, makeManifest, packImage, sha256, signManifest, verifyManifestSignature, writeRelease, verifyRelease, IMAGE_PATH } from "../scripts/release.js";
import { installationSteps, pinnedKey, runSteps, serveRelease, trusting } from "../scripts/proof/lib/installation.js";

test("release manifest and checksums verify artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-computer-release-")); await writeFile(join(dir, "agent-computer-arm64"), "fixture");
  const manifest = await makeManifest(dir, "0.1.0", "sha256:image"); await writeRelease(dir, manifest); await verifyRelease(dir, manifest);
  await writeFile(join(dir, "agent-computer-arm64"), "tampered"); await assert.rejects(() => verifyRelease(dir, manifest), /checksum mismatch/);
});

test("release manifest signatures fail closed after tampering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-computer-release-signature-"));
  await writeFile(join(dir, "agent-computer-arm64"), "fixture");
  const manifest = await makeManifest(dir, "0.1.0", "sha256:image");
  const keys = generateKeyPairSync("ed25519");
  const signed = signManifest(manifest, keys.privateKey, "test-key");
  verifyManifestSignature(signed, keys.publicKey);
  assert.throws(() => verifyManifestSignature({ ...signed, version: "tampered" }, keys.publicKey), /signature verification failed/);
});

/** A linux image directory as the image build writes it: a mostly-empty disk, a boot store and image.json. */
async function fixtureImage(dir: string, agentVersion = "1"): Promise<Buffer> {
  await mkdir(join(dir, "boot"), { recursive: true });
  // 64 MiB of disk with two small extents of data, written sparsely: the rest must stay unallocated wherever it goes.
  const disk = Buffer.alloc(64 * 1024 * 1024);
  disk.write("superblock", 1024); disk.write("tail", disk.length - 4);
  const file = await open(join(dir, "disk.img"), "w");
  await file.truncate(disk.length); await file.write(disk, 1024, 10, 1024); await file.write(disk, disk.length - 4, 4, disk.length - 4); await file.close();
  await writeFile(join(dir, "boot/efi-vars"), "variable store");
  await writeFile(join(dir, "image.json"), JSON.stringify({ image_id: "linux", os: "linux", size_bytes: 8192, agent_version: agentVersion }));
  return disk;
}

test("the linux image ships as disk parts, boot store and image.json, and expands to an image directory with holes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-release-image-"));
  const download = join(root, "download");
  await mkdir(download);
  const disk = await fixtureImage(join(root, "built"));
  await writeFile(join(download, "agent-computer-arm64"), "app");
  // Node's compressor stands in for the zstd CLI here (the packing test below uses the CLI); two parts.
  const compressed = zstdCompressSync(disk);
  const half = Math.floor(compressed.length / 2);
  await writeFile(join(download, "i.zst.000"), compressed.subarray(0, half));
  await writeFile(join(download, "i.zst.001"), compressed.subarray(half));
  await writeFile(join(download, "i.efi-vars"), await readFile(join(root, "built/boot/efi-vars")));
  await writeFile(join(download, "i.image.json"), await readFile(join(root, "built/image.json")));
  const image = { sha256: createHash("sha256").update(disk).digest("hex"), size: disk.length, parts: ["i.zst.000", "i.zst.001"], bootStore: "i.efi-vars", manifest: "i.image.json" };
  const manifest = await makeManifest(download, "0.1.0", "sha256:image", undefined, image);
  await verifyRelease(download, manifest);
  const expanded = join(root, "expanded", IMAGE_PATH);
  await mkdir(join(root, "expanded/images"), { recursive: true });
  await expandImage(download, manifest, expanded);
  assert.deepEqual((await readdir(expanded, { recursive: true })).sort(), ["boot", "boot/efi-vars", "disk.img", "image.json"]);
  assert.equal(await sha256(join(expanded, "disk.img")), image.sha256);
  assert.equal(await readFile(join(expanded, "boot/efi-vars"), "utf8"), "variable store");
  assert.ok((await stat(join(expanded, "disk.img"))).blocks * 512 < disk.length / 8, "zero blocks are holes");
  await assert.rejects(() => expandImage(download, { ...manifest, image: { ...image, sha256: "0".repeat(64) } }, join(root, "refused")), /does not match the signed manifest/);
  assert.deepEqual(await readdir(root), ["built", "download", "expanded"], "a refused expansion leaves nothing behind");
  await assert.rejects(() => verifyRelease(download, { ...manifest, image: { ...image, bootStore: "unlisted" } }), /invalid linux image entry/);
});

test("packing an image directory with the zstd CLI splits the disk into parts that expand back to it", { skip: spawnSync("zstd", ["--version"]).status === 0 ? false : "the zstd CLI is not installed" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-release-pack-"));
  const disk = await fixtureImage(join(root, "image"));
  await mkdir(join(root, "out"));
  // Random bytes don't compress, so a 512 KiB part size gives several parts.
  await writeFile(join(root, "image/disk.img"), Buffer.concat([randomBytes(1536 * 1024), disk]));
  const image = await packImage(join(root, "image"), join(root, "out"), "localbox-linux-0.1.0", { level: 1, partBytes: 512 * 1024 });
  assert.ok(image.parts.length >= 3, `${image.parts.length} parts`);
  assert.deepEqual(image.parts, image.parts.map((_, index) => `localbox-linux-0.1.0.disk.img.zst.${String(index).padStart(3, "0")}`));
  assert.deepEqual([image.bootStore, image.manifest], ["localbox-linux-0.1.0.efi-vars", "localbox-linux-0.1.0.image.json"]);
  const manifest = await makeManifest(join(root, "out"), "0.1.0", "sha256:image", undefined, image);
  await expandImage(join(root, "out"), manifest, join(root, "linux"));
  assert.equal(await sha256(join(root, "linux/disk.img")), await sha256(join(root, "image/disk.img")));
  await writeFile(join(root, "image/image.json"), JSON.stringify({ image_id: "other", os: "linux" }));
  await assert.rejects(() => packImage(join(root, "image"), join(root, "out"), "again"), /is not the linux image/);
});

test("installing a release's image replaces this Mac's images/linux and leaves no temporary", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-release-install-image-"));
  const images = join(root, "images");
  for (const version of ["0.1.0", "0.2.0"]) await fixtureImage(join(root, "releases", version, IMAGE_PATH), version);
  await installLinuxImage(join(root, "releases", "0.2.0"), images);
  assert.equal(JSON.parse(await readFile(join(images, "linux/image.json"), "utf8")).agent_version, "0.2.0");
  // An older image replaces a newer one just the same.
  await installLinuxImage(join(root, "releases", "0.1.0"), images);
  assert.equal(JSON.parse(await readFile(join(images, "linux/image.json"), "utf8")).agent_version, "0.1.0");
  assert.deepEqual(await readdir(images), ["linux"]);
  assert.ok((await stat(join(images, "linux/disk.img"))).blocks * 512 < 1024 * 1024, "the installed disk is a clone that keeps the holes");
  assert.deepEqual((await readdir(join(images, "linux"), { recursive: true })).sort(), ["boot", "boot/efi-vars", "disk.img", "image.json"]);
});

test("release verification rejects artifact path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-release-artifact-"));
  await writeFile(join(root, "agent-computer-arm64"), "fixture");
  const manifest = await makeManifest(root, "0.1.0", "sha256:image");
  await assert.rejects(() => verifyRelease(root, {
    ...manifest,
    artifacts: [{ ...manifest.artifacts[0], name: "../outside" }],
  }), /invalid artifact name/);
});

const ZIP = "Localbox-macos-arm64.zip";
const jsc = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc";

test("the installation procedure pins exactly the release public key the skill ships", async () => {
  assert.equal(pinnedKey(installationSteps(process.cwd())), await readFile("skills/localbox/release-public.pem", "utf8"), "a first install trusts only the key printed in the procedure");
});

test("the installation procedure downloads exactly the assets release.sh publishes besides the image", async () => {
  const steps = installationSteps(process.cwd());
  const downloaded = /for name in ([^;]+); do/.exec(steps.get(2) ?? "")?.[1].trim().split(/\s+/);
  const zip = /ditto -c -k [^\n]*"\$OUT_DIR\/([^"]+)"/.exec(await readFile("scripts/release.sh", "utf8"))?.[1];
  assert.equal(zip, ZIP);
  assert.deepEqual(downloaded, ["release.json", "SHA256SUMS", ZIP]);
  assert.match(steps.get(3)!, new RegExp(`grep ' ${ZIP.replaceAll(".", "\\.")}\\$' SHA256SUMS \\| shasum -a 256 -c -`));
  assert.match(steps.get(4)!, new RegExp(`ditto -x -k ${ZIP.replaceAll(".", "\\.")} unpacked`));
});

/** A release as release.sh writes one (manifest, checksums, a stand-in zip), signed with `key`. */
async function scratchRelease(dir: string, key: KeyObject, version = "0.10.0") {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ZIP), "the app");
  await writeFile(join(dir, "localbox-linux-0.10.0.image.json"), "{}");
  await writeRelease(dir, signManifest(await makeManifest(dir, version, `sha256:${"0".repeat(64)}`), key, "scratch"));
}

test("the procedure's download and verification steps accept a release signed by the pinned key and refuse every tampered one", { skip: existsSync(jsc) ? false : "no JavaScriptCore shell on this Mac" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "localbox-installation-")), served = join(root, "served");
  const keys = generateKeyPairSync("ed25519"), other = generateKeyPairSync("ed25519");
  const steps = installationSteps(process.cwd());
  const blocks = [steps.get(2)!, trusting(steps.get(3)!, keys.publicKey.export({ type: "spki", format: "pem" }).toString())];
  const server = await serveRelease(served);
  const install = () => runSteps(blocks, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, TMPDIR: join(root, "tmp"), LOCALBOX_RELEASE_URL: server.url });
  await mkdir(join(root, "tmp"));
  try {
    const fresh = async (version?: string) => { await rm(served, { recursive: true, force: true }); await scratchRelease(served, keys.privateKey, version); };
    // A version with a non-ASCII character: the check must hash the manifest's UTF-8 bytes, as Node signed them.
    await fresh("0.10.0-é");
    const good = await install();
    assert.equal(good.code, 0, good.output);
    assert.match(good.output, /Localbox 0\.10\.0-é: release\.json is signed by the pinned key/);
    assert.match(good.output, new RegExp(`${ZIP}: OK`));

    const json = async () => JSON.parse(await readFile(join(served, "release.json"), "utf8"));
    const tampered: Array<[string, () => Promise<void>, RegExp]> = [
      ["a changed version", async () => { await writeFile(join(served, "release.json"), JSON.stringify({ ...await json(), version: "0.10.1" }, null, 2)); }, /not signed by the pinned Localbox key/],
      ["an app swapped with its checksum line", async () => {
        await writeFile(join(served, ZIP), "another app");
        const digest = createHash("sha256").update("another app").digest("hex");
        await writeFile(join(served, "SHA256SUMS"), (await readFile(join(served, "SHA256SUMS"), "utf8")).replace(/^\w+(?=  Localbox)/m, digest));
      }, /SHA256SUMS does not list exactly the signed artifacts/],
      ["an app swapped with its checksum line and manifest entry", async () => {
        await writeFile(join(served, ZIP), "another app");
        const digest = createHash("sha256").update("another app").digest("hex"), manifest = await json();
        manifest.artifacts.find((artifact: { name: string }) => artifact.name === ZIP).sha256 = digest;
        await writeRelease(served, manifest);
      }, /not signed by the pinned Localbox key/],
      ["an app swapped alone", async () => { await writeFile(join(served, ZIP), "another app"); }, new RegExp(`${ZIP}: FAILED`)],
      ["a release signed by another key", async () => { await writeRelease(served, signManifest({ ...await json(), signature: undefined }, other.privateKey, "scratch")); }, /not signed by the pinned Localbox key/],
      ["a manifest with no signature", async () => { await writeRelease(served, { ...await json(), signature: undefined }); }, /not a signed Localbox release manifest/],
    ];
    for (const [name, tamper, refusal] of tampered) {
      await fresh(); await tamper();
      const refused = await install();
      assert.notEqual(refused.code, 0, `${name} was accepted: ${refused.output}`);
      assert.match(refused.output, refusal, name);
    }
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});
