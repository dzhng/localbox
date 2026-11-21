import { spawn, type ChildProcess } from "node:child_process";

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
