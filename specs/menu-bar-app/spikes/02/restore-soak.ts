// TEMPORARY (spike 02 control, not kept): N cycles of SIGTERM + restart with 4 x 2 GiB VMs, daemon spawned directly
// (SOAK_MODE=direct) or as the child of the spike app (SOAK_MODE=app). Counts restores that fell back to a cold boot.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installLinuxImage } from "../../release.js";
import type { Check, ProofContext } from "../run.js";
import { linuxImage } from "../lib/linux-image.js";
import { realDaemon } from "../lib/real-daemon.js";

export const id = "98";
export const tiers = ["v"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const mode = process.env.SOAK_MODE ?? "direct", cycles = Number(process.env.SOAK_CYCLES ?? 10);

export async function run(ctx: ProofContext): Promise<Check[]> {
  const daemon = realDaemon(ctx, { probe: "98" }); const { machine, sandboxes, ok, sh, record, cleanup } = daemon;
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "localbox-proof-98-app-")));
  const socket = join(machine, "agent.sock"), images = join(machine, "images"), stateFile = join(scratch, "state.json");
  const bin = (await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim();
  const spawned = new Set<number>(); let current: { app_pid: number; child_pid: number } | undefined;
  const rows: any[] = []; const openFailures: any[] = [];
  const start = async () => {
    if (mode === "direct") return daemon.start(bin);
    rmSync(stateFile, { force: true }); rmSync(socket, { force: true });
    const env = { LOCALBOX_SANDBOX_BACKEND: "apple", LOCALBOX_SANDBOXES: sandboxes, LOCALBOX_OPERATIONS: join(machine, "operations"), LOCALBOX_IMAGES: images, LOCALBOX_SOCKET: socket, LOCALBOX_IPC_TOKEN_PATH: join(machine, "ipc-token") };
    writeFileSync(join(scratch, "config.json"), JSON.stringify({ executable: join(bin, "localbox-hostd"), env, cwd: ctx.root, log: join(ctx.evidence, "98-hostd.log"), state: stateFile, events: join(ctx.evidence, "98-app-events.jsonl") }));
    for (let attempt = 0; ; attempt++) {
      const opened = await ctx.exec("open", ["-g", join(scratch, "LocalboxSpikeChild.app"), "--env", `LOCALBOX_SPIKE_CONFIG=${join(scratch, "config.json")}`]);
      if (opened.code === 0) break;
      process.stderr.write(`${JSON.stringify({ open_failed: opened.code, attempt, stderr: opened.stderr.trim() })}\n`); openFailures.push({ attempt, code: opened.code, stderr: opened.stderr.trim() });
      assert.ok(attempt < 20, "open -g kept failing"); await sleep(500);
    }
    while (!existsSync(stateFile)) await sleep(50);
    current = JSON.parse(readFileSync(stateFile, "utf8")); spawned.add(current!.app_pid); spawned.add(current!.child_pid);
    while (!existsSync(socket)) await sleep(50);
  };
  const stop = async () => {
    if (mode === "direct") return daemon.stop("SIGTERM", 60_000);
    process.kill(current!.app_pid, "SIGTERM"); while (alive(current!.app_pid) || alive(current!.child_pid)) await sleep(25);
  };
  const ids = [0, 1, 2, 3].map((index) => `sandbox_p98_${index}`);
  const check = await ctx.check(`${cycles} cycles of SIGTERM and restart, 4 x 2 GiB, ${mode}`, async () => {
    if (mode === "app") assert.equal((await ctx.exec("sh", ["specs/menu-bar-app/spikes/02/build.sh", scratch])).code, 0);
    if (!existsSync(join(images, "linux"))) await installLinuxImage(dirname(dirname(await linuxImage(ctx))), images);
    await start();
    for (const [index, sandboxId] of ids.entries()) await ok("sandbox.create", sandboxId, { name: `soak-${index}`, image: "linux", cpus: 2, memory_bytes: 2 * 1024 ** 3, sleep_after_ms: 3_600_000 });
    await Promise.all(ids.map((sandboxId) => sh(sandboxId, "mkdir -p /mnt/p && mount -t tmpfs -o size=1300m tmpfs /mnt/p && dd if=/dev/urandom of=/mnt/p/blob bs=1M count=1280 2>/dev/null")));
    for (let cycle = 0; cycle < cycles; cycle++) {
      const stopAt = Date.now(); await stop(); const hibernateMs = Date.now() - stopAt;
      const records = ids.map((sandboxId) => record(sandboxId).lifecycle);
      const startAt = Date.now(); await start(); const boots: string[] = [];
      for (const sandboxId of ids) {
        let status: any;
        for (;;) { status = await ok("sandbox.status", sandboxId); if (status.state === "running" || status.lifecycle === "error") break; await sleep(200); }
        boots.push(`${status.last_boot?.kind}${status.last_boot?.kind === "woke" ? "" : `: ${status.last_boot?.detail ?? status.detail}`}`);
      }
      const row = { cycle, hibernate_ms: hibernateMs, records, restore_ms: Date.now() - startAt, boots }; rows.push(row);
      process.stderr.write(`${JSON.stringify(row)}\n`);
      // A cold-booted VM lost its tmpfs; dirty it again so every cycle saves the same amount.
      for (const [index, sandboxId] of ids.entries()) if (!boots[index].startsWith("woke")) await sh(sandboxId, "mkdir -p /mnt/p && mount -t tmpfs -o size=1300m tmpfs /mnt/p && dd if=/dev/urandom of=/mnt/p/blob bs=1M count=1280 2>/dev/null");
    }
    for (const sandboxId of ids) await ok("sandbox.delete", sandboxId);
  });
  for (const pid of spawned) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await cleanup(); rmSync(scratch, { recursive: true, force: true });
  writeFileSync(join(ctx.evidence, `98-restore-soak-${mode}.json`), `${JSON.stringify({ mode, cycles, open_failures: openFailures, rows }, null, 2)}\n`);
  return [check];
}
