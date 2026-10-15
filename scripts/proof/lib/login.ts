import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { asMachine } from "./as-machine.js";
import { waitForCode } from "./codes.js";

export const API_ORIGIN = "http://127.0.0.1:3000";
export const machineRoot = (root: string, machine: string) => join(root, ".localbox/proof/machines", machine);
/** A fixture machine's own HOME, where its daemon's agent setup puts the skill and the localbox link (never the real HOME). */
export const fixtureHome = (machineRootPath: string) => join(machineRootPath, "home");

/** Signs a proof machine in with an email, reading the code from dev:local's log. */
export async function login(root: string, machine: string, email: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const devLog = join(root, ".localbox/proof/dev-local.log");
  const options = { cwd: root, env: { LOCALBOX_API_ORIGIN: API_ORIGIN, LOCALBOX_TRANSPORT: "remote", ...env } };
  const since = statSync(devLog).size;
  const start = await asMachine(machine, ["login", "--email", email], options);
  if (start.code !== 0) return start;
  const code = await waitForCode(email, { sinceByte: since, logPath: devLog });
  return await asMachine(machine, ["login", "--email", email, "--code", code], options);
}

/** Starts `localbox connector run` for a proof machine, detached, logging next to its daemon. */
export function startConnector(root: string, machine: string): ChildProcess {
  const logs = join(machineRoot(root, machine), "logs"); mkdirSync(logs, { recursive: true });
  const fd = openSync(join(logs, "connector.log"), "a");
  const child = spawn(process.execPath, ["bin/localbox.js", "connector", "run"], { cwd: root, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, LOCALBOX_API_ORIGIN: API_ORIGIN, LOCALBOX_MACHINE_ROOT: machineRoot(root, machine), LOCALBOX_MACHINE: machine } });
  closeSync(fd); child.unref(); return child;
}

export function stopConnector(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch { try { process.kill(child.pid, signal); } catch { /* already gone */ } }
}
