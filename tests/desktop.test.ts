import test from "node:test";
import assert from "node:assert/strict";
import { DesktopRuntime } from "../packages/desktop/src/index.js";

test("desktop uses fixed geometry and generation-local browser targets", async () => {
  const runtime = new DesktopRuntime();
  const tab = runtime.open("https://example.test");
  assert.equal(runtime.snapshot().width, 1440);
  assert.equal(runtime.snapshot().height, 900);
  assert.equal(runtime.getTab(tab.tab_id).url, "https://example.test");
  runtime.reset();
  assert.throws(() => runtime.getTab(tab.tab_id), /stale/);
});

test("desktop reaps after demand disappears", async () => {
  const runtime = new DesktopRuntime();
  runtime.acquireViewer();
  await runtime.ensureStarted();
  assert.equal(runtime.phase, "ready");
  runtime.releaseViewer(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.phase, "stopped");
});
