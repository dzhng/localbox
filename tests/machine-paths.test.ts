import assert from "node:assert/strict";
import { test } from "node:test";
import { machinePaths } from "../packages/config/src/machine-paths.js";

test("machine paths use the platform defaults and credentials config", () => {
  const paths = machinePaths();
  assert.equal(paths.credentials, `${process.env.HOME}/.config/localbox/credentials.json`);
  assert.match(paths.root, /Library\/Application Support\/Localbox$/);
});

test("machine root relocates every machine path", () => {
  assert.deepEqual(machinePaths({ LOCALBOX_MACHINE_ROOT: "/tmp/localbox-machine" }), {
    root: "/tmp/localbox-machine", credentials: "/tmp/localbox-machine/credentials.json", ipcToken: "/tmp/localbox-machine/ipc-token", socket: "/tmp/localbox-machine/agent.sock", sandboxes: "/tmp/localbox-machine/sandboxes", sandboxMirror: "/tmp/localbox-machine/sandboxes.json", logs: "/tmp/localbox-machine/logs",
  });
});
