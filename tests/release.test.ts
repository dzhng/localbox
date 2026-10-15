import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { activateRelease, activeRelease, makeManifest, rollbackRelease, signManifest, verifyManifestSignature, writeRelease, verifyRelease } from "../scripts/release.js";

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
