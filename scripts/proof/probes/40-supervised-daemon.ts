import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { buildRealVMs, realDaemon, screenLocked } from "../lib/real-daemon.js";

// Menu bar app, slice 06: the host daemon as an app's child. Started `--supervised` with stdin a pipe, it treats the
// pipe closing (the app quitting or dying) exactly as SIGTERM: a real VM hibernates and the next start wakes it with
// its memory. And a second daemon on the same machine root is refused before it touches the root.
//
//   npm run proof -- 40 --tier v

export const id = "40";
export const tiers = ["v"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MARKER = "/run/p40-counter";

export async function run(ctx: ProofContext): Promise<Check[]> {
  const daemon = realDaemon(ctx, { probe: "40" });
  const { machine, sandboxes, env, log, ok, sh, record, vmRSS, cleanup } = daemon;
  const checks: Check[] = [];
  let bin = "";
  const sandboxId = "sandbox_p40_alpha", name = "alpha-otter";
  let markerPid = "", counterAtStop = 0;

  /** A loop writing a climbing counter to a tmpfs file: it survives only if the guest's memory does. */
  const counter = async () => {
    const out = await sh(sandboxId, `kill -0 ${markerPid} 2>/dev/null && cat ${MARKER} || echo gone`);
    assert.match(out, /^\d+$/, `marker process ${markerPid}: ${out}`); return Number(out);
  };
  const logSince = (offset: number) => readFileSync(log, "utf8").slice(offset);

  try {
    checks.push(await ctx.check("build: the dev image and the dev-signed daemon", async () => { bin = await buildRealVMs(ctx); }));
    if (screenLocked()) {
      checks.push({ name: "an unlocked session", ok: false, ms: 0, detail: "blocked: the screen is locked with a password, and hibernation needs an unlocked session; unlock and run again" });
      return checks;
    }

    checks.push(await ctx.check("a supervised daemon boots a Linux sandbox; a twin on the same root exits 75 naming the lock and leaves the first serving", async () => {
      await daemon.start(bin, { supervised: true });
      const created = await ok("sandbox.create", sandboxId, { name, image: "linux", cpus: 2, memory_bytes: 2 * 1024 ** 3, sleep_after_ms: 60 * 60_000 });
      assert.deepEqual(created.actions.map((action: any) => action.kind), ["created", "cold_booted"]);
      markerPid = await sh(sandboxId, `nohup sh -c 'i=0; while :; do i=$((i+1)); echo $i > ${MARKER}.tmp && mv ${MARKER}.tmp ${MARKER}; sleep 0.2; done' >/dev/null 2>&1 & echo $!`);
      assert.match(markerPid, /^\d+$/);

      const twin = spawnSync(join(bin, "localbox-hostd"), ["--supervised"], { cwd: ctx.root, env, input: "", encoding: "utf8", timeout: 30_000 });
      assert.equal(twin.status, 75, `the twin's exit status (stderr: ${twin.stderr})`);
      assert.equal(twin.stderr.trim().split("\n").length, 1, `one line on stderr: ${twin.stderr}`);
      assert.ok(twin.stderr.includes(`holds ${join(machine, "hostd.lock")}`), `the refusal names the lock: ${twin.stderr}`);
      assert.ok(existsSync(env.LOCALBOX_SOCKET!), "the twin left the socket in place");
      assert.equal(await sh(sandboxId, "echo still-here"), "still-here", "the first daemon still answers on its socket");
    }));

    checks.push(await ctx.check("closing stdin hibernates the sandbox (one stderr line for it) and the daemon exits 0", async () => {
      counterAtStop = await counter(); const offset = readFileSync(log, "utf8").length;
      const status = await daemon.closeStdin();
      assert.equal(status, 0, `exit status; log: ${logSince(offset).slice(-1500)}`);
      const lines = logSince(offset).split("\n");
      assert.ok(lines.some((line) => line.endsWith("stopping (stdin closed): hibernating running sandboxes")), lines.join("\n"));
      assert.ok(lines.some((line) => line.endsWith(`hibernated ${name}`)), lines.join("\n"));
      assert.equal(record(sandboxId).lifecycle, "hibernated");
      assert.ok(existsSync(join(sandboxes, sandboxId, "state.vzsave")), "state.vzsave was written");
      for (let waited = 0; waited < 10_000 && vmRSS().size; waited += 250) await sleep(250);
      assert.equal(vmRSS().size, 0, "no VM service of this root is left");
    }));

    checks.push(await ctx.check("a relaunch wakes it from its saved state with the marker still counting", async () => {
      await daemon.start(bin, { supervised: true });
      let status: any;
      for (const at = Date.now(); ; await sleep(200)) {
        status = await ok("sandbox.status", sandboxId);
        if (status.state === "running" || status.lifecycle === "error" || Date.now() - at > 180_000) break;
      }
      assert.equal(status.state, "running", JSON.stringify(status));
      assert.equal(status.last_boot?.kind, "woke", JSON.stringify(status.last_boot));
      const first = await counter(); await sleep(1_200); const second = await counter();
      assert.ok(first >= counterAtStop && second > first, `the counter kept its value and climbs: ${first} -> ${second}`);
      await ok("sandbox.delete", sandboxId);
      assert.equal(await daemon.closeStdin(), 0);
    }));
  } finally {
    await cleanup();
  }
  return checks;
}
