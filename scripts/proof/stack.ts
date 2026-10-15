import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { publicJwks } from "../../packages/tokens/src/index.js";
import { machinePaths } from "../../packages/config/src/machine-paths.js";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const state = join(root, ".localbox", "proof");
const pidDir = join(state, "pids");
const convexPid = join(pidDir, "convex.pid");
const localPid = join(pidDir, "dev-local.pid");
const convexLog = join(state, "convex.log");
const localLog = join(state, "dev-local.log");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function pid(path: string): number | undefined { try { const value = Number(readFileSync(path, "utf8")); return Number.isInteger(value) && value > 0 ? value : undefined; } catch { return undefined; } }
function alive(value: number | undefined): boolean { if (!value) return false; try { process.kill(value, 0); return true; } catch { return false; } }
function portOwner(port: number): string | undefined { try { return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split(/\s+/)[0] || undefined; } catch { return undefined; } }
/** Children write straight to their log file so the detached stack outlives `stack up` (pipes would keep it attached). */
function spawnLogged(command: string, args: string[], log: string, env: NodeJS.ProcessEnv): ChildProcess { const fd = openSync(log, "a"); const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ["ignore", fd, fd] }); closeSync(fd); child.unref(); return child; }
function readFileSafe(path: string): string { try { return readFileSync(path, "utf8"); } catch { return ""; } }
function readConvexUrl(): string | undefined { const line = readFileSafe(join(root, ".env.local")).split(/\r?\n/).find((item) => item.startsWith("CONVEX_URL=")); return line?.slice("CONVEX_URL=".length).trim(); }
/** Dev ES256 signing key: dev:local signs with it, Convex verifies with the JWKS derived from it (slice 05). */
function devKeys(): { privatePem: string; jwks: string } {
  const privatePath = join(state, "keys", "jwt-private.pem");
  if (!readFileSafe(privatePath)) {
    mkdirSync(join(state, "keys"), { recursive: true });
    writeFileSync(privatePath, generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const privatePem = readFileSafe(privatePath);
  return { privatePem, jwks: publicJwks(privatePem) };
}
/**
 * The auth config reads LOCALBOX_JWKS and LOCALBOX_API_ORIGIN, and Convex refuses to push it until both are set,
 * but `convex env set` needs the backend running. `convex dev` keeps the backend up after a failed push and
 * re-pushes once the env changes, so: wait for the backend, set the env, wait for "functions ready".
 */
async function startConvex(keys: { jwks: string }, convexEnv: NodeJS.ProcessEnv): Promise<string | undefined> {
  const ready = () => readFileSafe(convexLog).includes("Convex functions ready");
  for (let attempt = 0; attempt < 240 && !ready() && !readFileSafe(convexLog).includes("is used in auth config"); attempt++) { if (!alive(pid(convexPid))) return undefined; await sleep(250); }
  if (!ready()) {
    execFileSync("npx", ["convex", "env", "set", "LOCALBOX_JWKS", keys.jwks], { cwd: root, env: convexEnv, stdio: "ignore" });
    execFileSync("npx", ["convex", "env", "set", "LOCALBOX_API_ORIGIN", "http://127.0.0.1:3000"], { cwd: root, env: convexEnv, stdio: "ignore" });
  }
  for (let attempt = 0; attempt < 240; attempt++) { if (ready()) return readConvexUrl(); if (!alive(pid(convexPid))) return undefined; await sleep(250); }
  return undefined;
}
async function up(machines: string[]): Promise<void> {
  mkdirSync(pidDir, { recursive: true }); mkdirSync(state, { recursive: true });
  for (const machine of machines) mkdirSync(join(state, "machines", machine), { recursive: true });
  for (const port of [3000, 3210]) { const owner = portOwner(port); if (owner) throw new Error(`port ${port} is held by pid ${owner}`); }
  const existingLocal = pid(localPid);
  // The Convex CLI checks version.convex.dev on every start; a failed check kills the start, so retry it.
  let convexUrl: string | undefined; const keys = devKeys(); const convexEnv = { ...process.env, CI: "1", CONVEX_AGENT_MODE: "anonymous" };
  for (let start = 0; start < 3 && !convexUrl; start++) {
    if (!alive(pid(convexPid))) {
      writeFileSync(convexLog, "");
      const child = spawnLogged("npx", ["convex", "dev", "--typecheck", "disable", "--codegen", "disable"], convexLog, convexEnv); writeFileSync(convexPid, String(child.pid));
    }
    convexUrl = await startConvex(keys, convexEnv);
    if (!convexUrl && readFileSafe(convexLog).includes("Failed to fetch latest backend version")) { killPid(convexPid); await sleep(2000); continue; }
    break;
  }
  if (!convexUrl) { killPid(convexPid); throw new Error(`local Convex did not start; ${readFileSafe(convexLog).trim() || "no diagnostic output"}`); }
  // The anonymous local backend keeps data between runs; start every stack empty so limits and rows never leak across proofs.
  execFileSync("npx", ["convex", "run", "admin:wipe"], { cwd: root, env: convexEnv, stdio: "ignore" });
  if (!alive(existingLocal) && !alive(pid(localPid))) { writeFileSync(localLog, ""); const child = spawnLogged("npm", ["run", "dev:local"], localLog, { ...process.env, CONVEX_URL: convexUrl, LOCALBOX_DEV_PRINT_CODES: "1", LOCALBOX_API_ORIGIN: "http://127.0.0.1:3000", LOCALBOX_JWT_PRIVATE_KEY: keys.privatePem }); writeFileSync(localPid, String(child.pid)); }
  for (let attempt = 0; attempt < 120 && !readFileSafe(localLog).includes("listening on"); attempt++) { if (!alive(pid(localPid))) throw new Error(`dev:local exited; ${readFileSafe(localLog).trim()}`); await sleep(250); }
  if (!readFileSafe(localLog).includes("listening on")) throw new Error("dev:local did not start listening within 30 s");
  await startDaemons(machines);
}
const hostdPid = (machine: string) => join(pidDir, `hostd-${machine}.pid`);
/** One fixture HostDaemon per machine root (slice 03): its own socket, IPC token and guest root. */
async function startDaemons(machines: string[]): Promise<void> {
  if (!machines.length) return;
  execFileSync("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--product", "localbox-hostd"], { cwd: root, stdio: "ignore" });
  const bin = execFileSync("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"], { cwd: root, encoding: "utf8" }).trim();
  for (const machine of machines) {
    if (alive(pid(hostdPid(machine)))) continue;
    const paths = machinePaths({ LOCALBOX_MACHINE_ROOT: join(state, "machines", machine) });
    mkdirSync(paths.logs, { recursive: true }); mkdirSync(paths.sandboxes, { recursive: true });
    if (!readFileSafe(paths.ipcToken).trim()) writeFileSync(paths.ipcToken, randomBytes(32).toString("hex"), { mode: 0o600 });
    // `up` wipes local Convex, so a machine's old credential and sandbox mirror would point at an account that no longer exists.
    rmSync(paths.socket, { force: true }); rmSync(paths.credentials, { force: true }); rmSync(paths.sandboxMirror, { force: true });
    const log = join(paths.logs, "hostd.log"); writeFileSync(log, "");
    const child = spawnLogged(join(bin, "localbox-hostd"), [], log, { ...process.env, LOCALBOX_VM_BACKEND: "process-fixture", LOCALBOX_REPO_ROOT: root, LOCALBOX_SANDBOX_DIR: join(paths.sandboxes, "shared"), LOCALBOX_SANDBOX_MIRROR: paths.sandboxMirror, LOCALBOX_SOCKET: paths.socket, LOCALBOX_IPC_TOKEN_PATH: paths.ipcToken });
    writeFileSync(hostdPid(machine), String(child.pid));
    for (let attempt = 0; attempt < 120 && !existsSync(paths.socket); attempt++) { if (!alive(child.pid)) break; await sleep(250); }
    if (!existsSync(paths.socket)) throw new Error(`machine ${machine}'s HostDaemon did not open ${paths.socket}; ${readFileSafe(log).trim() || "no diagnostic output"}`);
  }
}
function daemonPidFiles(): string[] { try { return readdirSync(pidDir).filter((name) => name.startsWith("hostd-")).map((name) => join(pidDir, name)); } catch { return []; } }
function killPid(path: string): void { const value = pid(path); if (alive(value)) { try { process.kill(-value!, "SIGTERM"); } catch { try { process.kill(value!, "SIGTERM"); } catch {} } } rmSync(path, { force: true }); }
async function down(): Promise<void> { const daemons = daemonPidFiles(); for (const path of [localPid, convexPid, ...daemons]) killPid(path); await sleep(250); for (const path of [localPid, convexPid, ...daemons]) killPid(path); }
function status(): void { mkdirSync(pidDir, { recursive: true }); process.stdout.write(`${JSON.stringify({ convex: alive(pid(convexPid)), devLocal: alive(pid(localPid)), daemons: Object.fromEntries(daemonPidFiles().map((path) => [path.slice(path.lastIndexOf("hostd-") + 6, -4), alive(pid(path))])) })}\n`); }
function logs(): void { process.stdout.write(`== convex ==\n${readFileSafe(convexLog)}== dev-local ==\n${readFileSafe(localLog)}`); }
const [command, ...args] = process.argv.slice(2); const machinesIndex = args.indexOf("--machines"); const machines = machinesIndex >= 0 ? (args[machinesIndex + 1] ?? "").split(",").filter(Boolean) : [];
try { if (command === "up") await up(machines); else if (command === "down") await down(); else if (command === "status") status(); else if (command === "logs") logs(); else { process.stderr.write("usage: stack.ts up|down|status|logs [--machines a,b]\n"); process.exitCode = 2; } } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
