import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { ensureApp } from "../apps/cli/src/app-launch.js";

const APP = "/Users/someone/Applications/Localbox.app";
// Socket paths are limited to 104 bytes, so not under the long per-user tmpdir.
const socketPath = () => join(mkdtempSync("/tmp/lb-launch-"), "agent.sock");
const listen = (path: string) => new Promise<Server>((resolve) => { const server = createServer((connection) => connection.end()); server.listen(path, () => resolve(server)); });
const fast = { env: {}, intervalMs: 20, retryDelayMs: 10 };

test("a daemon that answers is used as it is; no app is launched", async () => {
  const socket = socketPath(), server = await listen(socket);
  try {
    const launched: string[] = [];
    assert.deepEqual(await ensureApp({ app: APP }, { socket }, { ...fast, launch: async (app) => { launched.push(app); } }), { state: "ready" });
    assert.deepEqual(launched, []);
  } finally { server.close(); }
});

test("with the app quit, the CLI launches it and waits for the daemon's socket", async () => {
  const socket = socketPath(); let server: Server | undefined;
  const launched: string[] = [];
  try {
    const started = await ensureApp({ app: APP }, { socket }, { ...fast, launch: async (app) => { launched.push(app); setTimeout(async () => { server = await listen(socket); }, 150); } });
    assert.deepEqual(started, { state: "ready" }); assert.deepEqual(launched, [APP]);
  } finally { server?.close(); }
});

test("a failed launch is retried once; a second failure gives up at once", async () => {
  const socket = socketPath(); let server: Server | undefined, attempts = 0;
  try {
    const flaky = async () => { if (++attempts === 1) throw new Error("LSOpenURLsWithRole() failed"); server = await listen(socket); };
    assert.deepEqual(await ensureApp({ app: APP }, { socket }, { ...fast, launch: flaky }), { state: "ready" }); assert.equal(attempts, 2);
  } finally { server?.close(); }
  attempts = 0;
  const broken = await ensureApp({ app: APP }, { socket: socketPath() }, { ...fast, launch: async () => { attempts++; throw new Error("LSOpenURLsWithRole() failed"); } });
  assert.equal(attempts, 2); assert.equal(broken.state, "failed");
  assert.match((broken as { message: string }).message, /could not be started \(LSOpenURLsWithRole\(\) failed\); open Localbox from Applications/);
});

test("an app whose daemon never answers times out with the retryable message", async () => {
  const before = Date.now();
  const result = await ensureApp({ app: APP }, { socket: socketPath() }, { ...fast, timeoutMs: 1_000, launch: async () => {} });
  assert.deepEqual(result, { state: "failed", message: "Localbox did not start within 1 s; open Localbox from Applications" });
  assert.ok(Date.now() - before >= 1_000);
});

test("a relocated machine root (probes, tests) and a CLI with no app never launch anything", async () => {
  const launch = async () => { throw new Error("must not launch"); };
  assert.deepEqual(await ensureApp({ app: APP }, { socket: socketPath() }, { ...fast, env: { LOCALBOX_MACHINE_ROOT: "/tmp/somewhere" }, launch }), { state: "ready" });
  assert.deepEqual(await ensureApp({ app: null }, { socket: socketPath() }, { ...fast, launch }), { state: "ready" });
});
