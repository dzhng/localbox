import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { machinePaths } from "../../../packages/config/src/index.js";
import { commandDirectory } from "./agent-setup.js";

/** What `localbox app paths --json` prints: every path Localbox.app hands its children. */
export interface AppPaths {
  root: string; credentials: string; ipc_token: string; socket: string; hostd_lock: string;
  sandboxes: string; operations: string; images: string; logs: string;
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
    root: paths.root, credentials: paths.credentials, ipc_token: paths.ipcToken, socket: paths.socket, hostd_lock: paths.hostdLock,
    sandboxes: paths.sandboxes, operations: paths.operations, images: paths.images, logs: paths.logs, bin_dir: commandDirectory(env),
  };
}

/** A token already there is kept; a missing or empty one (a crash mid-write) is written whole, then renamed into place. */
async function ensureToken(path: string): Promise<void> {
  if ((await readFile(path, "utf8").catch(() => "")).trim()) { await chmod(path, 0o600); return; }
  const staging = `${path}.writing-${process.pid}`;
  await writeFile(staging, randomBytes(32).toString("hex"), { mode: 0o600 });
  await rename(staging, path);
}
