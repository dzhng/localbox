import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProofContext } from "../run.js";
import { LocalIPCTransport } from "../../../packages/client/src/index.js";
import { machinePaths } from "../../../packages/config/src/index.js";
import { PROTOCOL_VERSION, type Json, type ResponseEnvelope } from "../../../packages/contract/src/index.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** What a Finder or `open` launch inherits from launchd: no developer shell, no toolchain on PATH. */
const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface Processes { app: number | undefined; daemons: Array<{ pid: number; ppid: number }>; connectors: Array<{ pid: number; ppid: number }>; imageEnsures: Array<{ pid: number; ppid: number }> }

/**
 * Proof tier `a` (specs/menu-bar-app, A13): the development Localbox.app assembled by apps/macos/App/scripts/build-app.mjs
 * into a scratch directory, launched with `open -g` as an agent or Finder would, with a scratch HOME and machine root
 * so nothing touches this account's Localbox, skill or `localbox` command. The app must never take focus: `start`
 * watches the frontmost app while it launches. Only processes running from this run's bundle are ever signalled.
 *
 * `backend` picks the daemon's sandboxes: `process-fixture` (tier a; the guest agent runs as a local process, so
 * the daemon also gets this checkout and Node on PATH) or `apple` (tier v, real VMs).
 */
