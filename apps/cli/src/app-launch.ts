import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import type { MachinePaths } from "../../../packages/config/src/index.js";
import type { Layout } from "./layout.js";

const execFileAsync = promisify(execFile);

export interface AppLaunchOptions {
  env?: NodeJS.ProcessEnv;
  /** Starts the app without focusing it; rejects when the launch fails. */
  launch?: (app: string) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  retryDelayMs?: number;
}

/** `ready`: the daemon answers, or this CLI has no app to start. `failed`: the message for the retryable local-transport error. */
export type AppLaunch = { state: "ready" } | { state: "failed"; message: string };

/**
 * Spike 01's hands-off launch: `launchctl asuser` puts `open` in the user's GUI session even from SSH, and `-g` keeps
 * the app from taking focus.
 */
export async function openQuietly(app: string): Promise<void> {
  await execFileAsync("/bin/launchctl", ["asuser", String(process.getuid!()), "/usr/bin/open", "-g", app]);
}

/**
 * Starts Localbox.app when this CLI lives in it and its daemon is not answering, then waits for the daemon's socket,
 * so a command run while the app is quit still works (the user chose a quiet launch over a refusal). A checkout, the
 * old install, and any run on a relocated machine root (probes, tests) never launch an app.
 */
export async function ensureApp(layout: Pick<Layout, "app">, paths: Pick<MachinePaths, "socket">, options: AppLaunchOptions = {}): Promise<AppLaunch> {
  const env = options.env ?? process.env;
  if (!layout.app || env.LOCALBOX_MACHINE_ROOT || await answers(paths.socket)) return { state: "ready" };
  const launch = options.launch ?? openQuietly;
  const timeoutMs = options.timeoutMs ?? 20_000, intervalMs = options.intervalMs ?? 250;
  try { await launch(layout.app); }
  catch {
    // Spike 02 saw `open` fail about once in 70 launches, right after the app exited; a second try succeeds.
    await sleep(options.retryDelayMs ?? 1_000);
    try { await launch(layout.app); }
    catch (error) { return { state: "failed", message: `Localbox could not be started (${launchError(error)}); open Localbox from Applications` }; }
  }
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    if (await answers(paths.socket)) return { state: "ready" };
    await sleep(intervalMs);
  }
  return { state: "failed", message: `Localbox did not start within ${Math.round(timeoutMs / 1000)} s; open Localbox from Applications` };
}

/** True when something accepts a connection on the daemon's socket; a missing file and a refusal are both false. */
function answers(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = createConnection(socket);
    const done = (up: boolean) => { connection.destroy(); resolve(up); };
    connection.setTimeout(1_000, () => done(false));
    connection.once("connect", () => done(true));
    connection.once("error", () => done(false));
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const launchError = (error: unknown) => (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
