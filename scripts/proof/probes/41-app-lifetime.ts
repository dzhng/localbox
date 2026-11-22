import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { callApp } from "../../../apps/cli/src/app-socket.js";
import { writeImageFiles } from "../lib/images.js";
import { installLinuxImage, linuxImage } from "../lib/linux-image.js";
import { packagedApp } from "../lib/packaged-app.js";
import { buildRealVMs, screenLocked } from "../lib/real-daemon.js";

// Localbox.app supervises the daemon and the connector. Launched quietly it starts both as its children (with no
// screen too); a crashed connector comes back; quitting stops the connector, waits for the daemon to save every
// sandbox and only then exits; killing the app outright still stops the daemon cleanly (its stdin closes) and a
// relaunch has exactly one daemon. No launchd job is involved. `localbox app status` reports both children through
// the app socket, including a killed daemon backing off and coming back; the login item is the app's fake one, never
// this account's. A long poll with `--since` answers as soon as a sandbox goes to sleep. The popover opens (through
// the development build's `popover.*` test hooks) without the app taking focus, and its Sleep and Wake reach the
// daemon. Settings opens the same way (`settings.*`) and its Open at login switch reaches the app's fake login item
// through the CLI.
//
//   npm run proof -- 41 --tier a      the packaged dev app on the process-fixture backend
//   npm run proof -- 41 --tier v      quit and relaunch with a real VM whose memory survives
//
// A fixture sandbox cannot save its state: where tier v says "hibernated" and "woke", tier a sees the fixture's
// "stopped: cannot save" and "cold_booted". Hibernation itself is proven only at tier v.

