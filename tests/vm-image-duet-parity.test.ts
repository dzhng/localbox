import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compareParity, parseDuetDockerfile, parseLocalboxFullDockerfile, parseRequirements } from "../packages/vm-image/scripts/duet-parity.js";

test("ARM64 full profile matches the vendored Duet apt, pip, and npm inventories and Chrome version", async () => {
  const [duetText, localText, requirements] = await Promise.all([
    readFile("packages/vm-image/duet-reference/Dockerfile", "utf8"),
    readFile("packages/vm-image/Dockerfile.arm64", "utf8"),
    readFile("packages/vm-image/requirements-arm64.txt", "utf8"),
  ]);
  const result = compareParity(parseDuetDockerfile(duetText), { ...parseLocalboxFullDockerfile(localText), pip: parseRequirements(requirements) }, requirements);
  assert.deepEqual(result, { ok: true, differences: [] });
});

test("parity reports an unapproved full-profile package drift", () => {
  const duet = { apt: ["curl"], pip: ["requests"], npm: ["typescript"] };
  const local = { apt: ["curl", "unapproved"], pip: ["requests"], npm: ["typescript"] };
  assert.deepEqual(compareParity(duet, local, "requests==1\n"), { ok: false, differences: ["apt extra: unapproved"] });
});

test("parity reports a Google Chrome version that differs from Duet's", () => {
  const duet = { apt: [], pip: [], npm: [], chrome: "151.0.7922.137-1" };
  const local = { apt: [], pip: [], npm: [], chrome: "155.0.8059.84-1" };
  assert.deepEqual(compareParity(duet, local, ""), { ok: false, differences: ["google-chrome-stable: Duet 151.0.7922.137-1, Localbox 155.0.8059.84-1"] });
});
