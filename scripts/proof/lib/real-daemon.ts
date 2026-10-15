import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { checkHost } from "../../../apps/cli/src/host-check.js";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProofContext } from "../run.js";
import { LocalIPCTransport } from "../../../packages/client/src/index.js";
import { PROTOCOL_VERSION, type Json, type ResponseEnvelope } from "../../../packages/contract/src/index.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Apple's VM service creates the saved-state key in the keychain, which refuses while the console is locked (slice 02). */
/** Hibernate is unavailable only when the lock needs a password and the screen is locked (see apps/cli/src/host-check.ts). */
export const screenLocked = () => checkHost().hibernate !== "available" && checkHost().screen_locked_now;

/** Builds what a real-VM tier needs: the JS build, the minimal image, the host daemon and its signature. Returns the bin path. */
export async function buildRealVMs(ctx: ProofContext): Promise<string> {
  assert.equal((await ctx.exec("npm", ["run", "-s", "build"])).code, 0, "npm run build");
  const image = await ctx.exec("npm", ["run", "-s", "image:boot", "--", "--profile", "minimal"]);
  if (image.code !== 0) throw new Error(`blocked: could not build the minimal image (Docker running?): ${(image.stderr || image.stdout).slice(-600)}`);
  const build = await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon"]); assert.equal(build.code, 0, build.stderr.slice(-1500));
  assert.equal((await ctx.exec("sh", ["scripts/proof/lib/sign-dev.sh"])).code, 0);
  return (await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim();
}

/**
 * One real host daemon on this Mac (Apple backend, minimal image) in a temporary machine root, driven over its
 * socket. `env` adds daemon environment (e.g. a dev admission cap). `cleanup` kills it and removes the root.
 */
export function realDaemon(ctx: ProofContext, options: { probe: string; env?: NodeJS.ProcessEnv }) {
  const artifacts = join(ctx.root, "dist/vm-image/minimal");
  const machine = realpathSync(mkdtempSync(join(tmpdir(), `localbox-proof-${options.probe}-`)));
  const sandboxes = join(machine, "sandboxes"); const socket = join(machine, "agent.sock"); const tokenFile = join(machine, "ipc-token");
  const token = randomBytes(32).toString("hex"); writeFileSync(tokenFile, token, { mode: 0o600 });
  const log = join(ctx.evidence, `${options.probe}-hostd.log`);
  const transport = new LocalIPCTransport({ socketPath: socket, token, timeoutMs: 300_000 });
  let daemon: ChildProcess | undefined; let calls = 0;
  /** A VM service is this daemon's when it holds a file under this machine root (its disk clone); others (Colima) are left alone. */
  const ours = (pid: number): boolean => { try { return execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8" }).includes(machine); } catch { return false; } };

  const start = async (bin: string) => {
    const fd = openSync(log, "a");
    daemon = spawn(join(bin, "localbox-hostd"), [], { cwd: ctx.root, stdio: ["ignore", fd, fd], env: { ...process.env, LOCALBOX_VM_BACKEND: "apple", LOCALBOX_KERNEL: join(artifacts, "kernel"), LOCALBOX_INITRD: join(artifacts, "initrd"), LOCALBOX_TEMPLATE_DISK: join(artifacts, "template.img"), LOCALBOX_SANDBOXES: sandboxes, LOCALBOX_SOCKET: socket, LOCALBOX_IPC_TOKEN_PATH: tokenFile, ...options.env } });
    closeSync(fd);
    for (let attempt = 0; attempt < 120 && !existsSync(socket); attempt++) { if (daemon.exitCode !== null) break; await sleep(250); }
    assert.ok(existsSync(socket), `the daemon did not open its socket: ${readFileSync(log, "utf8").slice(-1500)}`);
  };
  const stop = async (signal: NodeJS.Signals, timeoutMs = 120_000) => {
    const child = daemon; if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill(signal);
    await Promise.race([exited, sleep(timeoutMs).then(() => { child.kill("SIGKILL"); })]);
    await exited;
  };
  const call = async (operation: string, sandboxId: string | null, input: Json = {}, mutation = true): Promise<ResponseEnvelope> => {
    const requestId = `p${options.probe}-${Date.now()}-${calls++}`;
    return transport.dispatch({ protocol_version: PROTOCOL_VERSION, request_id: requestId, operation, sandbox_id: sandboxId, deadline_ms: 120_000, mutation_id: mutation ? requestId : null, input } as any);
  };
  const ok = async (operation: string, sandboxId: string | null, input: Json = {}): Promise<any> => {
    const response = await call(operation, sandboxId, input);
    assert.equal(response.ok, true, `${operation}: ${JSON.stringify(response).slice(0, 1500)}`);
    return (response as any).result;
  };
  const sh = async (sandboxId: string, command: string): Promise<string> => (await ok("shell.exec", sandboxId, { command, cwd: "/" })).stdout.trim();
  const record = (sandboxId: string) => JSON.parse(readFileSync(join(sandboxes, sandboxId, "sandbox.json"), "utf8"));
  /** Stops every sandbox, kills the daemon and any VM service it left behind, and removes the machine root. */
  const cleanup = async () => {
    if (daemon?.exitCode === null) {
      const listed = await call("sandbox.list", null, {}, false).catch(() => undefined);
      for (const row of (listed as any)?.result?.sandboxes ?? []) await Promise.race([call("sandbox.stop", row.sandbox_id).catch(() => undefined), sleep(30_000)]);
    }
    await stop("SIGKILL", 10_000);
    for (let waited = 0; waited < 10_000 && [...virtualizationRSS().keys()].some(ours); waited += 250) await sleep(250);
    for (const pid of virtualizationRSS().keys()) if (ours(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    rmSync(machine, { recursive: true, force: true });
  };
  /** Resident memory of this daemon's VM services, by pid, in KiB. */
  const vmRSS = () => new Map([...virtualizationRSS()].filter(([pid]) => ours(pid)));
  return { machine, sandboxes, start, stop, call, ok, sh, record, vmRSS, cleanup };
}

/**
 * Memory of every Virtualization VM service process on this Mac (one per running VM), by pid, in KiB: the
 * `phys_footprint` from `footprint`, which also counts pages macOS compressed or swapped out (resident size does
 * not, so under memory pressure it undercounts what a VM holds). Colima's VM is one of these processes too; callers
 * compare before and after, so a VM that stays running cancels out.
 */
function virtualizationRSS(): Map<number, number> {
  const pids = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((line) => line.includes("Virtualization.VirtualMachine")).map((line) => Number(line.trim().split(/\s+/)[0]));
  const unit: Record<string, number> = { KB: 1, MB: 1024, GB: 1024 * 1024 };
  return new Map(pids.map((pid) => {
    let text = ""; try { text = execFileSync("footprint", ["-p", String(pid)], { encoding: "utf8" }); } catch { /* exited meanwhile */ }
    const match = text.match(/phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)/);
    return [pid, match ? Math.round(Number(match[1]) * unit[match[2]]) : 0] as [number, number];
  }));
}