export const id = "41";
export const tiers = ["a", "v"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SANDBOX = "sandbox_p41_alpha", NAME = "alpha-otter";
/**
 * launchd jobs naming localbox: this run must add none. LaunchServices lists every running app as
 * `application.<bundle id>.…`; that entry is the app itself, not a job.
 */
const launchdJobs = () => execFileSync("launchctl", ["list"], { encoding: "utf8" }).split("\n").map((line) => line.split("\t")[2] ?? "")
  .filter((label) => label.toLowerCase().includes("localbox") && !label.startsWith("application.")).sort();

export async function run(ctx: ProofContext): Promise<Check[]> {
  return ctx.tier === "v" ? await realVM(ctx) : await fixture(ctx);
}

async function fixture(ctx: ProofContext): Promise<Check[]> {
  const app = packagedApp(ctx, { probe: "41", backend: "process-fixture" });
  const checks: Check[] = [];
  const jobs = launchdJobs();
  let pid = 0;
  /** The daemon's status for the sandbox once it is running again after a start. */
  const runningAgain = async () => {
    let status: any;
    await app.until(async () => { status = await app.ok("sandbox.status", SANDBOX); return status.state === "running"; }, `${NAME} running`);
    return status;
  };
  try {
    checks.push(await ctx.check("build: a dev bundle with the app, the entitled daemon, the launcher, the CLI and its Node", async () => {
      assert.equal((await ctx.exec("npm", ["run", "-s", "build"])).code, 0, "npm run build");
      const bundle = await app.build();
      const plist = readFileSync(join(bundle, "Contents/Info.plist"), "utf8");
      assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>sh\.localbox\.mac\.dev<\/string>/);
      assert.ok(!plist.includes("SUFeedURL"), "a dev build has no update feed");
      assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
      for (const file of ["MacOS/Localbox", "MacOS/localbox-hostd", "Resources/bin/localbox", "Resources/cli/localbox", "Resources/cli/dist/apps/cli/src/index.js", "Resources/cli/node_modules/convex", "Resources/cli/skill/SKILL.md", "Resources/node/bin/node"])
        assert.ok(existsSync(join(bundle, "Contents", file)), `Contents/${file}`);
      const entitlements = execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", join(bundle, "Contents/MacOS/localbox-hostd")], { encoding: "utf8" });
      assert.ok(entitlements.includes("com.apple.security.virtualization"), `the daemon's entitlements: ${entitlements}`);
    }));

    checks.push(await ctx.check("open -g starts the app without focus; it made the machine root and token, and runs the daemon and the connector as its children", async () => {
      pid = await app.start();
      const running = app.processes();
      assert.deepEqual(running.daemons.map((row) => row.ppid), [pid], "one daemon, the app's child");
      await app.until(() => app.processes().connectors.length === 1, "the connector");
      assert.deepEqual(app.processes().connectors.map((row) => row.ppid), [pid], "one connector, the app's child");
      assert.equal(statSync(app.paths.ipcToken).mode & 0o777, 0o600);
      assert.equal((await app.cli(["app", "paths"])).socket, app.paths.socket);
      assert.match(app.log("connector.log"), /not signed in; waiting for localbox login/, "signed out, the connector waits instead of exiting");
      assert.deepEqual(launchdJobs(), jobs, "no launchd job was added");
    }));

    checks.push(await ctx.check("quit: the connector stops, the daemon records its sandbox's outcome and exits, and only then does the app", async () => {
      // Under the app a create waits for the built-in image (probe 43); the fixture boots no disk, so a stand-in does.
      writeImageFiles(join(app.paths.images, "linux"), "linux", { bytes: 1024 * 1024 });
      await app.ok("sandbox.create", SANDBOX, { name: NAME, image: "linux", cpus: 2, memory_bytes: 2 * 1024 ** 3, sleep_after_ms: 60 * 60_000 });
      const offset = app.log("hostd.log").length;
      const { daemonGoneAt, appGoneAt, atDaemonExit } = await app.stop(() => app.record(SANDBOX));
      assert.ok(daemonGoneAt <= appGoneAt, `the daemon went at ${daemonGoneAt} ms, the app at ${appGoneAt} ms`);
      assert.match(atDaemonExit.cold_boot_pending ?? "", /^fixture: /, `the record when the daemon exited: ${JSON.stringify(atDaemonExit)}`);
      const said = app.log("hostd.log").slice(offset);
      assert.match(said, /stopping \(stdin closed\): hibernating running sandboxes/);
      assert.match(said, new RegExp(`stopped ${NAME}: the process fixture cannot save its state`));
      assert.deepEqual(app.processes(), { app: undefined, daemons: [], connectors: [], imageEnsures: [] }, "nothing of the app is left running");
      assert.match(app.log("connector.log"), /stopping: stdin closed/);
    }));

    checks.push(await ctx.check("a relaunch brings the sandbox back through the daemon's start-time restore", async () => {
      pid = await app.start();
      const status = await runningAgain();
      assert.equal(status.last_boot?.kind, "cold_booted", JSON.stringify(status.last_boot));
      assert.match(status.last_boot?.detail ?? "", /fixture/);
    }));

    checks.push(await ctx.check("localbox app status: the daemon running, this Mac's sandbox by name, the login item untouched (a dev build registers none)", async () => {
      const status = await app.cli(["app", "status"]);
      assert.equal(status.daemon, "running", JSON.stringify(status));
      assert.deepEqual(status.connector, { state: "signed_out" }, "a scratch HOME is signed out");
      assert.equal(status.build, "dev"); assert.equal(status.stopping, null); assert.equal(status.update, null);
      assert.equal(status.open_at_login, "disabled");
      assert.deepEqual(status.sandboxes, [{ sandbox_id: SANDBOX, name: NAME, os: "linux", state: "running" }]);
      assert.equal(typeof status.capacity?.cpus_total, "number");
      assert.equal(status.warnings[0]?.code, "signed_out", JSON.stringify(status.warnings));
      mkdirSync(ctx.evidence, { recursive: true });
      writeFileSync(join(ctx.evidence, "41-app-status.json"), `${JSON.stringify(status, null, 2)}\n`);
      assert.deepEqual(await app.cli(["app", "login-item", "on"]), { state: "enabled" }, "the fake login item, never this account's");
      assert.deepEqual(await app.cli(["app", "login-item", "off"]), { state: "disabled" });
      const unknown = await callApp(app.paths.appSocket, "update.status" as never).then(() => undefined, (error) => error);
      assert.equal(unknown?.code, "unsupported", String(unknown));
    }));

    checks.push(await ctx.check("app status --since: a sandbox put to sleep shows its sleep within one long poll (paused on the fixture)", async () => {
      const before = await app.cli(["app", "status"]);
      const started = Date.now();
      const waiting = app.cli(["app", "status", "--since", String(before.watch_version)]);
      await sleep(1_000);  // the poll is waiting on the daemon by now
      await app.ok("sandbox.sleep", SANDBOX);
      const after = await waiting;
      const took = Date.now() - started;
      // The process fixture cannot save its state, so it sleeps in memory (`paused`); a VM's sleep reads `asleep` (tier v).
      assert.deepEqual(after.sandboxes.map((row: any) => row.state), ["paused"], JSON.stringify(after.sandboxes));
      assert.notEqual(after.watch_version, before.watch_version);
      assert.ok(took < 20_000, `answered ${took} ms after the poll began, not at its 25 s timeout`);
      await app.ok("sandbox.start", SANDBOX);
    }));

    checks.push(await ctx.check("the popover opens (test hook) without the app ever becoming frontmost; its Sleep and Wake change the daemon's state", async () => {
      if ((await app.ok("sandbox.status", SANDBOX)).state !== "running") await app.ok("sandbox.start", SANDBOX);
      await runningAgain();
      const popover = async (operation: string, params: Record<string, string> = {}): Promise<any> => await callApp(app.paths.appSocket, operation as never, params);
      const before = app.front(), fronts = new Set<number>();
      /** Opens the popover (a no-op once open) and waits until its row for the sandbox reads `state`. */
      const shows = async (state: string) => {
        let seen: any;
        await app.until(async () => {
          seen = await popover("popover.open");
          const now = app.front(); if (now !== undefined) fronts.add(now);
          return seen.shown && seen.sandboxes.includes(`${NAME} ${state} · Linux`);
        }, `the popover showing ${NAME} ${state}`, 30_000);
        return seen;
      };
      const open = await shows("Running");
      assert.equal(open.title, "Not signed in", JSON.stringify(open));
      assert.equal(open.status_icon, "warning", "signed out is a warning, so the status item shows its warning variant");
      await popover("popover.perform", { action: "sleep", name: NAME });
      // The fixture sleeps in memory, so the daemon's state is paused (a VM's is asleep); the open popover follows it.
      await shows("Paused");
      assert.notEqual((await app.ok("sandbox.status", SANDBOX)).state, "running");
      await popover("popover.perform", { action: "wake", name: NAME });
      await shows("Running");
      await runningAgain();
      const refused = await popover("popover.perform", { action: "wake", name: NAME }).then(() => undefined, (error) => error);
      assert.deepEqual([refused?.code, /offers no wake/.test(String(refused?.message))], ["conflict", true], "a running sandbox's row offers no Wake");
      assert.equal((await popover("popover.close")).shown, false);
      const after = app.front();
      assert.ok(!fronts.has(pid) && after !== pid, `the app was frontmost (front before ${before}, after ${after}, seen ${[...fronts]})`);
    }));

    checks.push(await ctx.check("Settings opens (test hook) without the app becoming frontmost; its Open at login switch runs app login-item on the fake item", async () => {
      const settings = async (operation: string, params: Record<string, unknown> = {}): Promise<any> => await callApp(app.paths.appSocket, operation as never, params as never);
      const fronts = new Set<number>();
      const until = async (what: string, done: (state: any) => boolean) => {
        let seen: any;
        await app.until(async () => {
          seen = await settings("settings.state");
          const now = app.front(); if (now !== undefined) fronts.add(now);
          return done(seen);
        }, `Settings: ${what}`, 30_000);
        return seen;
      };
      assert.equal((await settings("settings.open")).shown, true);
      const opened = await until("signed out, the login item read", (state) => state.account === "signed_out" && state.login_item === "disabled");
      assert.equal(opened.login_item_description, "Localbox does not open when you log in.");
      await settings("settings.set_open_at_login", { enabled: true });
      await until("open at login on", (state) => state.login_item === "enabled" && !state.pending);
      assert.equal((await app.cli(["app", "login-item"])).state, "enabled", "the switch went through the CLI to the app's (fake) item");
      await settings("settings.set_open_at_login", { enabled: false });
      const off = await until("open at login off", (state) => state.login_item === "disabled" && !state.pending);
      assert.equal(off.login_failure, null);
      assert.equal((await settings("settings.close")).shown, false);
      assert.ok(!fronts.has(pid) && app.front() !== pid, `the app was frontmost (seen ${[...fronts]})`);
    }));

    checks.push(await ctx.check("a killed daemon: app status shows backing_off, then running again", async () => {
      const [killed] = app.processes().daemons;
      process.kill(killed.pid, "SIGKILL");
      // Straight to the app socket, the CLI's own client: a CLI process takes longer to start than the 1 s backoff.
      const seen: string[] = [];
      await app.until(async () => {
        const daemon = ((await callApp(app.paths.appSocket, "app.info")) as any).children.daemon;
        if (seen.at(-1) !== daemon) seen.push(daemon);
        return daemon === "running" && seen.includes("backing_off");
      }, "the daemon to back off and come back", 20_000);
      assert.deepEqual(seen.slice(seen.indexOf("backing_off")), ["backing_off", "running"], `daemon states seen: ${seen}`);
      assert.equal((await app.cli(["app", "status"])).daemon, "running");
      assert.equal(app.processes().daemons.length, 1);
      await runningAgain();
    }));

    checks.push(await ctx.check("a killed connector is restarted by the app", async () => {
      await app.until(() => app.processes().connectors.length === 1, "the connector");
      const [killed] = app.processes().connectors;
      process.kill(killed.pid, "SIGKILL");
      await app.until(() => app.processes().connectors.some((row) => row.pid !== killed.pid), "a new connector", 10_000);
      assert.deepEqual(app.processes().connectors.map((row) => row.ppid), [pid]);
      assert.match(app.log("app.log"), /connector exited \(signal 9\); restarting in 1\.0 s/);
    }));

    checks.push(await ctx.check("kill -9 the app: its stdin closing stops the daemon (sandbox recorded) and the connector; a relaunch has exactly one daemon", async () => {
      const offset = app.log("hostd.log").length;
      process.kill(pid, "SIGKILL");
      await app.until(() => { const now = app.processes(); return !now.app && !now.daemons.length && !now.connectors.length; }, "the orphaned daemon and connector to exit");
      const said = app.log("hostd.log").slice(offset);
      assert.match(said, /stopping \(stdin closed\)/, said);
      assert.match(said, new RegExp(`stopped ${NAME}: `), said);
      assert.match(app.record(SANDBOX).cold_boot_pending ?? "", /^fixture: /);
      pid = await app.start();
      await runningAgain();
      await sleep(2_000);  // long enough for a second daemon's first retry, were there one
      const daemons = app.processes().daemons;
      assert.equal(daemons.length, 1, JSON.stringify(daemons));
      assert.equal(Number(readFileSync(app.paths.hostdLock, "utf8").trim()), daemons[0].pid, "that daemon holds the machine lock");
    }));

    checks.push(await ctx.check("with no screen (stubbed), supervision still starts", async () => {
      await app.stop(() => undefined);
      pid = await app.start({ LOCALBOX_APP_SCREENS: "0" });
      await app.until(() => app.processes().connectors.length === 1, "the connector");
      assert.equal(app.processes().daemons.length, 1);
      assert.match(app.log("app.log"), /no screen; the status item waits for one/);
      await app.ok("sandbox.delete", SANDBOX, { confirm: NAME });
      await app.stop(() => undefined);
      assert.deepEqual(app.processes(), { app: undefined, daemons: [], connectors: [], imageEnsures: [] }, "nothing of the app is left running");
      assert.deepEqual(launchdJobs(), jobs, "no launchd job was added");
    }));
  } finally {
    await app.cleanup();
  }
  return checks;
}

