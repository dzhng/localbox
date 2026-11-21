import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { checkForUpdate, installLatest } from "../apps/cli/src/updater.js";
import { signManifest, type ReleaseManifest } from "../scripts/release.js";

/** A stand-in GitHub release API on loopback, with LOCALBOX_* pointed at it for the duration of `body`. */
async function withRelease(handler: (base: string) => RequestListener, env: Record<string, string>, body: () => Promise<void>): Promise<void> {
  let base = "";
  const server = createServer((request, response) => handler(base)(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const values: Record<string, string> = { LOCALBOX_RELEASE_API_URL: `${base}/latest`, LOCALBOX_CURRENT_VERSION: "0.1.0", ...env };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await body(); } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    server.close();
  }
}

test("update check reads the latest GitHub release contract", async () => {
  await withRelease(() => (request, response) => {
    if (request.url === "/latest") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ tag_name: "v0.2.0", html_url: "https://github.test/localbox/v0.2.0", assets: [] }));
      return;
    }
    response.statusCode = 404; response.end();
  }, {}, async () => {
    const result = await checkForUpdate();
    assert.equal(result.latestVersion, "0.2.0");
    assert.equal(result.updateAvailable, true);
  });
});

test("an update downloads every signed artifact, the linux image's included, and refuses a release missing one", async () => {
  const keys = generateKeyPairSync("ed25519");
  const artifact = (name: string) => ({ name, sha256: "0".repeat(64), size: 1, arch: "arm64" as const });
  const image = { sha256: "0".repeat(64), size: 1, parts: ["localbox-linux-0.2.0.disk.img.zst.000"], bootStore: "localbox-linux-0.2.0.efi-vars", manifest: "localbox-linux-0.2.0.image.json" };
  const unsigned: ReleaseManifest = { schema: "agent-computer.release.v1", version: "0.2.0", imageDigest: `sha256:${"0".repeat(64)}`, minimumMacOS: "14.0", image,
    artifacts: ["Localbox-0.2.0.zip", "localbox-cli-0.2.0.tar.gz", ...image.parts, image.bootStore, image.manifest].map(artifact) };
  const manifest = signManifest(unsigned, keys.privateKey, "test");
  // Every artifact is published except the image's boot store.
  const published = ["release.json", ...manifest.artifacts.map((entry) => entry.name).filter((name) => name !== image.bootStore)];
  const fetched: string[] = [];
  await withRelease((base) => (request, response) => {
    if (request.url === "/latest") {
      response.end(JSON.stringify({ tag_name: "v0.2.0", assets: published.map((name) => ({ name, browser_download_url: `${base}/assets/${name}` })) }));
      return;
    }
    const name = request.url?.replace("/assets/", "") ?? "";
    fetched.push(name);
    response.end(name === "release.json" ? JSON.stringify(manifest) : "x");
  }, { LOCALBOX_RELEASE_PUBLIC_KEY: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }, async () => {
    await assert.rejects(() => installLatest(), /GitHub release is missing localbox-linux-0\.2\.0\.efi-vars/);
    assert.deepEqual(fetched, ["release.json", "Localbox-0.2.0.zip", "localbox-cli-0.2.0.tar.gz", ...image.parts]);
  });
});
