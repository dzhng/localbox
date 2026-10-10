import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { checkForUpdate } from "../apps/cli/src/updater.js";

test("update check reads the latest GitHub release contract", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/latest") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ tag_name: "v0.2.0", html_url: "https://github.test/localbox/v0.2.0", assets: [] }));
      return;
    }
    response.statusCode = 404; response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const previousApi = process.env.LOCALBOX_RELEASE_API_URL;
  const previousVersion = process.env.LOCALBOX_CURRENT_VERSION;
  process.env.LOCALBOX_RELEASE_API_URL = `http://127.0.0.1:${address.port}/latest`;
  process.env.LOCALBOX_CURRENT_VERSION = "0.1.0";
  try {
    const result = await checkForUpdate();
    assert.equal(result.latestVersion, "0.2.0");
    assert.equal(result.updateAvailable, true);
  } finally {
    if (previousApi === undefined) delete process.env.LOCALBOX_RELEASE_API_URL; else process.env.LOCALBOX_RELEASE_API_URL = previousApi;
    if (previousVersion === undefined) delete process.env.LOCALBOX_CURRENT_VERSION; else process.env.LOCALBOX_CURRENT_VERSION = previousVersion;
    server.close();
  }
});
