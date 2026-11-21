import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { guardCapturePrompt, screenshotsAfter, settleCapturePrompt } from "../apps/guest-agent/src/capture-prompt.js";

/** A fake guard process: its stdout is writable from the test, and `exit` ends it. */
function fakeGuard() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stdout = new PassThrough(); const stderr = new PassThrough();
  Object.assign(child, { stdout, stderr, kill: () => { child.emit("exit", null); return true; } });
  return { child, say: (line: string) => stdout.write(`${line}\n`), exit: (code: number) => child.emit("exit", code) };
}
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("the desktop role keeps one capture-prompt guard running, logs each answered prompt and restarts it after an exit", async () => {
  const guards: ReturnType<typeof fakeGuard>[] = []; const lines: string[] = []; const spawned: string[] = [];
  const stop = guardCapturePrompt("/usr/local/localbox/localbox-desktop", (line) => lines.push(line), (helper) => { spawned.push(helper); const guard = fakeGuard(); guards.push(guard); return guard.child; }, 10);
  assert.deepEqual(spawned, ["/usr/local/localbox/localbox-desktop"]);
  guards[0].say("allowed the window-picker bypass prompt shown by UserNotificationCenter");
  await tick();
  assert.ok(lines.includes("allowed the window-picker bypass prompt shown by UserNotificationCenter"));
  guards[0].exit(1);
  await tick(40);
  assert.equal(guards.length, 2, "started again after it exited");
  stop();
  await tick(40);
  assert.equal(guards.length, 2, "a stopped guard is not restarted");
});

test("a desktop screenshot waits until the session's first capture has brought the prompt up and it was answered", async () => {
  const settle = fakeGuard(); const lines: string[] = []; const order: string[] = [];
  const settled = settleCapturePrompt("/usr/local/localbox/localbox-desktop", (line) => lines.push(line), () => settle.child, 5_000);
  const handlers = screenshotsAfter(settled, { "desktop.screenshot": async () => { order.push("captured"); return { data: "data:image/jpeg;base64," }; }, "desktop.status": async () => { order.push("status"); return {}; } } as any);
  const shot = handlers["desktop.screenshot"]!({}, {} as any);
  await handlers["desktop.status"]!({}, {} as any);
  await tick();
  assert.deepEqual(order, ["status"], "status answers at once; the screenshot waits");
  settle.say("allowed the window-picker bypass prompt shown by UserNotificationCenter before the first capture");
  settle.exit(0);
  await shot;
  assert.deepEqual(order, ["status", "captured"]);
  assert.ok(lines.some((line) => line.includes("before the first capture")));
});

test("a settle that never exits lets screenshots go ahead after its limit", async () => {
  const settle = fakeGuard(); const lines: string[] = [];
  await settleCapturePrompt("/usr/local/localbox/localbox-desktop", (line) => lines.push(line), () => settle.child, 30);
  assert.ok(lines.some((line) => line.includes("took too long")));
});
