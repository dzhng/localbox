import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { buildRealVMs, realDaemon, screenLocked } from "../lib/real-daemon.js";

export const id = "10";
export const tiers = ["u", "s", "v"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const GIB = 1024 ** 3;

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("a cloned disk takes its own machine-id and SSH host keys once per sandbox id; the hostname follows the name", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/guest-identity.test.ts", "tests/guest-service.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2000));
    })];
  }
  if (ctx.tier === "s") {
    return [await ctx.check("defaultSize table and the SandboxHost state machine on a fake backend (Swift)", async () => {
      const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "testDefaultSize|testSandboxHostLifecycle|testResizeReportsRestart|testSigterm|testTheMirrorFollowsNamesAndNeverDeletesADisk"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2000));
      assert.match(result.stdout + result.stderr, /Executed 6 tests, with 0 failures/);
    })];
  }
  return realVMs(ctx);
}

/** One real host daemon on this Mac (Apple backend, minimal image) in a temporary machine root, driven over its socket. */
async function realVMs(ctx: ProofContext): Promise<Check[]> {
  const artifacts = join(ctx.root, "dist/vm-image/minimal");
  const { machine, sandboxes, start, stop, ok, sh, record, cleanup } = realDaemon(ctx, { probe: "10" });
  const evidence: Record<string, unknown> = { machine_root: machine, screen_locked: screenLocked() };
  let bin = "";
  const startDaemon = () => start(bin);
  const stopDaemon = stop;
  const ids = { alpha: "sandbox_p10_alpha", beta: "sandbox_p10_beta" };
  const names: Record<string, string> = { [ids.alpha]: "alpha-otter", [ids.beta]: "beta-heron" };

  const checks: Check[] = [];
  try {
    checks.push(await ctx.check("the minimal image (with this guest agent), the host daemon and its signature are built", async () => {
      bin = await buildRealVMs(ctx);
      evidence.template_du_kb = Number(execFileSync("du", ["-k", join(artifacts, "template.img")], { encoding: "utf8" }).split("\t")[0]);
      await startDaemon();
    }));
    checks.push(await ctx.check("two sandboxes boot from APFS clones that allocate under 50 MB at creation", async () => {
      for (const sandboxId of [ids.alpha, ids.beta]) {
        const started = Date.now();
        const created = await ok("sandbox.create", sandboxId, { name: names[sandboxId], cpus: 2, memory_bytes: 2 * GIB });
        evidence[`${sandboxId}_create_ms`] = Date.now() - started; evidence[`${sandboxId}_create`] = created;
        assert.equal(created.produced.disk, "cloned");
        assert.ok(created.produced.disk_allocated_bytes >= 0 && created.produced.disk_allocated_bytes < 50 * 1024 * 1024, `clone allocated ${created.produced.disk_allocated_bytes} bytes`);
        assert.deepEqual(created.actions.map((action: any) => action.kind), ["created", "cold_booted"]);
        // `du` counts blocks a clone shares with the template, so it reports the template's size; kept as evidence only.
        evidence[`${sandboxId}_disk_du_kb`] = Number(execFileSync("du", ["-k", join(sandboxes, sandboxId, "disk.img")], { encoding: "utf8" }).split("\t")[0]);
      }
    }));
    checks.push(await ctx.check("each has its own /etc/machine-id and MAC, and its hostname is its name", async () => {
      const seen = { machineId: new Set<string>(), mac: new Set<string>() };
      for (const sandboxId of [ids.alpha, ids.beta]) {
        const [machineId, mac, hostname] = (await sh(sandboxId, "cat /etc/machine-id; cat /sys/class/net/e*/address | head -1; hostname")).split("\n");
        evidence[`${sandboxId}_identity`] = { machineId, mac, hostname, ssh: await sh(sandboxId, "command -v ssh-keygen || echo none") };
        assert.match(machineId, /^[0-9a-f]{32}$/); assert.equal(mac, record(sandboxId).mac, "the guest's NIC has the persisted MAC"); assert.equal(hostname, names[sandboxId]);
        seen.machineId.add(machineId); seen.mac.add(mac);
      }
      assert.equal(seen.machineId.size, 2, "distinct machine-ids"); assert.equal(seen.mac.size, 2, "distinct MACs");
    }));
    checks.push(await ctx.check("both reach the internet", async () => {
      // The guest agent answers before DHCP finishes, so give NAT up to 30 s to come up.
      const curl = "for i in $(seq 30); do c=$(curl -sI -o /dev/null -w '%{http_code}' --max-time 10 https://deb.debian.org/); [ \"$c\" = 200 ] && break; sleep 1; done; echo $c";
      for (const sandboxId of [ids.alpha, ids.beta]) assert.equal(await sh(sandboxId, curl), "200", sandboxId);
    }));
    checks.push(await ctx.check("a file written in one is absent in the other", async () => {
      const marker = `/root/only-alpha-${Date.now()}`;
      await sh(ids.alpha, `echo alpha > ${marker} && sync`);
      assert.equal(await sh(ids.alpha, `cat ${marker}`), "alpha");
      assert.equal(await sh(ids.beta, `test -e ${marker} && echo present || echo absent`), "absent");
    }));
    checks.push(await ctx.check("resize to 3 CPUs restarts the sandbox, reports what ended, and nproc says 3", async () => {
      await sh(ids.alpha, "nohup sleep 100000 >/dev/null 2>&1 &");
      const started = Date.now();
      const resized = await ok("sandbox.resize", ids.alpha, { cpus: 3 });
      evidence.resize_ms = Date.now() - started; evidence.resize = resized;
      assert.equal(resized.actions[0]?.kind, "restarted"); assert.match(resized.actions[0].detail, /\d+ process(es)? ended: .*sleep/);
      assert.equal(await sh(ids.alpha, "nproc"), "3");
    }));
    checks.push(await ctx.check("rename gives the running guest its new hostname at once", async () => {
      names[ids.beta] = "beta-kestrel";
      await ok("sandbox.rename", ids.beta, { name: names[ids.beta] });
      assert.equal(await sh(ids.beta, "hostname"), names[ids.beta]);
    }));
    const locked = screenLocked();
    checks.push(await ctx.check(locked ? "SIGTERM with the screen locked: save fails, both stop owing a cold boot, the restart cold-boots them and says why" : "SIGTERM hibernates both; the restart wakes them with the same background PID", async () => {
      const pids: Record<string, string> = {};
      for (const sandboxId of [ids.alpha, ids.beta]) pids[sandboxId] = await sh(sandboxId, "nohup sleep 100000 >/dev/null 2>&1 & echo $!");
      const termAt = Date.now(); await stopDaemon("SIGTERM"); evidence.sigterm_ms = Date.now() - termAt;
      for (const sandboxId of [ids.alpha, ids.beta]) {
        const saved = record(sandboxId); evidence[`${sandboxId}_after_sigterm`] = saved;
        if (locked) { assert.equal(saved.lifecycle, "stopped"); assert.match(saved.cold_boot_pending ?? "", /^could not save its state/); }
        else { assert.equal(saved.lifecycle, "hibernated"); assert.ok(existsSync(join(sandboxes, sandboxId, "state.vzsave"))); }
      }
      const restartAt = Date.now(); await startDaemon();
      for (const sandboxId of [ids.alpha, ids.beta]) {
        let status: any;
        for (let attempt = 0; attempt < 240; attempt++) { status = await ok("sandbox.status", sandboxId); if (status.state === "running" || status.lifecycle === "error") break; await sleep(500); }
        evidence[`${sandboxId}_after_restart`] = status; evidence[`${sandboxId}_restart_ms`] = Date.now() - restartAt;
        assert.equal(status.state, "running", JSON.stringify(status));
        if (locked) { assert.equal(status.last_boot?.kind, "cold_booted"); assert.match(status.last_boot.detail, /could not save its state/); }
        else { assert.equal(status.last_boot?.kind, "woke"); assert.equal(await sh(sandboxId, `kill -0 ${pids[sandboxId]} && echo alive || echo gone`), "alive"); }
        assert.equal(await sh(sandboxId, "hostname"), names[sandboxId], "the identity survives the restart");
      }
    }));
    checks.push(await ctx.check("delete stops each sandbox and removes its directory", async () => {
      for (const sandboxId of [ids.alpha, ids.beta]) {
        const deleted = await ok("sandbox.delete", sandboxId);
        assert.ok(deleted.produced.removed.includes("disk"), JSON.stringify(deleted));
        assert.ok(!existsSync(join(sandboxes, sandboxId)), `${sandboxId}'s directory is gone`);
      }
      assert.deepEqual((await ok("sandbox.list", null)).sandboxes, []);
    }));
  } finally {
    await cleanup();
    writeFileSync(join(ctx.evidence, "10-multi-sandbox.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  return checks;
}
