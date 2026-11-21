import { spawn, type ChildProcess } from "node:child_process";
import type { HandlerRegistry } from "../../../packages/runtime/src/index.js";

/**
 * macOS 27 puts "localbox-agent is requesting to bypass the system private window picker" over a granted screen
 * capture, and Apple's restriction against it doesn't survive a reboot of an unmanaged Mac. The desktop role holds
 * Accessibility, so it keeps one `localbox-desktop guard-capture-prompt` running, which presses the prompt's Allow
 * whenever it appears, and starts it again a few seconds after it exits. Returns a function that stops it.
 */
export function guardCapturePrompt(helper: string, log: (message: string) => void, spawnGuard: (helper: string) => ChildProcess = (path) => spawn(path, ["guard-capture-prompt"], { stdio: ["ignore", "pipe", "pipe"] }), restartMs = 5_000): () => void {
  let child: ChildProcess | undefined; let stopped = false; let timer: NodeJS.Timeout | undefined;
  const start = () => {
    child = spawnGuard(helper);
    child.stdout?.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n").filter(Boolean)) log(line); });
    child.stderr?.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n").filter(Boolean)) log(line); });
    child.once("error", (error) => log(`capture prompt guard: ${error.message}`));
    child.once("exit", (code) => { if (!stopped) { log(`capture prompt guard exited (${code}); restarting`); timer = setTimeout(start, restartMs); } });
  };
  start();
  return () => { stopped = true; if (timer) clearTimeout(timer); child?.kill(); };
}

/**
 * The guard answers the prompt within a second, but macOS draws it over the very frame of a session's first capture.
 * So the desktop role makes that first capture itself, once at start: `localbox-desktop settle-capture-prompt` captures,
 * presses the prompt's Allow and exits. Resolves when it exits or fails, or after `limitMs`; never rejects.
 */
export function settleCapturePrompt(helper: string, log: (message: string) => void, spawnSettle: (helper: string) => ChildProcess = (path) => spawn(path, ["settle-capture-prompt"], { stdio: ["ignore", "pipe", "pipe"] }), limitMs = 30_000): Promise<void> {
  return new Promise((resolve) => {
    const child = spawnSettle(helper);
    const timer = setTimeout(() => { log("capture prompt settle took too long; captures go ahead"); child.kill(); resolve(); }, limitMs);
    const done = () => { clearTimeout(timer); resolve(); };
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n").filter(Boolean)) log(line); });
    child.once("error", (error) => { log(`capture prompt settle: ${error.message}`); done(); });
    child.once("exit", done);
  });
}

/** `desktop.screenshot` waits until `settled` (the first capture's prompt is answered); every other handler is as given. */
export function screenshotsAfter(settled: Promise<void>, handlers: HandlerRegistry): HandlerRegistry {
  const screenshot = handlers["desktop.screenshot"];
  if (!screenshot) return handlers;
  return { ...handlers, "desktop.screenshot": async (input, context) => { await settled; return screenshot(input, context); } };
}