export function packagedApp(ctx: ProofContext, options: { probe: string; backend: "process-fixture" | "apple" }) {
  // Under /tmp, so the daemon's socket path stays far below the Unix limit whatever the checkout's path.
  const scratch = realpathSync(mkdtempSync(`/tmp/lb-a${options.probe}-`));
  const home = join(scratch, "home"), root = join(scratch, "machine");
  mkdirSync(home);
  const paths = machinePaths({ LOCALBOX_MACHINE_ROOT: root });
  const fixture = options.backend === "process-fixture";
  const env: Record<string, string> = {
    HOME: home, LOCALBOX_MACHINE_ROOT: root, LOCALBOX_SANDBOX_BACKEND: options.backend,
    // SMAppService matches by bundle id, not path, so a scratch bundle's real login item would be this account's.
    LOCALBOX_APP_LOGIN_ITEM: "fake",
    // The app fetches the built-in image at launch; a probe never reaches GitHub. An empty folder makes that fetch fail
    // at once, and a probe that wants the download serves a scratch release in its place (probe 43).
    LOCALBOX_RELEASE_URL: pathToFileURL(join(scratch, "no-release")).href,
    PATH: fixture ? `${dirname(process.execPath)}:${FINDER_PATH}` : FINDER_PATH,
    ...(fixture ? { LOCALBOX_DEV: "1", LOCALBOX_REPO_ROOT: ctx.root } : {}),
  };
  let bundle = "";
  const executable = () => join(bundle, "Contents/MacOS/Localbox");

  /** Every process running from this run's bundle, by kind; nothing else on this Mac is ever listed. */
  const processes = (): Processes => {
    // LaunchServices names the bundle by its realpath (/private/tmp), a shell by the path it was given (/tmp).
    const plain = (path: string) => path.replaceAll("/private/tmp/", "/tmp/"), here = plain(bundle);
    const rows = !bundle ? [] : execFileSync("ps", ["-axwwo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((row): row is RegExpMatchArray => !!row && plain(row[3]).includes(here));
    const of = (test: (command: string) => boolean) => rows.filter((row) => test(plain(row[3]))).map((row) => ({ pid: Number(row[1]), ppid: Number(row[2]) }));
    return {
      app: of((command) => command.startsWith(join(here, "Contents/MacOS/Localbox")))[0]?.pid,
      daemons: of((command) => command.startsWith(join(here, "Contents/MacOS/localbox-hostd"))),
      connectors: of((command) => command.includes("connector run")),
      imageEnsures: of((command) => command.includes("app image ensure")),
    };
  };
  /** The frontmost app's pid, as LaunchServices reports it (loginwindow while the screen is locked). */
  const front = (): number | undefined => {
    try {
      const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
      return Number(/pid\s*=\s*(\d+)/.exec(execFileSync("lsappinfo", ["info", "-only", "pid", asn], { encoding: "utf8" }))?.[1]) || undefined;
    } catch { return undefined; }
  };

  /**
   * Assembles the development bundle into the scratch directory, or into `into` (the scratch HOME's Applications, say),
   * replacing one there; `version` replaces package.json's, `publicKey` the release key the bundle pins (a scratch one).
   */
  const build = async (options: { into?: string; version?: string; publicKey?: string } = {}) => {
    const built = await ctx.exec("node", ["apps/macos/App/scripts/build-app.mjs", "--out", options.into ?? scratch, ...(options.version ? ["--version", options.version] : []), ...(options.publicKey ? ["--public-key", options.publicKey] : [])]);
    assert.equal(built.code, 0, `build-app.mjs: ${built.stderr.slice(-1500)}`);
    bundle = built.stdout.trim().split("\n").at(-1)!;
    assert.ok(existsSync(executable()), `no app at ${bundle}`);
    return bundle;
  };

  /**
   * `open -g` with the scratch environment, then waits for the daemon's socket to answer; returns the app's pid. Fails
   * if the app was ever the frontmost app while it started. `extra` adds launch environment (a stub, say).
   */
  const start = async (extra: Record<string, string> = {}, timeoutMs = 60_000) => {
    assert.equal(processes().app, undefined, "an app from this bundle is already running");
    const fronts = new Set<number>();
    const args = ["-g", "-n", ...Object.entries({ ...env, ...extra }).flatMap(([key, value]) => ["--env", `${key}=${value}`]), bundle];
    const opened = await ctx.exec("/usr/bin/open", args);
    assert.equal(opened.code, 0, `open: ${opened.stderr}`);
    let app: number | undefined;
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(100)) {
      const now = front(); if (now !== undefined) fronts.add(now);
      app ??= processes().app;
      if (app && await answers()) break;
    }
    assert.ok(app, "the app did not start");
    assert.ok(!fronts.has(app), "the app became the frontmost app");
    await waitForSocket(1_000);
    return app;
  };

  /** True when the daemon accepts a connection on its socket. */
  const answers = () => new Promise<boolean>((resolve) => {
    const connection = createConnection(paths.socket);
    const done = (up: boolean) => { connection.destroy(); resolve(up); };
    connection.setTimeout(1_000, () => done(false)); connection.once("connect", () => done(true)); connection.once("error", () => done(false));
  });

  const waitForSocket = async (timeoutMs = 60_000) => {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(100)) if (await answers()) return;
    throw new Error(`the daemon's socket did not answer within ${timeoutMs / 1000} s; ${tail("app.log")}`);
  };

  /** `localbox <args> --json` through the bundle's own CLI (its Node, its dist), in the app's environment; parsed. */
  const cli = async (args: string[]): Promise<any> => {
    const result = await ctx.exec(join(bundle, "Contents/Resources/cli/localbox"), [...args, "--json"], { env: { ...env, PATH: FINDER_PATH } });
    try { return JSON.parse(result.stdout); } catch { throw new Error(`localbox ${args.join(" ")} printed no JSON (exit ${result.code}): ${result.stdout}${result.stderr}`); }
  };

  /**
   * SIGTERM to the app (its orderly quit, the Quit item's path) and a watch, every 25 ms, until the app has exited:
   * when the daemon and the app each went away (ms after the signal), and `observe`'s value as the daemon went.
   */
  const stop = async <T>(observe: () => T, timeoutMs = 300_000): Promise<{ daemonGoneAt: number; appGoneAt: number; atDaemonExit: T }> => {
    const app = processes().app; assert.ok(app, "no app is running");
    const started = Date.now(); process.kill(app, "SIGTERM");
    let daemonGoneAt = 0, appGoneAt = 0, atDaemonExit: T | undefined;
    for (; Date.now() - started < timeoutMs; await sleep(25)) {
      const now = processes();
      if (!daemonGoneAt && !now.daemons.length) { daemonGoneAt = Date.now() - started; atDaemonExit = observe(); }
      if (!now.app) { appGoneAt = Date.now() - started; break; }
    }
    assert.ok(appGoneAt, `the app had not exited ${timeoutMs / 1000} s after SIGTERM; ${tail("app.log")}`);
    return { daemonGoneAt, appGoneAt, atDaemonExit: atDaemonExit as T };
  };

  /** Waits until `check` holds, polling every 50 ms. */
  const until = async (check: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000) => {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(50)) if (await check()) return;
    throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}; ${tail("app.log")}`);
  };

  let calls = 0;
  /** One catalog request straight to the daemon, as the connector forwards one; its whole answer. */
  const request = async (operation: string, sandboxId: string | null, input: Json = {}): Promise<ResponseEnvelope> => {
    const requestId = `p${options.probe}-${Date.now()}-${calls++}`;
    const transport = new LocalIPCTransport({ socketPath: paths.socket, tokenFile: paths.ipcToken, timeoutMs: 300_000 });
    return await transport.dispatch({ protocol_version: PROTOCOL_VERSION, request_id: requestId, operation, sandbox_id: sandboxId, deadline_ms: 120_000, mutation_id: requestId, input } as any);
  };
  /** `request`, which must succeed; its result. */
  const ok = async (operation: string, sandboxId: string | null, input: Json = {}): Promise<any> => {
    const response = await request(operation, sandboxId, input);
    assert.equal(response.ok, true, `${operation}: ${JSON.stringify(response).slice(0, 1500)}`);
    return (response as any).result;
  };
  const record = (sandboxId: string) => JSON.parse(readFileSync(join(paths.sandboxes, sandboxId, "sandbox.json"), "utf8"));
  /** One of the run's logs (`hostd.log`, `connector.log`, `app.log`), or "" before it exists. */
  const log = (name: string) => { try { return readFileSync(join(paths.logs, name), "utf8"); } catch { return ""; } };
  const tail = (name: string) => `${name}: ${log(name).slice(-1500)}`;

  /** SIGKILLs whatever this run's bundle still runs (app, daemons, connectors, the fixture's guests, its VMs) and removes the scratch directory. */
  const cleanup = async () => {
    if (bundle) {
      const running = processes();
      const guests = running.daemons.flatMap(({ pid }) => { try { return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split(/\s+/).map(Number).filter(Boolean); } catch { return []; } });
      for (const pid of [running.app, ...running.daemons.map((row) => row.pid), ...running.connectors.map((row) => row.pid), ...running.imageEnsures.map((row) => row.pid), ...guests]) if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      // A real VM's service process belongs to launchd, not the daemon; it is this run's when it holds a file under this root.
      for (const pid of virtualizationServices()) if (holds(pid, root)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
    if (!ctx.keep) rmSync(scratch, { recursive: true, force: true });
  };

  return { scratch, home, root, paths, env, get bundle() { return bundle; }, build, start, stop, cli, waitForSocket, processes, until, request, ok, record, log, cleanup };
}

function virtualizationServices(): number[] {
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((line) => line.includes("Virtualization.VirtualMachine")).map((line) => Number(line.trim().split(/\s+/)[0]));
}
function holds(pid: number, path: string): boolean {
  try { return execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8" }).includes(path); } catch { return false; }
}
