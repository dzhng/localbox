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
    root: "/tmp/localbox-machine", credentials: "/tmp/localbox-machine/credentials.json", ipcToken: "/tmp/localbox-machine/ipc-token", socket: "/tmp/localbox-machine/agent.sock", hostdLock: "/tmp/localbox-machine/hostd.lock", sandboxes: "/tmp/localbox-machine/sandboxes", operations: "/tmp/localbox-machine/operations", images: "/tmp/localbox-machine/images", logs: "/tmp/localbox-machine/logs",
  });
});

test("a development build of the app gets its own root, logs and credential, beside the release's", () => {
  const home = "/Users/someone";
  const dev = machinePaths({ HOME: home }, { path: "/tmp/build/Localbox Dev.app", id: "sh.localbox.mac.dev" });
  assert.equal(dev.root, `${home}/Library/Application Support/Localbox Dev`);
  assert.equal(dev.credentials, `${dev.root}/credentials.json`);
  assert.equal(dev.logs, `${home}/Library/Logs/Localbox Dev`);
  const release = machinePaths({ HOME: home }, { path: "/Applications/Localbox.app", id: "sh.localbox.mac" });
  assert.equal(release.root, `${home}/Library/Application Support/Localbox`);
  assert.equal(release.credentials, `${home}/.config/localbox/credentials.json`);
  assert.equal(release.logs, `${home}/Library/Logs/Localbox`);
  assert.equal(machinePaths({ HOME: home, LOCALBOX_MACHINE_ROOT: "/tmp/m" }, { path: "/x/Localbox Dev.app", id: "sh.localbox.mac.dev" }).root, "/tmp/m", "a relocated root wins");
});
