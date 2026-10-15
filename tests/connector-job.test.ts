import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { restartConnectorJob } from "../apps/cli/src/connector-job.js";

test("login leaves launchd alone for a relocated machine root or a fixture install", async () => {
  assert.deepEqual(await restartConnectorJob({ HOME: "/nonexistent", LOCALBOX_MACHINE_ROOT: "/tmp/machine-b" }), { state: "skipped" });
  assert.deepEqual(await restartConnectorJob({ HOME: "/nonexistent", LOCALBOX_SKIP_LAUNCHD: "1" }), { state: "skipped" });
});

test("without an installed connector job, login says so instead of starting one", async () => {
  const home = await mkdtemp(join(tmpdir(), "localbox-connector-job-"));
  try { assert.deepEqual(await restartConnectorJob({ HOME: home }), { state: "not_installed" }); }
  finally { await rm(home, { recursive: true, force: true }); }
});
