import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installLinuxImage } from "../../release.js";
import type { Check, ProofContext } from "../run.js";
import { linuxImage } from "../lib/linux-image.js";
import { buildRealVMs, realDaemon, screenLocked } from "../lib/real-daemon.js";

// Menu bar app, slice 02: the host daemon as the child of an LSUIElement app launched with `open -g` (the throwaway
// supervisor in specs/menu-bar-app/spikes/02). The daemon gets the environment `realDaemon()` builds, in its scratch
// root, and the probe talks to its socket as every real-VM probe does; only who spawns the daemon differs.
//
//   npm run proof -- 40 --tier v                 checks 1-8, the timing table at 2 GiB (1, 2 and 4 VMs)
//   npm run proof -- 40 --tier v --full-table    also the 8 GiB cells (scaled to what this Mac's admission budget fits)
//
// Check 8 signs the daemon and the app with a self-signed identity, as a release is: by default a throwaway one made
// in a scratch keychain (spikes/02/scratch-identity.sh; never in the search list, deleted afterwards), or the keychain
// identity LOCALBOX_PROOF_40_IDENTITY names. A keychain identity that cannot sign without a click on a keychain dialog
// is "blocked", not a failure.

export const id = "40";
export const tiers = ["v"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const GIB = 1024 ** 3, MIB = 1024 ** 2;
const fullTable = process.argv.includes("--full-table");
const keychainIdentity = process.env.LOCALBOX_PROOF_40_IDENTITY;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const text = (command: string, args: string[]) => { try { return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (error) { return `(${command} failed: ${String((error as { stderr?: string }).stderr ?? error).trim()})`; } };
/** `codesign -d` prints the signature on stderr. */
const signature = (path: string) => text("sh", ["-c", `codesign -d -vv --entitlements - ${JSON.stringify(path)} 2>&1`]);
const MARKER = "/run/p40-counter";

interface AppState { app_pid: number; app_ppid: number; child_pid: number; bundle_id: string; ls_ui_element: boolean; activation_policy: string; xpc_service_name: string }

export async function run(ctx: ProofContext): Promise<Check[]> {
  const { machine, sandboxes, ok, sh, record, vmRSS, cleanup } = realDaemon(ctx, { probe: "40" });
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "localbox-proof-40-app-")));
  const socket = join(machine, "agent.sock"), images = join(machine, "images");
  const log = join(ctx.evidence, "40-hostd.log"), stateFile = join(ctx.evidence, "40-app-state.json"), eventsFile = join(ctx.evidence, "40-app-events.jsonl"), configFile = join(scratch, "config.json");
  const evidence: Record<string, any> = { machine_root: machine, host_memory_bytes: Number(text("sysctl", ["-n", "hw.memsize"])), full_table: fullTable };
  const spawned = new Set<number>();
  let bin = "", adhocApp = "", scratchKeychain = "", current: AppState | undefined;
  const checks: Check[] = [];

  const events = (appPid: number): any[] => existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.app_pid === appPid) : [];
  const footprintKb = () => [...vmRSS().values()].reduce((sum, kb) => sum + kb, 0);

  /** `open -g` the supervisor app, which spawns `executable` with realDaemon's environment (plus `extra`); waits for the socket. */
  const launch = async (app: string, executable: string, extra: Record<string, string> = {}): Promise<AppState> => {
    assert.ok(!current || (!alive(current.app_pid) && !alive(current.child_pid)), "the last app and daemon have exited");
    rmSync(stateFile, { force: true }); rmSync(socket, { force: true });
    const env = { LOCALBOX_SANDBOX_BACKEND: "apple", LOCALBOX_SANDBOXES: sandboxes, LOCALBOX_OPERATIONS: join(machine, "operations"), LOCALBOX_IMAGES: images, LOCALBOX_SOCKET: socket, LOCALBOX_IPC_TOKEN_PATH: join(machine, "ipc-token"), ...extra };
    writeFileSync(configFile, JSON.stringify({ executable, env, cwd: ctx.root, log, state: stateFile, events: eventsFile }));
    const opened = await ctx.exec("open", ["-g", app, "--env", `LOCALBOX_SPIKE_CONFIG=${configFile}`]);
    assert.equal(opened.code, 0, `open -g: ${opened.stderr}`);
    for (let waited = 0; waited < 30_000 && !existsSync(stateFile); waited += 100) await sleep(100);
    assert.ok(existsSync(stateFile), "the app wrote its state file (it launched and spawned the daemon)");
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as AppState;
    spawned.add(state.app_pid); spawned.add(state.child_pid); current = state;
    for (let waited = 0; waited < 30_000 && !existsSync(socket) && alive(state.child_pid); waited += 100) await sleep(100);
    assert.ok(existsSync(socket), `the daemon did not open its socket: ${readFileSync(log, "utf8").slice(-1500)}`);
    return state;
  };

  /** SIGTERM to the app, which SIGTERMs the daemon and waits with no deadline. Returns what the app recorded and the wall time. */
  const terminateApp = async () => {
    const state = current!; const at = Date.now();
    process.kill(state.app_pid, "SIGTERM");
    while (alive(state.app_pid) || alive(state.child_pid)) { if (Date.now() - at > 20 * 60_000) throw new Error("the app was still waiting for the daemon after 20 min"); await sleep(25); }
    const wall = Date.now() - at; const rows = events(state.app_pid);
    return { wall_ms: wall, sent: rows.find((row) => row.event === "sigterm_sent"), exited: rows.find((row) => row.event === "child_exited") };
  };

  const untilRunning = async (ids: string[], withinMs = 300_000) => {
    const at = Date.now(); const last: Record<string, any> = {};
    for (const sandboxId of ids) {
      for (;;) {
        last[sandboxId] = await ok("sandbox.status", sandboxId);
        if (last[sandboxId].state === "running" || last[sandboxId].lifecycle === "error") break;
        if (Date.now() - at > withinMs) throw new Error(`${sandboxId} was ${last[sandboxId].state} after ${withinMs} ms`);
        await sleep(200);
      }
      assert.equal(last[sandboxId].state, "running", JSON.stringify(last[sandboxId]));
    }
    return last;
  };

  /** A loop that writes a climbing counter to a tmpfs file (memory only, so it survives only if the memory does). */
  const startMarker = async (sandboxId: string) => {
    const pid = await sh(sandboxId, `nohup sh -c 'i=0; while :; do i=$((i+1)); echo $i > ${MARKER}.tmp && mv ${MARKER}.tmp ${MARKER}; sleep 0.2; done' >/dev/null 2>&1 & echo $!`);
    assert.match(pid, /^\d+$/); await sleep(600); return pid;
  };
  const counter = async (sandboxId: string, pid: string) => {
    const out = await sh(sandboxId, `kill -0 ${pid} 2>/dev/null && cat ${MARKER} || echo gone`);
    assert.match(out, /^\d+$/, `marker process ${pid} in ${sandboxId}: ${out}`); return Number(out);
  };
  /** The marker process is the same PID, its counter is at least `floor` and still climbing. Returns the two readings. */
  const climbing = async (sandboxId: string, pid: string, floor: number) => {
    const first = await counter(sandboxId, pid); await sleep(1_200); const second = await counter(sandboxId, pid);
    assert.ok(first >= floor, `the counter kept its value: ${first} >= ${floor}`); assert.ok(second > first, `the counter climbs: ${first} -> ${second}`);
    return [first, second];
  };
  /** Fills a tmpfs with random bytes: memory the guest has really written, which a save cannot skip or compress. */
  const dirty = async (sandboxId: string, mib: number) =>
    await sh(sandboxId, `mkdir -p /mnt/p40 && mount -t tmpfs -o size=${mib + 16}m tmpfs /mnt/p40 && dd if=/dev/urandom of=/mnt/p40/blob bs=1M count=${mib} 2>/dev/null && (head -c 1048576 /mnt/p40/blob; tail -c 1048576 /mnt/p40/blob) | sha256sum | cut -c1-16`);
  const blobSum = async (sandboxId: string) => await sh(sandboxId, "(head -c 1048576 /mnt/p40/blob; tail -c 1048576 /mnt/p40/blob) | sha256sum | cut -c1-16");
  const hostMemory = () => ({ free: text("memory_pressure", []).split("\n").pop(), swap: text("sysctl", ["-n", "vm.swapusage"]) });
  const savedState = (sandboxId: string) => join(sandboxes, sandboxId, "state.vzsave");
  const create = async (sandboxId: string, name: string, memoryBytes: number) => {
    const created = await ok("sandbox.create", sandboxId, { name, image: "linux", cpus: 2, memory_bytes: memoryBytes, sleep_after_ms: 60 * 60_000 });
    assert.deepEqual(created.actions.map((action: any) => action.kind), ["created", "cold_booted"]); return created;
  };

  /** Checks 3 and 8: the app is told to stop, the daemon hibernates, a relaunch wakes the sandbox with its marker alive. */
  const quitAndRelaunch = async (app: string, executable: string, sandboxId: string, pid: string, into: Record<string, any>) => {
    const before = await counter(sandboxId, pid);
    const stopped = await terminateApp(); into.stop = stopped;
    assert.ok(stopped.sent, "the app recorded sending SIGTERM to the daemon");
    assert.equal(stopped.exited?.how, "exit"); assert.equal(stopped.exited?.status, 0, "the daemon exited 0 after its saves");
    const saved = record(sandboxId); into.record_after_stop = saved;
    assert.equal(saved.lifecycle, "hibernated"); assert.ok(existsSync(savedState(sandboxId)), "state.vzsave exists");
    into.saved_state_bytes = statSync(savedState(sandboxId)).size;
    assert.equal(vmRSS().size, 0, "no VM service of this root is left");
    const at = Date.now(); const state = await launch(app, executable); into.relaunched = state;
    const status = (await untilRunning([sandboxId]))[sandboxId]; into.restore_ms = Date.now() - at; into.status_after_relaunch = status;
    assert.equal(status.last_boot?.kind, "woke", JSON.stringify(status.last_boot));
    into.recovery_log = readFileSync(log, "utf8").split("\n").filter((line) => line.includes(`${sandboxId} woke`)).slice(-1)[0];
    assert.ok(into.recovery_log, "the daemon's recovery logged woke");
    into.counter = { before_stop: before, after_relaunch: await climbing(sandboxId, pid, before) };
  };

  const alpha = "sandbox_p40_alpha", alphaName = "alpha-otter";
  let alphaPid = "";
  try {
    checks.push(await ctx.check("build: the dev image, the dev-signed daemon and the supervisor app (LSUIElement, sh.localbox.spike.child)", async () => {
      bin = await buildRealVMs(ctx);
      if (!existsSync(join(images, "linux"))) await installLinuxImage(dirname(dirname(await linuxImage(ctx))), images);
      const built = await ctx.exec("sh", ["specs/menu-bar-app/spikes/02/build.sh", join(scratch, "adhoc")]);
      assert.equal(built.code, 0, built.stderr.slice(-1500)); adhocApp = join(scratch, "adhoc/LocalboxSpikeChild.app");
      evidence.daemon_signature = signature(join(bin, "localbox-hostd"));
    }));
    if (screenLocked()) {
      checks.push({ name: "an unlocked session", ok: false, ms: 0, detail: "blocked: the screen is locked with a password, and hibernation needs an unlocked session; unlock and run again" });
      return checks;
    }
    const daemon = join(bin, "localbox-hostd");

    checks.push(await ctx.check("1 the daemon is the child of the open -g app; a Linux sandbox boots, shell.exec answers, a marker loop counts", async () => {
      const state = await launch(adhocApp, daemon); evidence.launch = state;
      assert.equal(state.bundle_id, "sh.localbox.spike.child"); assert.equal(state.ls_ui_element, true); assert.equal(state.activation_policy, "accessory");
      assert.equal(state.app_ppid, 1, "LaunchServices started the app (its parent is launchd)");
      evidence.process_tree = text("ps", ["-o", "pid=,ppid=,command=", "-p", String(state.app_pid), "-p", String(state.child_pid)]);
      assert.equal(Number(text("ps", ["-o", "ppid=", "-p", String(state.child_pid)])), state.app_pid, "the daemon's parent is the app");
      evidence.daemon_stdin = text("lsof", ["-a", "-p", String(state.child_pid), "-d", "0"]).split("\n").pop();
      assert.match(evidence.daemon_stdin, /PIPE/, "the daemon's stdin is a pipe");
      evidence.create = await create(alpha, alphaName, 2 * GIB);
      evidence.uname = await sh(alpha, "uname -srm"); assert.match(evidence.uname, /^Linux /);
      evidence.vm_services = text("sh", ["-c", `ps -o pid=,ppid=,command= -p ${[...vmRSS().keys()].join(",") || 0} | cut -c1-160`]);
      alphaPid = await startMarker(alpha); evidence.marker = { pid: alphaPid, counter: await climbing(alpha, alphaPid, 1) };
    }));

    checks.push(await ctx.check("2 sandbox.sleep writes the saved state and frees the VM's memory; the wake keeps the marker counting", async () => {
      const before = await counter(alpha, alphaPid); const awakeKb = footprintKb();
      const slept = await ok("sandbox.sleep", alpha); const status = await ok("sandbox.status", alpha);
      evidence.sleep = { result: slept, status, vm_footprint_kb_awake: awakeKb, vm_services_asleep: vmRSS().size, saved_state_bytes: existsSync(savedState(alpha)) ? statSync(savedState(alpha)).size : 0 };
      assert.equal(slept.actions[0].kind, "slept"); assert.match(slept.actions[0].detail, /^hibernated /, slept.actions[0].detail);
      assert.equal(status.lifecycle, "asleep"); assert.equal(record(alpha).lifecycle, "asleep");
      assert.ok(evidence.sleep.saved_state_bytes > 0, "state.vzsave was written"); assert.ok(awakeKb > 0, "the VM held memory while awake");
      assert.equal(vmRSS().size, 0, "the VM service exited: its memory is released");
      const woke = await ok("shell.exec", alpha, { command: `kill -0 ${alphaPid} && cat ${MARKER}`, cwd: "/" }); evidence.sleep.wake = woke.actions;
      assert.deepEqual(woke.actions.map((action: any) => action.kind), ["woke"]);
      evidence.sleep.counter = { before_sleep: before, after_wake: await climbing(alpha, alphaPid, before) };
    }));

    checks.push(await ctx.check("3 SIGTERM to the app: it SIGTERMs the daemon and waits; the record says hibernated; a relaunch reports woke with the marker alive", async () => {
      evidence.check3 = {}; await quitAndRelaunch(adhocApp, daemon, alpha, alphaPid, evidence.check3);
    }));

    checks.push(await ctx.check("7 host.simulate_power (LOCALBOX_DEV=1) hibernates and wakes in the child", async () => {
      const before = await counter(alpha, alphaPid);
      await terminateApp(); await launch(adhocApp, daemon, { LOCALBOX_DEV: "1" }); await untilRunning([alpha]);
      const slept = await ok("host.simulate_power", null, { event: "will_sleep" }); const status = await ok("sandbox.status", alpha);
      evidence.check7 = { will_sleep: slept, status_asleep: status, record_asleep: record(alpha).lifecycle, vm_services_asleep: vmRSS().size, saved_state_bytes: existsSync(savedState(alpha)) ? statSync(savedState(alpha)).size : 0 };
      assert.ok(slept.sandboxes.length === 1 && slept.sandboxes[0].kind === "slept", JSON.stringify(slept)); assert.match(slept.sandboxes[0].detail, /^hibernated /);
      assert.equal(status.state, "sleeping"); assert.equal(vmRSS().size, 0, "the VM service exited"); assert.ok(evidence.check7.saved_state_bytes > 0);
      evidence.check7.did_wake = await ok("host.simulate_power", null, { event: "did_wake" });
      assert.equal(evidence.check7.did_wake.sandboxes[0]?.kind, "woke", JSON.stringify(evidence.check7.did_wake));
      await untilRunning([alpha]);
      evidence.check7.counter = { before, after_wake: await climbing(alpha, alphaPid, before) };
    }));

    checks.push(await ctx.check("5 kill -9 of the app: what the orphaned daemon and its VM do (recorded), and SIGTERM still hibernates the orphan", async () => {
      const state = current!; const before = await counter(alpha, alphaPid);
      process.kill(state.app_pid, "SIGKILL"); const at = Date.now();
      while (alive(state.app_pid)) await sleep(20);
      await sleep(5_000);
      const orphan: Record<string, any> = { daemon_alive_after_5s: alive(state.child_pid), daemon_ppid: Number(text("ps", ["-o", "ppid=", "-p", String(state.child_pid)])), vm_services: vmRSS().size,
        daemon_stdin: text("lsof", ["-a", "-p", String(state.child_pid), "-d", "0"]).split("\n").pop(), log_tail: readFileSync(log, "utf8").split("\n").filter(Boolean).slice(-3) };
      evidence.check5 = orphan;
      if (orphan.daemon_alive_after_5s) {
        orphan.socket_answers = await ok("shell.exec", alpha, { command: "echo still-here", cwd: "/" }).then((result) => result.stdout.trim(), (error) => `failed: ${error.message}`);
        orphan.counter = { before_kill: before, after_kill: await climbing(alpha, alphaPid, before).catch((error) => `failed: ${error.message}`) };
        await sleep(10_000);
        orphan.daemon_alive_after_20s = alive(state.child_pid); orphan.vm_services_after_20s = vmRSS().size; orphan.observed_ms = Date.now() - at;
        // Clean up the orphan the way a supervisor would have: SIGTERM, wait with no deadline.
        const termAt = Date.now(); process.kill(state.child_pid, "SIGTERM");
        while (alive(state.child_pid)) { if (Date.now() - termAt > 10 * 60_000) throw new Error("the orphaned daemon ignored SIGTERM for 10 min"); await sleep(25); }
        orphan.sigterm_ms = Date.now() - termAt; orphan.record_after_sigterm = record(alpha).lifecycle; orphan.vm_services_after_sigterm = vmRSS().size;
      }
      // This check records behaviour; it fails only when nothing could be observed.
      assert.equal(typeof orphan.daemon_alive_after_5s, "boolean");
    }));

    checks.push(await ctx.check("6 kill -9 of the daemon mid-save: the next start reports cold_booted and the disk boots", async () => {
      // After check 5 the sandbox is hibernated (orphan alive) or was left running (orphan died); either way it comes back.
      await launch(adhocApp, daemon); await untilRunning([alpha]);
      const marker = `p40-disk-${Date.now()}`;
      await sh(alpha, `echo ${marker} > /root/p40-disk && sync`);
      const pid = await startMarker(alpha);
      evidence.check6 = { dirtied_mib: 1280, blob: await dirty(alpha, 1280) };
      const state = current!; const at = Date.now();
      // Mid-save: the daemon writes the VM to `.save-<uuid>.vzvmsave` and renames it to state.vzsave when it is whole.
      const partialSave = () => readdirSync(join(sandboxes, alpha)).find((name) => /^\.save-.*\.vzvmsave$/.test(name));
      process.kill(state.app_pid, "SIGTERM");
      while (!partialSave() && alive(state.child_pid) && Date.now() - at < 60_000) await sleep(5);
      await sleep(100);
      const partial = partialSave(), wasAlive = alive(state.child_pid), partialBytes = partial ? statSync(join(sandboxes, alpha, partial)).size : -1;
      if (wasAlive) process.kill(state.child_pid, "SIGKILL");
      Object.assign(evidence.check6, { killed_after_ms: Date.now() - at, daemon_alive_at_kill: wasAlive, partial_save_at_kill: partial ?? null, partial_save_bytes_at_kill: partialBytes });
      assert.ok(wasAlive && partial, "the daemon was still writing the save when it was killed");
      while (alive(state.app_pid) || alive(state.child_pid)) await sleep(25);
      evidence.check6.app_event = events(state.app_pid).find((row) => row.event === "child_exited");
      evidence.check6.record_after_kill = record(alpha).lifecycle;
      assert.notEqual(record(alpha).lifecycle, "hibernated", "the save never completed");
      // The VM service outlives a SIGKILLed daemon briefly; ours only (Colima's VM is one too).
      for (let waited = 0; waited < 10_000 && vmRSS().size; waited += 250) await sleep(250);
      evidence.check6.vm_services_left = vmRSS().size;
      for (const service of vmRSS().keys()) { try { process.kill(service, "SIGKILL"); } catch { /* gone */ } }
      await launch(adhocApp, daemon);
      // Wait on host.watch, which names no sandbox: a sandbox operation would be the "next result" itself.
      for (let waited = 0; waited < 180_000; waited += 500) {
        const watched = await ok("host.watch", null, { since: 0 });
        if (watched.sandboxes.find((row: any) => row.sandbox_id === alpha)?.state === "running") break;
        await sleep(500);
      }
      const first = await ok("shell.exec", alpha, { command: `cat /root/p40-disk; kill -0 ${pid} 2>/dev/null && echo alive || echo gone`, cwd: "/" });
      evidence.check6.after_restart = { actions: first.actions, stdout: first.stdout.trim() };
      assert.deepEqual(first.actions.map((action: any) => action.kind), ["cold_booted"]);
      assert.equal(first.stdout.trim(), `${marker}\ngone`, "the disk booted with the synced file; the old processes are gone");
      evidence.check6.partial_save_after_restart = partialSave() ?? null;
      evidence.check6.recovery_log = readFileSync(log, "utf8").split("\n").filter((line) => line.includes(`${alpha} cold_booted`)).slice(-1)[0];
      await ok("sandbox.delete", alpha);
    }));

    checks.push(await ctx.check(`8 check 3 again with the daemon inside the bundle, both signed by a self-signed identity (${keychainIdentity ?? "a throwaway one in a scratch keychain"})`, async () => {
      const identity = keychainIdentity ?? "Localbox Spike 02 Scratch"; const signing = ["--identity", identity];
      if (/Localbox Release/.test(identity)) throw new Error("blocked: this probe never signs with the release identity");
      if (keychainIdentity) {
        if (!text("security", ["find-identity", "-v", "-p", "codesigning"]).includes(`"${identity}"`)) throw new Error(`blocked: no code signing identity "${identity}" in the keychain`);
        // A key whose access list does not name codesign raises a dialog and codesign waits on it for ever.
        const trial = join(scratch, "trial"); execFileSync("cp", ["/usr/bin/true", trial]);
        try { execFileSync("codesign", ["--force", "--timestamp=none", "--sign", identity, trial], { timeout: 20_000, stdio: "ignore" }); }
        catch { throw new Error(`blocked: codesign could not sign with "${identity}" within 20 s (a keychain access dialog needs a click)`); }
      } else {
        const made = await ctx.exec("sh", ["specs/menu-bar-app/spikes/02/scratch-identity.sh", join(scratch, "identity")]);
        assert.equal(made.code, 0, made.stderr.slice(-800)); scratchKeychain = made.stdout.trim(); signing.push("--keychain", scratchKeychain);
      }
      await terminateApp();
      const built = await ctx.exec("sh", ["specs/menu-bar-app/spikes/02/build.sh", join(scratch, "signed"), "--daemon", daemon, ...signing]);
      assert.equal(built.code, 0, built.stderr.slice(-1500));
      const signedApp = join(scratch, "signed/LocalboxSpikeChild.app"), signedDaemon = join(signedApp, "Contents/MacOS/localbox-hostd");
      evidence.check8 = { identity, keychain: scratchKeychain ? "scratch (not in the search list)" : "login", daemon_signature: signature(signedDaemon), app_signature: signature(signedApp) };
      assert.match(evidence.check8.daemon_signature, new RegExp(`Authority=${identity}`)); assert.match(evidence.check8.daemon_signature, /com\.apple\.security\.virtualization/);
      const state = await launch(signedApp, signedDaemon); evidence.check8.launch = state;
      assert.equal(Number(text("ps", ["-o", "ppid=", "-p", String(state.child_pid)])), state.app_pid);
      const beta = "sandbox_p40_beta";
      await create(beta, "beta-heron", 2 * GIB);
      const pid = await startMarker(beta);
      await quitAndRelaunch(signedApp, signedDaemon, beta, pid, evidence.check8);
      await ok("sandbox.delete", beta);
      await terminateApp(); await launch(adhocApp, daemon);
    }));

    checks.push(await ctx.check(`4 timing table: hibernate wall time for 1, 2 and 4 VMs at 2 GiB${fullTable ? " and 8 GiB" : ""}, memory dirtied first`, async () => {
      if (!current || !alive(current.child_pid)) await launch(adhocApp, daemon);
      const budgetGib = Math.floor(evidence.host_memory_bytes * 0.75 / GIB);
      // [VMs, GiB each, MiB of random bytes written into each guest's memory first]
      const cells: Array<{ vms: number; gib: number; dirty_mib: number; note?: string }> = [1, 2, 4].map((vms) => ({ vms, gib: 2, dirty_mib: 1280 }));
      if (fullTable) for (const vms of [1, 2, 4]) {
        const gib = Math.min(8, Math.floor(budgetGib / vms));
        cells.push({ vms, gib, dirty_mib: gib * 768, ...(gib < 8 ? { note: `scaled from 8 GiB: ${vms} x 8 GiB is over this Mac's ${budgetGib} GiB admission budget` } : {}) });
      }
      evidence.timing = []; const problems: string[] = []; evidence.timing_problems = problems;
      for (const cell of cells) {
        const row: Record<string, any> = { ...cell, host_before: hostMemory() }; evidence.timing.push(row);
        const ids = Array.from({ length: cell.vms }, (_, index) => `sandbox_p40_t${cell.gib}g${cell.vms}v${index}`);
        for (const [index, sandboxId] of ids.entries()) await create(sandboxId, `timing-${cell.gib}g${cell.vms}v-${index}`, cell.gib * GIB);
        const pids: Record<string, string> = {}; for (const sandboxId of ids) pids[sandboxId] = await startMarker(sandboxId);
        const sums = await Promise.all(ids.map((sandboxId) => dirty(sandboxId, cell.dirty_mib)));
        row.guest_meminfo = (await sh(ids[0], "grep -E '^(MemTotal|MemAvailable|Shmem):' /proc/meminfo")).replace(/\s+/g, " ");
        row.vm_footprint_mib = Math.round(footprintKb() / 1024); row.host_dirtied = hostMemory();
        const before: Record<string, number> = {}; for (const sandboxId of ids) before[sandboxId] = await counter(sandboxId, pids[sandboxId]);
        const stopped = await terminateApp();
        row.hibernate_wall_ms = stopped.wall_ms; row.app_waited_ms = stopped.exited?.waited_ms; row.daemon_exit = `${stopped.exited?.how} ${stopped.exited?.status}`;
        row.records = ids.map((sandboxId) => record(sandboxId).lifecycle);
        row.saved_state_mib = Math.round(ids.reduce((sum, sandboxId) => sum + (existsSync(savedState(sandboxId)) ? statSync(savedState(sandboxId)).size : 0), 0) / MIB);
        if (row.records.some((lifecycle: string) => lifecycle !== "hibernated")) problems.push(`${cell.vms} x ${cell.gib} GiB: records after the stop were ${row.records.join(", ")}`);
        const at = Date.now(); await launch(adhocApp, daemon); const statuses = await untilRunning(ids); row.restore_ms = Date.now() - at;
        row.last_boot = ids.map((sandboxId) => statuses[sandboxId].last_boot?.kind);
        // A restore that fails falls back to a cold boot (the daemon's own rule); the cell is still timed, and reported.
        for (const [index, sandboxId] of ids.entries()) {
          if (row.last_boot[index] !== "woke") { problems.push(`${cell.vms} x ${cell.gib} GiB: ${sandboxId} came back ${row.last_boot[index]}: ${statuses[sandboxId].last_boot?.detail}`); continue; }
          await climbing(sandboxId, pids[sandboxId], before[sandboxId]); assert.equal(await blobSum(sandboxId), sums[index], `${sandboxId}'s dirtied memory came back intact`);
        }
        row.host_after = hostMemory();
        for (const sandboxId of ids) await ok("sandbox.delete", sandboxId);
      }
      assert.deepEqual(problems, [], "every VM hibernated and every restore woke");
    }));
  } finally {
    // Only what this probe started: the apps and daemons it launched (by pid), then this root's VM services and the root.
    for (const pid of spawned) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await cleanup();
    if (scratchKeychain) await ctx.exec("security", ["delete-keychain", scratchKeychain]);
    rmSync(scratch, { recursive: true, force: true });
    writeFileSync(join(ctx.evidence, "40-app-child.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  return checks;
}
