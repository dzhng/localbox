import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { machinePaths, type MachinePaths } from "../../../packages/config/src/index.js";
import type { Json } from "../../../packages/contract/src/index.js";
import { commandDirectory } from "./agent-setup.js";
import type { AppLaunchOptions } from "./app-launch.js";
import { askApp } from "./app-socket.js";
import { layout, type Layout } from "./layout.js";

/** What `localbox app paths --json` prints: every path Localbox.app hands its children. */
export interface AppPaths {
  root: string; credentials: string; ipc_token: string; socket: string; hostd_lock: string; app_socket: string;
  sandboxes: string; operations: string; images: string; logs: string;
  /** The built-in image's progress file; the daemon reads it to say how far the download is when a create must wait. */
  builtin_image: string;
  /** Where agent setup installs the `localbox` command; the daemon's agent reconcile writes it there. */
  bin_dir: string;
}

/**
 * `localbox app paths`: this Mac's machine paths, as `machinePaths()` defines them, for Localbox.app, which never
 * derives a path itself. It is the one creator of the machine directories and the IPC token: the directories are
 * made private if missing, and the token (32 random bytes, hex, mode 0600) is written once and then kept, since the
 * daemon and every client read the same file.
 */
export async function appPaths(env: NodeJS.ProcessEnv = process.env): Promise<AppPaths> {
  const paths = machinePaths(env);
  for (const directory of [paths.root, paths.sandboxes, paths.operations, paths.images, paths.logs]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await ensureToken(paths.ipcToken);
  return {
    root: paths.root, credentials: paths.credentials, ipc_token: paths.ipcToken, socket: paths.socket, hostd_lock: paths.hostdLock, app_socket: paths.appSocket,
    sandboxes: paths.sandboxes, operations: paths.operations, images: paths.images, logs: paths.logs, builtin_image: paths.builtinImage, bin_dir: commandDirectory(env),
  };
}

/** A token already there is kept; a missing or empty one (a crash mid-write) is written whole, then renamed into place. */
async function ensureToken(path: string): Promise<void> {
  if ((await readFile(path, "utf8").catch(() => "")).trim()) { await chmod(path, 0o600); return; }
  const staging = `${path}.writing-${process.pid}`;
  await writeFile(staging, randomBytes(32).toString("hex"), { mode: 0o600 });
  await rename(staging, path);
}

/** Where `localbox app status` (`app-facts.ts`) and `login-item` find the app; the defaults are this CLI's own. */
export interface AppDeps { layout?: Pick<Layout, "app">; paths?: Pick<MachinePaths, "appSocket">; launch?: AppLaunchOptions }

/** `localbox app login-item [on|off]`: the login item's state, after turning it on or off when asked. */
export async function appLoginItem(enabled: boolean | undefined, deps: AppDeps = {}): Promise<Json> {
  return enabled === undefined ? ask(deps, "login_item.get") : ask(deps, "login_item.set", { enabled });
}

const ask = (deps: AppDeps, operation: Parameters<typeof askApp>[2], params: Record<string, Json> = {}) =>
  askApp(deps.layout ?? layout(), deps.paths ?? machinePaths(), operation, params, deps.launch);
