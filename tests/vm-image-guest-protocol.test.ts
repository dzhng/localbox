import test from "node:test";
import assert from "node:assert/strict";
import { DUET_REQUIRED_TOOL_INVENTORY, DUET_REQUIRED_TOOL_NAMES } from "../packages/vm-image/src/duet-inventory.js";
import { digestManifest, verifyImage, verifyToolInventory } from "../packages/vm-image/src/index.js";
import { decodeGuestFrames, encodeGuestFrame, inventoryDigest, type GuestFrame } from "../packages/guest-gateway/src/protocol.js";

test("image manifest digest is canonical across object key order", () => {
  const a = { architecture: "arm64", digest: "ignored", display: { width: 1440, height: 900 }, binaries: ["node"], loopbackBindings: ["127.0.0.1"] };
  const b = { loopbackBindings: ["127.0.0.1"], binaries: ["node"], display: { height: 900, width: 1440 }, architecture: "arm64" };
  const { digest: _a, ...aa } = a;
  const { digest: _b, ...bb } = b as typeof a;
  assert.equal(digestManifest(aa), digestManifest(bb));
});

test("Duet inventory is explicit and rejects x86-only entries", () => {
  const result = verifyToolInventory(DUET_REQUIRED_TOOL_INVENTORY, DUET_REQUIRED_TOOL_NAMES);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, []);
  const bad = verifyToolInventory([{ ...DUET_REQUIRED_TOOL_INVENTORY[0], architecture: "x86_64" }], [DUET_REQUIRED_TOOL_NAMES[0]]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.invalid, [DUET_REQUIRED_TOOL_NAMES[0]]);
});

test("image verification checks inventory and readiness metadata", () => {
  const manifest = {
    architecture: "arm64",
    digest: "sha256:image",
    display: { width: 1440, height: 900 },
    binaries: ["node"],
    loopbackBindings: ["127.0.0.1:9222"],
    inventoryDigest: "sha256:inventory",
    readinessMarker: "/run/localbox/ready",
  };
  assert.equal(verifyImage(manifest, { expectedInventoryDigest: "sha256:inventory", expectedReadinessMarker: "/run/localbox/ready" }).ok, true);
  assert.equal(verifyImage(manifest, { expectedInventoryDigest: "sha256:wrong" }).ok, false);
});

test("guest frames use bounded length-prefix framing and preserve partial buffers", () => {
  const frame: GuestFrame = { kind: "ready", channel_epoch: 3, vm_id: "vm_01", inventory_digest: inventoryDigest(["node", "python3"]), readiness_marker: "READY" };
  const encoded = encodeGuestFrame(frame);
  const first = decodeGuestFrames(encoded.subarray(0, 5));
  assert.deepEqual(first.frames, []);
  assert.ok(first.remainder.length > 0);
  const decoded = decodeGuestFrames(Buffer.concat([first.remainder, encoded.subarray(5)]));
  assert.deepEqual(decoded.frames, [frame]);
  assert.equal(decoded.remainder.length, 0);
});

test("ARM64 image manifest binds pinned inputs and full Duet inventory", async () => {
  const { buildImageManifest, digestJson, inventoryDigestForTools } = await import("../packages/vm-image/src/manifest.js");
  const pins = {
    schemaVersion: "agent-computer-image-build.v1" as const,
    architecture: "arm64" as const,
    baseImage: "debian:bookworm-slim@sha256:" + "a".repeat(64),
    baseSnapshot: "20250929T000000Z",
    packages: { python3: "3.11", chromium: "123.0" },
    pythonRequirementsSha256: "sha256:" + "b".repeat(64),
    buildVersion: "test",
    display: { width: 1440, height: 900 },
    loopbackBindings: ["127.0.0.1:9222", "127.0.0.1:5900"],
    readinessMarker: "/run/localbox/ready",
  };
  const tools = DUET_REQUIRED_TOOL_INVENTORY.map((tool) => ({ ...tool, version: "test" }));
  const manifest = buildImageManifest({ pins, tools, artifacts: { "disk.raw": "sha256:" + "c".repeat(64) } });
  assert.equal(manifest.architecture, "arm64");
  assert.equal(manifest.buildInputsDigest, digestJson(pins));
  assert.equal(manifest.inventoryDigest, inventoryDigestForTools(tools));
  assert.equal(manifest.artifactDigests?.["disk.raw"], "sha256:" + "c".repeat(64));
  assert.equal(manifest.digest, digestJson({ ...manifest, digest: undefined }));
});

test("Duet probes distinguish executable tools from Python imports", () => {
  // This is the same machine-readable distinction used by the in-image probe;
  // a name-only manifest cannot accidentally satisfy a Python import check.
  assert.equal(DUET_REQUIRED_TOOL_INVENTORY.find((tool) => tool.name === "python3")?.kind, "binary");
  assert.equal(DUET_REQUIRED_TOOL_INVENTORY.find((tool) => tool.name === "pandas")?.kind, "python");
});