async function realVM(ctx: ProofContext): Promise<Check[]> {
  const app = packagedApp(ctx, { probe: "41", backend: "apple" });
  const checks: Check[] = [];
  const MARKER = "/run/p41-counter";
  let markerPid = "", counterAtStop = 0;
  const sh = async (command: string): Promise<string> => (await app.ok("shell.exec", SANDBOX, { command, cwd: "/" })).stdout.trim();
  /** A loop writing a climbing counter to a tmpfs file: it survives only if the guest's memory does. */
  const counter = async () => {
    const out = await sh(`kill -0 ${markerPid} 2>/dev/null && cat ${MARKER} || echo gone`);
    assert.match(out, /^\d+$/, `marker process ${markerPid}: ${out}`); return Number(out);
  };
  try {
    checks.push(await ctx.check("build: the dev image and the dev bundle", async () => {
      await buildRealVMs(ctx);
      await app.build();
      // This machine gets `images/linux` as an install does: an APFS clone of the dev image.
      await installLinuxImage(await linuxImage(ctx), app.paths.images);
    }));
    if (screenLocked()) {
      checks.push({ name: "an unlocked session", ok: false, ms: 0, detail: "blocked: the screen is locked with a password, and hibernation needs an unlocked session; unlock and run again" });
      return checks;
    }

    checks.push(await ctx.check("the app's daemon boots a Linux sandbox", async () => {
      await app.start();
      const created = await app.ok("sandbox.create", SANDBOX, { name: NAME, image: "linux", cpus: 2, memory_bytes: 2 * 1024 ** 3, sleep_after_ms: 60 * 60_000 });
      assert.deepEqual(created.actions.map((action: any) => action.kind), ["created", "cold_booted"]);
      markerPid = await sh(`nohup sh -c 'i=0; while :; do i=$((i+1)); echo $i > ${MARKER}.tmp && mv ${MARKER}.tmp ${MARKER}; sleep 0.2; done' >/dev/null 2>&1 & echo $!`);
      assert.match(markerPid, /^\d+$/);
    }));

    checks.push(await ctx.check("quit: the sandbox is hibernated (record and saved state) before the daemon exits, and the app exits after it", async () => {
      counterAtStop = await counter();
      const offset = app.log("hostd.log").length;
      const { daemonGoneAt, appGoneAt, atDaemonExit } = await app.stop(() => ({ record: app.record(SANDBOX), saved: existsSync(join(app.paths.sandboxes, SANDBOX, "state.vzsave")) }));
      assert.ok(daemonGoneAt <= appGoneAt, `the daemon went at ${daemonGoneAt} ms, the app at ${appGoneAt} ms`);
      assert.equal(atDaemonExit.record.lifecycle, "hibernated", JSON.stringify(atDaemonExit.record));
      assert.ok(atDaemonExit.saved, "state.vzsave was written");
      assert.match(app.log("hostd.log").slice(offset), new RegExp(`hibernated ${NAME}`));
    }));

    checks.push(await ctx.check("a relaunch wakes it from its saved state with the marker still counting", async () => {
      await app.start();
      let status: any;
      await app.until(async () => { status = await app.ok("sandbox.status", SANDBOX); return status.state === "running" || status.lifecycle === "error"; }, `${NAME} running`, 180_000);
      assert.equal(status.state, "running", JSON.stringify(status));
      assert.equal(status.last_boot?.kind, "woke", JSON.stringify(status.last_boot));
      const first = await counter(); await sleep(1_200); const second = await counter();
      assert.ok(first >= counterAtStop && second > first, `the counter kept its value and climbs: ${counterAtStop} -> ${first} -> ${second}`);
      await app.ok("sandbox.delete", SANDBOX, { confirm: NAME });
      await app.stop(() => undefined);
      assert.deepEqual(app.processes(), { app: undefined, daemons: [], connectors: [], imageEnsures: [] }, "nothing of the app is left running");
    }));
  } finally {
    await app.cleanup();
  }
  return checks;
}
