import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { ContractError } from "../packages/contract/src/index.js";
import { askApp, NEEDS_APP } from "../apps/cli/src/app-socket.js";
import { appLoginItem, appStatus } from "../apps/cli/src/app.js";

const APP = "/Users/someone/Applications/Localbox.app";
// Socket paths are limited to 104 bytes, so not under the long per-user tmpdir.
const socketPath = () => join(mkdtempSync("/tmp/lb-appsock-"), "app.sock");

/** A stand-in for Localbox.app's `AppSocket`: one JSON line in, one out, answered as `AppControl` would. */
function fakeApp(path: string, seen: Array<{ operation: string; params: unknown }> = []): Promise<Server> {
  let loginItem = "disabled";
  const server = createServer((connection) => {
    let buffered = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffered += chunk;
      if (!buffered.includes("\n")) return;
      const { id, operation, params } = JSON.parse(buffered.split("\n")[0]);
      seen.push({ operation, params });
      const ok = (result: unknown) => connection.end(`${JSON.stringify({ id, ok: true, result })}\n`);
      if (operation === "app.info") ok({ version: "0.1.0", build: "dev", in_applications: false, children: { daemon: "running", connector: "backing_off" }, stopping: null });
      else if (operation === "login_item.get") ok({ state: loginItem });
      else if (operation === "login_item.set") { loginItem = params.enabled ? "requires_approval" : "disabled"; ok({ state: loginItem }); }
      else connection.end(`${JSON.stringify({ id, ok: false, error: { code: "unsupported", message: `this Localbox app (0.1.0) does not answer ${operation}`, retryable: false } })}\n`);
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

const refusal = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { assert.ok(error instanceof ContractError, String(error)); return { code: error.code, message: error.message, retryable: error.retryable }; }
  assert.fail("expected a refusal");
};
const launch = { env: {}, intervalMs: 20, retryDelayMs: 10, timeoutMs: 300, launch: async () => {} };

test("app status is the app's app.info plus the login item; login-item on and off change it", async () => {
  const appSocket = socketPath(), seen: Array<{ operation: string; params: unknown }> = [];
  const server = await fakeApp(appSocket, seen);
  try {
    const deps = { layout: { app: APP }, paths: { appSocket }, launch };
    assert.deepEqual(await appStatus(deps), {
      version: "0.1.0", build: "dev", in_applications: false, children: { daemon: "running", connector: "backing_off" }, stopping: null,
      login_item: { state: "disabled" },
    });
    assert.deepEqual(await appLoginItem(true, deps), { state: "requires_approval" });
    assert.deepEqual(await appLoginItem(undefined, deps), { state: "requires_approval" });
    assert.deepEqual(await appLoginItem(false, deps), { state: "disabled" });
    assert.deepEqual(seen.map((request) => request.operation), ["app.info", "login_item.get", "login_item.set", "login_item.get", "login_item.set"]);
    assert.deepEqual(seen[2].params, { enabled: true });
  } finally { server.close(); }
});

test("an operation the running app does not know comes back as its unsupported refusal", async () => {
  const appSocket = socketPath(), server = await fakeApp(appSocket);
  try {
    assert.deepEqual(await refusal(askApp({ app: APP }, { appSocket }, "update.status" as never, {}, launch)),
      { code: "unsupported", message: "this Localbox app (0.1.0) does not answer update.status", retryable: false });
  } finally { server.close(); }
});

test("an app that never answers its socket after the launch is a retryable refusal naming the wait", async () => {
  let launched = 0;
  const result = await refusal(appStatus({ layout: { app: APP }, paths: { appSocket: socketPath() }, launch: { ...launch, timeoutMs: 1_000, launch: async () => { launched++; } } }));
  assert.equal(launched, 1, "ensureApp launched the app once");
  assert.deepEqual(result, { code: "guest_unreachable", message: "Localbox did not start within 1 s; open Localbox from Applications", retryable: true });
});

test("on a relocated root (no launch), a missing app socket is a retryable refusal, not a hang", async () => {
  const result = await refusal(appStatus({ layout: { app: APP }, paths: { appSocket: socketPath() }, launch: { ...launch, env: { LOCALBOX_MACHINE_ROOT: "/tmp/somewhere" } } }));
  assert.equal(result.code, "guest_unreachable"); assert.equal(result.retryable, true);
  assert.match(result.message, /^Localbox is not running \(ENOENT\)/);
});

test("a CLI outside Localbox.app refuses with unsupported before trying anything", async () => {
  const launchOptions = { ...launch, launch: async () => { throw new Error("must not launch"); } };
  for (const call of [appStatus({ layout: { app: null }, paths: { appSocket: socketPath() }, launch: launchOptions }), appLoginItem(true, { layout: { app: null }, paths: { appSocket: socketPath() }, launch: launchOptions })])
    assert.deepEqual(await refusal(call), { code: "unsupported", message: NEEDS_APP, retryable: false });
});
