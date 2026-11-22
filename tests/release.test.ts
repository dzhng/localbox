import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, writeFile, readFile, readdir, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { zstdCompressSync } from "node:zlib";
import { activateRelease, activeRelease, expandImage, installLinuxImage, makeManifest, packImage, rollbackRelease, sha256, signManifest, verifyManifestSignature, writeRelease, verifyRelease, IMAGE_PATH } from "../scripts/release.js";

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

async function fixtureRelease(root: string, version: string, content = version): Promise<Awaited<ReturnType<typeof makeManifest>>> {
  const dir = join(root, version);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "agent-computer-arm64"), content);
  const manifest = await makeManifest(dir, version, "sha256:image");
  await writeRelease(dir, manifest);
  return manifest;
}

test("activation verifies a release and atomically exposes its version", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-release-active-"));
  const manifest = await fixtureRelease(root, "0.1.0");
  await activateRelease(root, "0.1.0", manifest);
  assert.equal(await activeRelease(root), "0.1.0");
  assert.equal(await readFile(join(root, "active", "agent-computer-arm64"), "utf8"), "0.1.0");
});

test("activation rejects tampered artifacts and preserves the current release", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-release-rollback-"));
  const first = await fixtureRelease(root, "0.1.0", "first");
  await activateRelease(root, "0.1.0", first);
  const second = await fixtureRelease(root, "0.2.0", "second");
  await writeFile(join(root, "0.2.0", "agent-computer-arm64"), "tampered");
  await assert.rejects(() => activateRelease(root, "0.2.0", second), /checksum mismatch/);
  assert.equal(await activeRelease(root), "0.1.0");
  assert.equal(await readFile(join(root, "active", "agent-computer-arm64"), "utf8"), "first");
});

test("rollback selects an older verified release", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-release-rollback-success-"));
  const first = await fixtureRelease(root, "0.1.0", "first");
  const second = await fixtureRelease(root, "0.2.0", "second");
  await activateRelease(root, "0.2.0", second);
  await rollbackRelease(root, "0.1.0", first);
  assert.equal(await activeRelease(root), "0.1.0");
  assert.equal(await readFile(join(root, "active", "agent-computer-arm64"), "utf8"), "first");
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

test("the linux image ships as disk parts, boot store and image.json, expands to an image directory with holes, and an install verifies it without the artifacts", async () => {
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
  const installed = join(root, "releases", "0.1.0");
  await mkdir(join(installed, "images"), { recursive: true });
  await writeFile(join(installed, "agent-computer-arm64"), "app");
  await expandImage(download, manifest, join(installed, IMAGE_PATH));
  const expanded = join(installed, IMAGE_PATH);
  assert.deepEqual((await readdir(expanded, { recursive: true })).sort(), ["boot", "boot/efi-vars", "disk.img", "image.json"]);
  assert.equal(await sha256(join(expanded, "disk.img")), image.sha256);
  assert.equal(await readFile(join(expanded, "boot/efi-vars"), "utf8"), "variable store");
  assert.ok((await stat(join(expanded, "disk.img"))).blocks * 512 < disk.length / 8, "zero blocks are holes");
  await activateRelease(join(root, "releases"), "0.1.0", manifest);
  await writeFile(join(expanded, "boot/efi-vars"), "tampered");
  await assert.rejects(() => activateRelease(join(root, "releases"), "0.1.0", manifest), /checksum mismatch: linux image/);
  await assert.rejects(() => expandImage(download, { ...manifest, image: { ...image, sha256: "0".repeat(64) } }, join(root, "refused")), /does not match the signed manifest/);
  assert.deepEqual(await readdir(root), ["built", "download", "releases"], "a refused expansion leaves nothing behind");
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
  // A rollback brings back the older release's image.
  await installLinuxImage(join(root, "releases", "0.1.0"), images);
  assert.equal(JSON.parse(await readFile(join(images, "linux/image.json"), "utf8")).agent_version, "0.1.0");
  assert.deepEqual(await readdir(images), ["linux"]);
  assert.ok((await stat(join(images, "linux/disk.img"))).blocks * 512 < 1024 * 1024, "the installed disk is a clone that keeps the holes");
  assert.deepEqual((await readdir(join(images, "linux"), { recursive: true })).sort(), ["boot", "boot/efi-vars", "disk.img", "image.json"]);
});

test("release activation rejects path traversal versions before touching the tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-release-version-"));
  const manifest = await fixtureRelease(root, "0.1.0");
  await assert.rejects(() => activateRelease(root, "../escape", manifest), /invalid release version/);
  await assert.rejects(() => activateRelease(root, "0.2.0", manifest), /release version mismatch/);
  assert.equal(await activeRelease(root), undefined);
});

test("release verification rejects artifact path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-release-artifact-"));
  const manifest = await fixtureRelease(root, "0.1.0");
  await assert.rejects(() => verifyRelease(join(root, "0.1.0"), {
    ...manifest,
    artifacts: [{ ...manifest.artifacts[0], name: "../outside" }],
  }), /invalid artifact name/);
});

test("the installer refuses macOS below 14 and names the version; 14 and newer pass the check", async () => {
  const home = await mkdtemp(join(tmpdir(), "localbox-installer-home-")); const release = await mkdtemp(join(tmpdir(), "localbox-installer-release-"));
  const install = (version: string) => spawnSync("sh", ["scripts/install-release.sh", release], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, ALLOW_UNSIGNED: "1", LOCALBOX_MACOS_VERSION: version } });
  try {
    for (const version of ["13.6.1", "12.7"]) {
      const refused = install(version);
      assert.equal(refused.status, 1);
      assert.equal(refused.stderr.trim(), `Localbox requires macOS 14 (Sonoma) or newer; this Mac runs macOS ${version}. Update macOS, then install again.`);
    }
    for (const version of ["14.0", "26.1"]) {
      const passed = install(version);
      assert.doesNotMatch(passed.stderr, /requires macOS/);
      assert.match(passed.stderr, /release directory is missing/, "it went on to read the (empty) release");
    }
  } finally { await rm(home, { recursive: true, force: true }); await rm(release, { recursive: true, force: true }); }
});

test("uninstall removes every launch agent it installed, the connector's included", async () => {
  const home = await mkdtemp(join(tmpdir(), "localbox-uninstall-")), agents = join(home, "Library/LaunchAgents");
  const plists = ["sh.localbox.hostd.plist", "sh.localbox.updater.plist", "sh.localbox.connector.plist"];
  await mkdir(agents, { recursive: true });
  for (const plist of plists) await writeFile(join(agents, plist), "<plist/>");
  const result = spawnSync("sh", ["scripts/uninstall.sh"], { env: { PATH: process.env.PATH, HOME: home, SHELL: "/bin/zsh", LOCALBOX_SKIP_LAUNCHD: "1" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const plist of plists) await assert.rejects(() => readFile(join(agents, plist)), /ENOENT/);
});

test("the installation procedure pins exactly the release public key the skill ships", async () => {
  const pinned = await readFile("skills/localbox/release-public.pem", "utf8");
  const procedure = await readFile("skills/localbox/references/installation.md", "utf8");
  const written = /cat > "\$download\/release-public\.pem" <<'EOF'\n([\s\S]*?)EOF\n/.exec(procedure)?.[1];
  assert.equal(written, pinned, "a first install trusts only the key printed in the procedure");
});
