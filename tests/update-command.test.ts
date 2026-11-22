import test from "node:test";
import assert from "node:assert/strict";
import { fstatSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { ContractError } from "../packages/contract/src/index.js";
import { updateCommand } from "../apps/cli/src/update.js";

const APP = "/Users/someone/Applications/Localbox.app";
const socketPath = () => join(mkdtempSync("/tmp/lb-update-"), "app.sock");
const launch = { env: {}, intervalMs: 20, retryDelayMs: 10, timeoutMs: 300, launch: async () => {} };

/**
 * Localbox.app's `update.*` as `AppControl` answers them, over a real socket. `states` is what successive
 * `update.status` calls see after a check or install; `quitAfter` closes the socket after that many answers, as an app
 * quitting to install does.
 */
function fakeApp(path: string, options: { states?: string[]; quitAfter?: number } = {}) {
  const seen: Array<{ operation: string; params: unknown }> = [];
  let enabled = true, state = "idle", answers = 0;
  const queue = [...(options.states ?? [])];
  const snapshot = () => ({ available: true, enabled, can_check: state === "idle", state, status: state === "waiting" ? "Waiting: sandboxes would restart. Install from Settings, or unlock this Mac." : null, version: state === "idle" ? null : "0.9.0" });
  const server: Server = createServer((connection) => {
    let buffered = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffered += chunk;
      if (!buffered.includes("\n")) return;
      const { id, operation, params } = JSON.parse(buffered.split("\n")[0]);
      seen.push({ operation, params });
      if (operation === "update.check" || operation === "update.install") state = queue.shift() ?? "idle";
      else if (operation === "update.status") state = queue.shift() ?? state;
      else if (operation === "update.set_automatic") enabled = params.enabled;
      else return connection.end(`${JSON.stringify({ id, ok: false, error: { code: "unsupported", message: `no ${operation}`, retryable: false } })}\n`);
      connection.end(`${JSON.stringify({ id, ok: true, result: snapshot() })}\n`);
      if (options.quitAfter !== undefined && ++answers >= options.quitAfter) server.close();
    });
  });
  return new Promise<{ server: Server; seen: typeof seen }>((resolve) => server.listen(path, () => resolve({ server, seen })));
}
const deps = (appSocket: string, extra = {}) => ({ layout: { app: APP }, paths: { appSocket }, launch, pollMs: 10, ...extra });

test("update check waits while Sparkle checks and downloads, and answers what it found", async () => {
  const appSocket = socketPath(), { server, seen } = await fakeApp(appSocket, { states: ["checking", "checking", "downloading", "waiting"] });
  try {
    const status = await updateCommand(["check"], deps(appSocket)) as Record<string, unknown>;
    assert.equal(status.state, "waiting");
    assert.equal(status.version, "0.9.0");
    assert.deepEqual(seen.map((request) => request.operation), ["update.check", "update.status", "update.status", "update.status"]);
  } finally { server.close(); }
});

test("update install lets go of its launch lock first, and an app that quits to install ends the wait with its last word", async () => {
  const appSocket = socketPath(), { server, seen } = await fakeApp(appSocket, { states: ["downloading", "downloading"], quitAfter: 2 });
  const lock = join(mkdtempSync("/tmp/lb-update-lock-"), "launch.lock"); writeFileSync(lock, "");
  const env = { LOCALBOX_LAUNCH_LOCK_FD: String(openSync(lock, "r")) };
  const status = await updateCommand(["install"], deps(appSocket, { env })) as Record<string, unknown>;
  assert.equal(status.state, "downloading");
  assert.deepEqual(seen.map((request) => request.operation), ["update.install", "update.status"]);
  assert.throws(() => fstatSync(Number(env.LOCALBOX_LAUNCH_LOCK_FD ?? -1)), "the descriptor is closed");
  assert.equal(env.LOCALBOX_LAUNCH_LOCK_FD, undefined);
  server.close();
});

test("update status and update automatic on|off are one request each", async () => {
  const appSocket = socketPath(), { server, seen } = await fakeApp(appSocket);
  try {
    assert.equal((await updateCommand(["automatic", "off"], deps(appSocket)) as Record<string, unknown>).enabled, false);
    assert.equal((await updateCommand(["status"], deps(appSocket)) as Record<string, unknown>).enabled, false);
    assert.equal((await updateCommand(["automatic", "on"], deps(appSocket)) as Record<string, unknown>).enabled, true);
    assert.deepEqual(seen, [{ operation: "update.set_automatic", params: { enabled: false } }, { operation: "update.status", params: {} }, { operation: "update.set_automatic", params: { enabled: true } }]);
  } finally { server.close(); }
});

test("anything else is refused before the app is asked", async () => {
  for (const words of [["automatic"], ["automatic", "maybe"], ["check", "now"], ["rollback"]]) {
    await assert.rejects(updateCommand(words, deps("/tmp/lb-no-app.sock")), (error: unknown) => error instanceof ContractError && error.code === "invalid_input", words.join(" "));
  }
});
