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
    readinessMarker: "/run/agent-computer/ready",
  };
  assert.equal(verifyImage(manifest, { expectedInventoryDigest: "sha256:inventory", expectedReadinessMarker: "/run/agent-computer/ready" }).ok, true);
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
