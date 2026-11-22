import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appPaths } from "../apps/cli/src/app.js";

test("app paths creates the machine directories and the IPC token once, and keeps the token after", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "localbox-app-paths-")), "machine");
  const env = { LOCALBOX_MACHINE_ROOT: root, HOME: "/nonexistent-home", LOCALBOX_BIN_DIR: join(root, "bin") };
  const first = await appPaths(env);
  assert.deepEqual(first, {
    root, credentials: join(root, "credentials.json"), ipc_token: join(root, "ipc-token"), socket: join(root, "agent.sock"), hostd_lock: join(root, "hostd.lock"), app_socket: join(root, "app.sock"),
    sandboxes: join(root, "sandboxes"), operations: join(root, "operations"), images: join(root, "images"), logs: join(root, "logs"), bin_dir: join(root, "bin"),
  });
  for (const directory of [first.root, first.sandboxes, first.operations, first.images, first.logs]) assert.ok((await stat(directory)).isDirectory(), directory);
  const token = await readFile(first.ipc_token, "utf8");
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal((await stat(first.ipc_token)).mode & 0o777, 0o600);

  assert.deepEqual(await appPaths(env), first);
  assert.equal(await readFile(first.ipc_token, "utf8"), token, "a second run keeps the token the daemon and clients already read");
});
