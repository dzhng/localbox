import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { stat } from "node:fs/promises";
import { zstdCompressSync } from "node:zlib";
import { activateRelease, activeRelease, expandTemplate, makeManifest, rollbackRelease, sha256, signManifest, verifyManifestSignature, writeRelease, verifyRelease, TEMPLATE_PATH } from "../scripts/release.js";

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

test("a template split into parts expands to the signed disk, leaves zeros as holes, and an install verifies it without the parts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-release-template-"));
  const download = join(root, "download");
  await mkdir(download);
  // 64 MiB of disk with two small extents of data: the rest must stay unallocated.
  const disk = Buffer.alloc(64 * 1024 * 1024);
  disk.write("superblock", 1024); disk.write("tail", disk.length - 4);
  const compressed = zstdCompressSync(disk);
  const half = Math.floor(compressed.length / 2);
  await writeFile(join(download, "t.zst.000"), compressed.subarray(0, half));
  await writeFile(join(download, "t.zst.001"), compressed.subarray(half));
  await writeFile(join(download, "agent-computer-arm64"), "app");
  const template = { sha256: createHash("sha256").update(disk).digest("hex"), size: disk.length, parts: ["t.zst.000", "t.zst.001"] };
  const manifest = await makeManifest(download, "0.1.0", "sha256:image", undefined, template);
  await verifyRelease(download, manifest);
  const installed = join(root, "releases", "0.1.0");
  await mkdir(join(installed, "vm"), { recursive: true });
  await writeFile(join(installed, "agent-computer-arm64"), "app");
  await expandTemplate(download, template, join(installed, TEMPLATE_PATH));
  const expanded = join(installed, TEMPLATE_PATH);
  assert.equal(await sha256(expanded), template.sha256);
  assert.ok((await stat(expanded)).blocks * 512 < disk.length / 8, "zero blocks are holes");
  await activateRelease(join(root, "releases"), "0.1.0", manifest);
  await writeFile(expanded, "tampered");
  await assert.rejects(() => activateRelease(join(root, "releases"), "0.1.0", manifest), /checksum mismatch: VM template/);
  await assert.rejects(() => expandTemplate(download, { ...template, sha256: "0".repeat(64) }, join(root, "refused.img")), /does not match the signed manifest/);
  await assert.rejects(() => stat(join(root, "refused.img")));
  await assert.rejects(() => verifyRelease(download, { ...manifest, template: { ...template, parts: ["unlisted"] } }), /invalid VM template entry/);
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
  const plists = ["com.localbox.hostd.plist", "com.localbox.updater.plist", "com.localbox.connector.plist"];
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
