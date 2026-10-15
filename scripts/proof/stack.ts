import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
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
async function up(machines: string[]): Promise<void> {
  mkdirSync(pidDir, { recursive: true }); mkdirSync(state, { recursive: true });
  for (const machine of machines) mkdirSync(join(state, "machines", machine), { recursive: true });
  for (const port of [3000, 3210]) { const owner = portOwner(port); if (owner) throw new Error(`port ${port} is held by pid ${owner}`); }
  const existingConvex = pid(convexPid); const existingLocal = pid(localPid);
  if (!alive(existingConvex)) {
    writeFileSync(convexLog, "");
    // Anonymous agent mode runs a local backend without a Convex login (the `--local` flag is gone).
    const child = spawnLogged("npx", ["convex", "dev", "--typecheck", "disable", "--codegen", "disable"], convexLog, { ...process.env, CI: "1", CONVEX_AGENT_MODE: "anonymous" }); writeFileSync(convexPid, String(child.pid)); }
  let convexUrl: string | undefined;
  for (let attempt = 0; attempt < 240; attempt++) { if (readFileSafe(convexLog).includes("Convex functions ready")) { convexUrl = readConvexUrl(); break; } if (!alive(pid(convexPid)) && readFileSafe(convexLog).trim()) break; await sleep(250); }
  if (!convexUrl) { killPid(convexPid); throw new Error(`local Convex did not start; ${readFileSafe(convexLog).trim() || "no diagnostic output"}`); }
  if (!alive(existingLocal) && !alive(pid(localPid))) { writeFileSync(localLog, ""); const child = spawnLogged("npm", ["run", "dev:local"], localLog, { ...process.env, CONVEX_URL: convexUrl, LOCALBOX_DEV_PRINT_CODES: "1" }); writeFileSync(localPid, String(child.pid)); }
  for (let attempt = 0; attempt < 120 && !readFileSafe(localLog).includes("listening on"); attempt++) { if (!alive(pid(localPid))) throw new Error(`dev:local exited; ${readFileSafe(localLog).trim()}`); await sleep(250); }
  if (!readFileSafe(localLog).includes("listening on")) throw new Error("dev:local did not start listening within 30 s");
}
function killPid(path: string): void { const value = pid(path); if (alive(value)) { try { process.kill(-value!, "SIGTERM"); } catch { try { process.kill(value!, "SIGTERM"); } catch {} } } rmSync(path, { force: true }); }
async function down(): Promise<void> { killPid(localPid); killPid(convexPid); await sleep(250); killPid(localPid); killPid(convexPid); }
function status(): void { mkdirSync(pidDir, { recursive: true }); process.stdout.write(`${JSON.stringify({ convex: alive(pid(convexPid)), devLocal: alive(pid(localPid))})}\n`); }
function logs(): void { process.stdout.write(`== convex ==\n${readFileSafe(convexLog)}== dev-local ==\n${readFileSafe(localLog)}`); }
const [command, ...args] = process.argv.slice(2); const machinesIndex = args.indexOf("--machines"); const machines = machinesIndex >= 0 ? (args[machinesIndex + 1] ?? "").split(",").filter(Boolean) : [];
try { if (command === "up") await up(machines); else if (command === "down") await down(); else if (command === "status") status(); else if (command === "logs") logs(); else { process.stderr.write("usage: stack.ts up|down|status|logs [--machines a,b]\n"); process.exitCode = 2; } } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
