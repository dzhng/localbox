import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecoverySupervisor } from "../packages/recovery/src/index.js";
import { DurableVMRegistry } from "../packages/registry/src/index.js";
import { generateKeyPairSync } from "node:crypto";
import { makeManifest, signManifest, verifyManifestSignature, writeRelease, verifyRelease } from "../scripts/release.js";

test("recovery timeline reconnects and reaps desktop after demand grace", () => {
  let now = 1_000; const s = new RecoverySupervisor({ now: () => now, graceMs: 10 });
  s.transition("starting"); s.transition("running"); s.updateDemand(0, 1); s.onNetworkChanged(); s.channelRestored();
  s.updateDemand(0, 0); now += 11; s.tick();
  assert.equal(s.state, "running"); assert.equal(s.demand.desktop, "stopped"); assert.ok(s.timeline.some((e) => e.kind === "channel_lost"));
});

test("registry persists, reprovisions, and requires explicit reset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-computer-registry-")); const path = join(dir, "registry.json"); const disk = join(dir, "disk");
  const first = await new DurableVMRegistry(path).load(); await first.create({ vmId: "vm_a", imageDigest: "sha256:image", diskPath: disk });
  await writeFile(join(disk, "marker"), "kept"); await first.reprovision("vm_a"); const loaded = await new DurableVMRegistry(path).load();
  assert.equal((await readFile(join(disk, "marker"), "utf8")), "kept"); await assert.rejects(() => loaded.reset("vm_a", { discardState: false, confirm: "" }));
  await loaded.reset("vm_a", { discardState: true, confirm: "RESET" }); await assert.rejects(() => readFile(join(disk, "marker"), "utf8"));
});

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
