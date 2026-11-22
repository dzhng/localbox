import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Check, ProofContext } from "../run.js";
import { callApp } from "../../../apps/cli/src/app-socket.js";
import { LocalIPCTransport } from "../../../packages/client/src/index.js";
import { machinePaths } from "../../../packages/config/src/index.js";
import { PROTOCOL_VERSION, type Json } from "../../../packages/contract/src/index.js";
import { appcast, signAppcast, sparklePublicKey, sparkleSignature } from "../../appcast.js";
import { installLinuxImage } from "../../release.js";
import { linuxImage } from "../lib/linux-image.js";
import { buildRealVMs, screenLocked } from "../lib/real-daemon.js";
import { scratchIdentity } from "../lib/scratch-identity.js";

// Menu bar app, slice 15: an installed Localbox updates itself with Sparkle, a port of Bento's installed-update lab
// (apps/macos/scripts/installed-update-lab.mjs). Two signed bundles, N and N+1, built from this checkout with the
// patched Sparkle linked; a scratch signing identity in a temporary keychain, a scratch feed key (the release key's
// format, PKCS#8 Ed25519), a signed feed served on 127.0.0.1, a scratch HOME and machine root.
//
//   npm run proof -- 44 --tier a   the process fixture: N to N+1 with no window, a command during the replacement is
//                                  refused (75) and works on retry, a long-running command delays the install, the
//                                  home command becomes N+1's launcher, and a killed installer leaves N working
//   npm run proof -- 44 --tier v   one real VM whose marker process is saved by N and woken by N+1
//
// What a scratch HOME cannot isolate (Sparkle's helper uses the account's home, as the launcher does): each run uses
// a bundle id of its own, `sh.localbox.mac.lab<hex>`, whose launch lock, Sparkle cache and defaults live under this
// account's ~/Library and are removed afterwards. The lab bundles are release-shaped (they carry a feed), so they are
// outside this account's real ~/Applications on purpose: the app then registers no login item. The rest of the scratch
// environment reaches Sparkle's quiet relaunch through each bundle's LSEnvironment (HOME through the patched
// relaunch's allowlist, since LaunchServices will not set HOME).

export const id = "44";
export const tiers = ["a", "v"];

const N = "0.44.0", NEXT = "0.44.1";
const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SANDBOX = "sandbox_p44_alpha", NAME = "alpha-p44", MARKER = "/run/p44-counter";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const plist = (bundle: string) => join(bundle, "Contents/Info.plist");
/** One Info.plist value; "" while Sparkle has the bundle half replaced. */
const info = (bundle: string, key: string) => { try { return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plist(bundle)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const digest = (path: string) => execFileSync("shasum", ["-a", "256", path], { encoding: "utf8" }).split(" ")[0];

export async function run(ctx: ProofContext): Promise<Check[]> {
  const lab = await updateLab(ctx, ctx.tier === "v" ? "apple" : "process-fixture");
  const checks: Check[] = [];
  try {
    checks.push(await ctx.check(`build: N (${N}) and N+1 (${NEXT}) signed with a scratch identity, Sparkle inside; N+1 zipped and the feed signed with a scratch key`, () => lab.prepare()));
    if (ctx.tier === "v") {
      if (screenLocked()) {
        checks.push({ name: "an unlocked session", ok: false, ms: 0, detail: "blocked: the screen is locked with a password, and hibernation needs an unlocked session; unlock and run again" });
        return checks;
      }
      checks.push(...await realVM(ctx, lab));
    } else {
      checks.push(...await fixture(ctx, lab));
    }
    return checks;
  } finally {
    await lab.cleanup(checks);
  }
}

async function fixture(ctx: ProofContext, lab: Lab): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await ctx.check("N runs installed, quietly, as a release that can update itself; agent setup gives it N's home command; nothing newer is up to date", async () => {
    await lab.launch();
    const status = await lab.cli(["app", "status"]);
    assert.equal(status.version, N); assert.equal(status.build, "release");
    assert.deepEqual(status.update && { available: status.update.available, enabled: status.update.enabled }, { available: true, enabled: true }, JSON.stringify(status.update));
    assert.match(lab.log("app.log"), /not in an Applications folder, so no login item yet/, "a lab bundle never touches this account's login items");
    await lab.until(() => lab.commandIs("n"), "N's launcher as the home command");
    const checked = await lab.home(["update", "check", "--json"]);
    assert.equal(checked.code, 0, checked.output);
    const answer = JSON.parse(checked.stdout);
    assert.deepEqual([answer.state, answer.status], ["idle", "You’re up to date."], checked.output);
  }));

  checks.push(await ctx.check("a feed signed by any other key is refused: nothing downloads, N stays", async () => {
    lab.offer(NEXT, "other key");
    const checked = await lab.home(["update", "check", "--json"]);
    const answer = JSON.parse(checked.stdout);
    assert.equal(answer.state, "failed", checked.output);
    assert.match(answer.status, /^Update failed: .*\. Your current version is unchanged\.$/);
    assert.ok(!lab.requests().includes("/update.zip"), "the archive was never fetched");
    assert.equal(info(lab.installed, "CFBundleShortVersionString"), N);
    lab.record("wrong-key", answer);
  }));

  checks.push(await ctx.check("a long-running localbox command holds the install back: the daemon is down, Settings says why, and N stays in place", async () => {
    lab.offer(NEXT);
    const held = lab.holdCommand();
    await lab.until(() => held.started, "the held command");
    const checked = await lab.home(["update", "check", "--json"]);
    assert.equal(checked.code, 0, checked.output);
    await lab.until(async () => (await lab.update()).status === "Waiting for localbox commands to finish.", "the wait for commands", 120_000);
    await sleep(2_000);
    assert.equal((await lab.update()).status, "Waiting for localbox commands to finish.");
    assert.equal(info(lab.installed, "CFBundleShortVersionString"), N, "N is still installed");
    assert.deepEqual(lab.processes().daemons, [], "the daemon stopped before the permit");
    lab.record("held", await lab.update());
    // Killing Sparkle's installer while it waits: the update is abandoned, N's children come back.
    const installers = lab.installers();
    assert.ok(installers.length > 0, "Sparkle's installer is running for this lab's bundle");
    for (const pid of installers) process.kill(pid, "SIGKILL");
    await lab.until(async () => (await lab.update()).state === "failed", "the update to fail", 60_000);
    await lab.until(() => lab.processes().daemons.length === 1, "N's daemon running again");
    held.release();
    await lab.until(() => held.exited, "the held command to end");
    assert.equal(info(lab.installed, "CFBundleShortVersionString"), N);
    execFileSync("codesign", ["--verify", "--deep", "--strict", lab.installed]);
    const help = await lab.home(["help"]);
    assert.equal(help.code, 0, help.output);
    lab.record("after-killed-installer", await lab.update());
  }));

  checks.push(await ctx.check("N to N+1 by itself at the next launch's check: no window, never frontmost, the old app gone inside Sparkle's 20 s, a command refused (75) during the replacement works on retry", async () => {
    await lab.quit();
    lab.forgetLastCheck();
    const result = await lab.watchUpdate(() => lab.launch());
    lab.record("update", result);
    assert.equal(result.windows.length, 0, `windows: ${JSON.stringify(result.windows)}`);
    assert.equal(result.frontmost.length, 0, `frontmost: ${JSON.stringify(result.frontmost)}`);
    assert.ok(result.grantToExitMs < 20_000, `the old app exited ${result.grantToExitMs} ms after the permit`);
    assert.ok(result.refused >= 1, `the launcher refused ${result.refused} calls while the bundle was replaced`);
    assert.equal(result.retry.code, 0, result.retry.output);
    assert.ok(result.retry.attempts.some((code: number) => code === 75), `retries: ${result.retry.attempts.join(", ")}`);
  }));

  checks.push(await ctx.check("N+1 runs from the same place, relaunched quietly into the scratch HOME, with N+1's launcher as the home command", async () => {
    await afterUpdate(lab);
  }));
  return checks;
}

async function realVM(ctx: ProofContext, lab: Lab): Promise<Check[]> {
  const checks: Check[] = [];
  let markerPid = "", counterAtStop = 0;
  const sh = async (command: string): Promise<string> => (await lab.ok("shell.exec", SANDBOX, { command, cwd: "/" })).stdout.trim();
  const counter = async () => {
    const out = await sh(`kill -0 ${markerPid} 2>/dev/null && cat ${MARKER} || echo gone`);
    assert.match(out, /^\d+$/, `marker process ${markerPid}: ${out}`); return Number(out);
  };
  checks.push(await ctx.check("N boots a Linux sandbox with a marker process counting in memory", async () => {
    await installLinuxImage(dirname(dirname(await linuxImage(ctx))), lab.paths.images);
    await lab.launch();
    const created = await lab.ok("sandbox.create", SANDBOX, { name: NAME, image: "linux", cpus: 2, memory_bytes: 2 * 1024 ** 3, sleep_after_ms: 60 * 60_000 });
    assert.deepEqual(created.actions.map((action: any) => action.kind), ["created", "cold_booted"]);
    markerPid = await sh(`nohup sh -c 'i=0; while :; do i=$((i+1)); echo $i > ${MARKER}.tmp && mv ${MARKER}.tmp ${MARKER}; sleep 0.2; done' >/dev/null 2>&1 & echo $!`);
    assert.match(markerPid, /^\d+$/);
  }));
  checks.push(await ctx.check("N to N+1 after localbox update check, automatic rules: the sandbox is put to sleep before the permit, no window, the old app gone inside Sparkle's 20 s", async () => {
    counterAtStop = await counter();
    lab.offer(NEXT);
    const result = await lab.watchUpdate(async () => { await lab.home(["update", "check", "--json"]); });
    lab.record("update", result);
    assert.ok(result.statuses.includes(`Putting 1 sandbox to sleep to install Localbox ${NEXT}…`), JSON.stringify(result.statuses));
    assert.match(result.hostdLog, new RegExp(`hibernated ${NAME}`));
    assert.equal(result.windows.length, 0, `windows: ${JSON.stringify(result.windows)}`);
    assert.equal(result.frontmost.length, 0, `frontmost: ${JSON.stringify(result.frontmost)}`);
    assert.ok(result.grantToExitMs < 20_000, `the old app exited ${result.grantToExitMs} ms after the permit`);
  }));
  checks.push(await ctx.check("N+1 wakes the sandbox N saved, its marker still counting; the home command is N+1's launcher", async () => {
    await afterUpdate(lab);
    let status: any;
    await lab.until(async () => { status = await lab.ok("sandbox.status", SANDBOX); return status.state === "running" || status.lifecycle === "error"; }, `${NAME} running`, 180_000);
    assert.equal(status.last_boot?.kind, "woke", JSON.stringify(status.last_boot));
    const first = await counter(); await sleep(1_200); const second = await counter();
    assert.ok(first >= counterAtStop && second > first, `the counter kept its value and climbs: ${counterAtStop} -> ${first} -> ${second}`);
    await lab.ok("sandbox.delete", SANDBOX, { confirm: NAME });
  }));
  return checks;
}

/** What holds once N+1 has replaced N: the shared tail of both tiers. */
async function afterUpdate(lab: Lab): Promise<void> {
  assert.equal(info(lab.installed, "CFBundleShortVersionString"), NEXT);
  execFileSync("codesign", ["--verify", "--deep", "--strict", lab.installed]);
  const app = lab.processes().app;
  assert.ok(app, "N+1 is running");
  const command = execFileSync("ps", ["-p", String(app), "-wwo", "command="], { encoding: "utf8" });
  assert.match(command, /--localbox-update-relaunch/, "Sparkle's quiet relaunch");
  const environment = execFileSync("ps", ["-p", String(app), "-wwEo", "command="], { encoding: "utf8" });
  assert.ok(environment.includes(`HOME=${lab.home_}`), "the relaunch kept the scratch HOME");
  assert.ok(environment.includes(`LOCALBOX_MACHINE_ROOT=${lab.root}`), "and the scratch machine root");
  await lab.waitForSocket();
  const status = await lab.cli(["app", "status"]);
  assert.equal(status.version, NEXT); assert.equal(status.daemon, "running");
  assert.equal(status.update?.available, true);
  await lab.until(() => lab.commandIs("next"), "the daemon's start-time reconcile to install N+1's launcher as the home command", 60_000);
  assert.match(lab.log("app.log"), new RegExp(`relaunched by an update into ${NEXT.replaceAll(".", "\\.")}`));
  // Every launch runs the built-in image's check; this one is N+1's (it fails at once on the lab's empty release folder).
  await lab.until(() => /localbox-app: .*image-ensure/.test(lab.log("app.log").slice(lab.log("app.log").lastIndexOf("relaunched by an update"))), "N+1's image check", 30_000);
  const help = await lab.home(["help"]);
  assert.equal(help.code, 0, help.output);
}

type Lab = Awaited<ReturnType<typeof updateLab>>;

async function updateLab(ctx: ProofContext, backend: "process-fixture" | "apple") {
  const scratch = realpathSync(mkdtempSync("/tmp/lb44-"));
  const home = join(scratch, "home"), root = join(scratch, "machine"), feed = join(scratch, "feed");
  const installed = join(home, "Applications/Localbox.app");
  const bundleId = `sh.localbox.mac.lab${randomBytes(4).toString("hex")}`;
  const lockRelative = `Library/Caches/${bundleId}/launch.lock`;
  const account = userInfo().homedir;
  const lockPath = join(account, lockRelative);
  const paths = machinePaths({ LOCALBOX_MACHINE_ROOT: root });
  const keys = generateKeyPairSync("ed25519");
  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const built = { n: join(scratch, "n/Localbox.app"), next: join(scratch, "next/Localbox.app") };
  const launchers = { n: join(scratch, "launcher-n"), next: join(scratch, "launcher-next") };
  const evidence: Record<string, unknown> = { bundleId, scratch, backend };
  mkdirSync(join(home, "Applications"), { recursive: true }); mkdirSync(feed, { recursive: true });
  const requests: string[] = [];
  let server: Server | undefined, url = "";
  const owned = new Set<ChildProcess>();
  // The environment every launch of a lab bundle gets: `open --env` for the lab's own launches, LSEnvironment (and
  // the relaunch's HOME) for Sparkle's.
  const env: Record<string, string> = {
    HOME: home, LOCALBOX_MACHINE_ROOT: root, LOCALBOX_APP: installed, LOCALBOX_SANDBOX_BACKEND: backend,
    // Belt and braces: should HOME ever not reach a relaunch, the skill still lands in the scratch HOME.
    LOCALBOX_SKILL_HOME: home,
    LOCALBOX_RELEASE_URL: pathToFileURL(join(scratch, "no-release")).href,
    ...(backend === "process-fixture" ? { LOCALBOX_DEV: "1", LOCALBOX_REPO_ROOT: ctx.root } : {}),
  };
  const launchPath = backend === "process-fixture" ? `${dirname(process.execPath)}:${FINDER_PATH}` : FINDER_PATH;

  const log = (name: string) => { try { return readFileSync(join(paths.logs, name), "utf8"); } catch { return ""; } };
  const tail = (name: string) => `${name}: ${log(name).slice(-1500)}`;
  const until = async (check: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000) => {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(100)) if (await check()) return;
    throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}; ${tail("app.log")}`);
  };
  const plain = (path: string) => path.replaceAll("/private/tmp/", "/tmp/");
  /** This run's processes only: the installed bundle's, Sparkle's for this bundle id. */
  const rows = () => execFileSync("ps", ["-axwwo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((row): row is RegExpMatchArray => !!row && Number(row[1]) !== process.pid);
  const processes = () => {
    const here = plain(installed), mine = rows().filter((row) => plain(row[3]).includes(here));
    const of = (test: (command: string) => boolean) => mine.filter((row) => test(plain(row[3]))).map((row) => ({ pid: Number(row[1]), ppid: Number(row[2]) }));
    return {
      app: of((command) => command.startsWith(join(here, "Contents/MacOS/Localbox ")) || command === join(here, "Contents/MacOS/Localbox"))[0]?.pid,
      daemons: of((command) => command.startsWith(join(here, "Contents/MacOS/localbox-hostd"))),
      connectors: of((command) => command.includes("connector run")),
    };
  };
  /** Sparkle's installer for this lab's bundle id (its arguments name it). */
  const installers = () => rows().filter((row) => /\/Autoupdate\b/.test(row[3]) && row[3].includes(bundleId)).map((row) => Number(row[1]));
  const sparkleProcesses = () => rows().filter((row) => (/\/Autoupdate\b|\/Updater\.app\//.test(row[3]) && row[3].includes(bundleId)) || plain(row[3]).includes(plain(scratch))).map((row) => Number(row[1]));
  const front = (): number | undefined => {
    try {
      const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
      return Number(/pid\s*=\s*(\d+)/.exec(execFileSync("lsappinfo", ["info", "-only", "pid", asn], { encoding: "utf8" }))?.[1]) || undefined;
    } catch { return undefined; }
  };
  const windowTool = join(scratch, "windows");

  const answers = () => new Promise<boolean>((resolve) => {
    const connection = createConnection(paths.socket);
    const done = (up: boolean) => { connection.destroy(); resolve(up); };
    connection.setTimeout(1_000, () => done(false)); connection.once("connect", () => done(true)); connection.once("error", () => done(false));
  });
  const waitForSocket = async (timeoutMs = 90_000) => until(async () => await answers(), "the daemon's socket", timeoutMs);

  /** The bundle's own CLI (no launcher, no lock), in the app's environment; parsed. */
  const cli = async (args: string[]): Promise<any> => {
    const result = await ctx.exec(join(installed, "Contents/Resources/cli/localbox"), [...args, "--json"], { env: { ...env, PATH: FINDER_PATH } });
    try { return JSON.parse(result.stdout); } catch { throw new Error(`localbox ${args.join(" ")} printed no JSON (exit ${result.code}): ${result.stdout}${result.stderr}`); }
  };
  /** The home command, as an agent runs it: through the launcher and its shared lock. */
  const commandEnv = () => ({ ...process.env, ...env, PATH: FINDER_PATH, LOCALBOX_APP: installed });
  const homeCommand = join(home, ".local/bin/localbox");
  const homeRun = async (args: string[], extra: Record<string, string> = {}) => {
    const result = await ctx.exec(homeCommand, args, { env: { ...commandEnv(), ...extra } });
    return { ...result, output: `exit ${result.code}: ${result.stdout}${result.stderr}` };
  };
  /** The signed launchers each bundle carries (signing changes their bytes); set by `prepare`. */
  const signedLaunchers = { n: "", next: "" };
  const commandIs = (which: "n" | "next") => existsSync(homeCommand) && digest(homeCommand) === signedLaunchers[which];
  const update = async (): Promise<any> => await callApp(paths.appSocket, "update.status");
  let calls = 0;
  const ok = async (operation: string, sandboxId: string | null, input: Json = {}): Promise<any> => {
    const requestId = `p44-${Date.now()}-${calls++}`;
    const transport = new LocalIPCTransport({ socketPath: paths.socket, tokenFile: paths.ipcToken, timeoutMs: 300_000 });
    const response = await transport.dispatch({ protocol_version: PROTOCOL_VERSION, request_id: requestId, operation, sandbox_id: sandboxId, deadline_ms: 120_000, mutation_id: requestId, input } as any);
    assert.equal(response.ok, true, `${operation}: ${JSON.stringify(response).slice(0, 1500)}`);
    return (response as any).result;
  };

  /** The feed for `version`, signed with the scratch feed key, or with a key no bundle trusts. */
  const writeFeed = (version: string, signer?: "other key") => {
    const key = signer ? generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString() : privatePem;
    const zip = readFileSync(join(feed, "update.zip"));
    const item = appcast({ version, url: `${url}/update.zip`, length: zip.length, signature: sparkleSignature(zip, key), minimumSystemVersion: "14.0" });
    writeFileSync(join(feed, "appcast.xml"), signAppcast(item, key));
  };

  const prepare = async () => {
    server = createServer((request, response) => {
      requests.push(request.url ?? "");
      const name = request.url === "/appcast.xml" ? "appcast.xml" : request.url === "/update.zip" ? "update.zip" : undefined;
      if (!name || !existsSync(join(feed, name))) { response.writeHead(404); response.end(); return; }
      response.setHeader("Content-Type", name === "appcast.xml" ? "application/xml" : "application/zip");
      response.end(readFileSync(join(feed, name)));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (backend === "apple") await buildRealVMs(ctx);
    else assert.equal((await ctx.exec("npm", ["run", "-s", "build"])).code, 0, "npm run build");
    const framework = process.env.LOCALBOX_SPARKLE_FRAMEWORK || join(ctx.root, "dist/sparkle/Sparkle.framework");
    assert.ok(existsSync(framework), `no Sparkle framework at ${framework}: run npm run sparkle:build`);
    const source = readFileSync(join(ctx.root, "apps/macos/App/launcher/main.c"), "utf8");
    assert.ok(source.includes('#define LOCALBOX_LAUNCH_LOCK_RELATIVE_PATH "Library/Caches/sh.localbox.mac/launch.lock"'));
    for (const [which, version, optimize] of [["n", N, "-O0"], ["next", NEXT, "-Os"]] as const) {
      // Development Swift builds (the process fixture), Sparkle linked, then made release-shaped below.
      const out = await ctx.exec("node", ["apps/macos/App/scripts/build-app.mjs", "--out", join(scratch, `build-${which}`), "--version", version], { env: { LOCALBOX_SPARKLE_FRAMEWORK: framework } });
      assert.equal(out.code, 0, `build-app.mjs: ${out.stderr.slice(-1500)}`);
      mkdirSync(dirname(built[which]), { recursive: true });
      renameSync(out.stdout.trim().split("\n").at(-1)!, built[which]);
      // The launcher with this lab's lock path (the define the production build leaves at its default); N's and
      // N+1's differ in their bytes so the home command's refresh is visible.
      execFileSync("cc", [optimize, "-Wall", "-Werror", `-DLOCALBOX_LAUNCH_LOCK_RELATIVE_PATH="${lockRelative}"`, "-o", launchers[which], join(ctx.root, "apps/macos/App/launcher/main.c")]);
      cpSync(launchers[which], join(built[which], "Contents/Resources/bin/localbox"));
      const set = (key: string, type: string, value: string) => execFileSync("plutil", ["-replace", key, `-${type}`, value, plist(built[which])]);
      set("CFBundleIdentifier", "string", bundleId);
      set("CFBundleName", "string", "Localbox");
      set("SUFeedURL", "string", `${url}/appcast.xml`);
      set("SUPublicEDKey", "string", sparklePublicKey(privatePem));
      for (const key of ["SURequireSignedFeed", "SUVerifyUpdateBeforeExtraction", "SUEnableAutomaticChecks"]) set(key, "bool", "YES");
      for (const key of ["SUAllowsAutomaticUpdates", "SUAutomaticallyUpdate"]) set(key, "bool", "NO");
      set("SUScheduledCheckInterval", "integer", "3600");
      set("SUSignedFeedFailureExpirationInterval", "integer", "0");
      set("LocalboxLaunchLockRelativePath", "string", lockRelative);
      set("NSAppTransportSecurity", "json", JSON.stringify({ NSAllowsLocalNetworking: true }));
      set("LSEnvironment", "json", JSON.stringify(Object.fromEntries(Object.entries(env).filter(([key]) => key !== "HOME"))));
    }
    assert.notEqual(digest(launchers.n), digest(launchers.next));
    const identity = scratchIdentity(join(scratch, "signing"));
    const { signApp, withIdentity } = await import(pathToFileURL(join(ctx.root, "apps/macos/App/scripts/sign.mjs")).href);
    await withIdentity({ p12: identity.p12, passwordFile: identity.passwordFile, sha1: identity.sha1 }, ({ identity: id, keychain }: { identity: string; keychain: string }) => {
      for (const bundle of [built.n, built.next]) signApp(bundle, { identity: id, keychain });
    });
    for (const which of ["n", "next"] as const) signedLaunchers[which] = digest(join(built[which], "Contents/Resources/bin/localbox"));
    assert.notEqual(signedLaunchers.n, signedLaunchers.next);
    execFileSync("ditto", ["-c", "-k", "--keepParent", built.next, join(feed, "update.zip")]);
    writeFeed(N);
    execFileSync("ditto", [built.n, installed]);
    // On-screen windows as `pid layer owner` (no Screen Recording needed for these fields).
    writeFileSync(`${windowTool}.swift`, `import CoreGraphics\nlet list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []\nfor w in list { print("\\(w[kCGWindowOwnerPID as String] as? Int ?? -1)\\t\\(w[kCGWindowLayer as String] as? Int ?? -1)\\t\\(w[kCGWindowOwnerName as String] as? String ?? "")") }\n`);
    execFileSync("swiftc", ["-o", windowTool, `${windowTool}.swift`]);
    evidence.designatedRequirement = [built.n, built.next].map((bundle) => spawnSync("codesign", ["-d", "-r-", bundle], { encoding: "utf8" }).stdout.trim());
    assert.equal(new Set(evidence.designatedRequirement as string[]).size, 1, "N and N+1 share one designated requirement");
  };

  /** `open -g` with the scratch environment, then waits for the daemon's socket. */
  const launch = async () => {
    assert.equal(processes().app, undefined, "the lab app is already running");
    const opened = await ctx.exec("/usr/bin/open", ["-g", "-n", ...Object.entries({ ...env, PATH: launchPath }).flatMap(([key, value]) => ["--env", `${key}=${value}`]), installed]);
    assert.equal(opened.code, 0, `open: ${opened.stderr}`);
    await until(() => !!processes().app, "the app");
    await waitForSocket();
    return processes().app!;
  };
  /** SIGTERM, the Quit item's path; waits for the app to be gone. */
  const quit = async () => {
    const app = processes().app; if (!app) return;
    process.kill(app, "SIGTERM");
    await until(() => !processes().app && !processes().daemons.length, "the app to quit", 300_000);
  };

  /** A real command through the home command, held at its stdin (its whole life holds the launch lock shared). */
  const holdCommand = () => {
    const child = spawn(homeCommand, ["connector", "run"], { env: commandEnv(), stdio: ["pipe", "ignore", "pipe"] });
    owned.add(child);
    const state = { started: false, exited: false, release: () => child.stdin?.end() };
    child.stderr?.on("data", (chunk) => { if (/waiting for localbox login|not signed in/.test(String(chunk))) state.started = true; });
    child.once("exit", () => { state.exited = true; owned.delete(child); });
    return state;
  };

  /**
   * Starts `begin` and watches until N+1 answers: the updater's status lines, any on-screen window or frontmost app
   * from this run, the launcher's refusals while the bundle is replaced, and one real command retried until it works.
   */
  const watchUpdate = async (begin: () => Promise<unknown>) => {
    const statuses: string[] = [], windows: string[] = [], frontmost: number[] = [], apps: number[] = [];
    let refused = 0, oldGoneAt = 0, newApp: number | undefined;
    const retry = { code: -1, attempts: [] as number[], output: "" };
    const offset = log("hostd.log").length, appOffset = log("app.log").length;
    let stop = false;
    const ours = new Set<number>();
    // The updater's status lines as Settings reads them, and when the old app went.
    const status = (async () => {
      while (!stop) {
        const app = processes().app;
        if (app && !apps.includes(app)) apps.push(app);
        if (apps.length && !oldGoneAt && !rows().some((row) => Number(row[1]) === apps[0])) oldGoneAt = Date.now();
        try {
          const now = await callApp(paths.appSocket, "update.status", {}, 1_000) as any;
          if (now.status && statuses.at(-1) !== now.status) statuses.push(now.status);
        } catch { /* the app is between copies */ }
        await sleep(20);
      }
    })();
    // Any on-screen window (layer 0) or frontmost app of this run's processes.
    const screen = (async () => {
      while (!stop) {
        for (const pid of [...apps, ...sparkleProcesses()]) ours.add(pid);
        const shown = execFileSync(windowTool, { encoding: "utf8" }).split("\n").map((line) => line.split("\t"))
          .filter(([pid, layer]) => ours.has(Number(pid)) && layer === "0").map((row) => row.join(" "));
        for (const window of shown) if (!windows.includes(window)) windows.push(window);
        const top = front(); if (top && ours.has(top) && !frontmost.includes(top)) frontmost.push(top);
        await sleep(150);
      }
    })();
    // From the permit until N+1 is relaunched, Sparkle's helper holds the launch lock exclusively. A watcher tries the
    // lock shared every millisecond (held for microseconds, as the launcher holds it for a command's first instant) and
    // says when it cannot; then a real command runs through the home command, as an agent's would, and is retried
    // until it works. Its refusals are the launcher's exit 75.
    const lock = (async () => {
      const watcher = spawn("perl", ["-e", 'use Fcntl ":flock"; $| = 1; open(F, "<", $ARGV[0]) or die "$!"; while (1) { if (flock(F, LOCK_SH | LOCK_NB)) { flock(F, LOCK_UN); select(undef, undef, undef, 0.001); } else { print "held\\n"; exit 0; } }', lockPath], { stdio: ["ignore", "pipe", "inherit"] });
      owned.add(watcher);
      const held = await new Promise<boolean>((resolve) => {
        watcher.stdout.once("data", () => resolve(true));
        const poll = setInterval(() => { if (stop) { clearInterval(poll); watcher.kill(); resolve(false); } }, 50);
        watcher.once("exit", () => clearInterval(poll));
      });
      owned.delete(watcher);
      if (!held) return;
      for (let attempt = 0; attempt < 600 && !stop; attempt++) {
        const result = await launcherOnce(["help"]);
        retry.attempts.push(result.code);
        if (result.code === 75) refused++;
        if (result.code === 0) { retry.code = 0; return; }
        retry.output = result.output;
        await sleep(attempt < 20 ? 10 : 100);
      }
    })();
    try {
      await begin();
      await until(() => { newApp = processes().app; return apps.length > 1 && newApp === apps.at(-1) && info(installed, "CFBundleShortVersionString") === NEXT; }, "N+1 running in N's place", 300_000);
      await waitForSocket();
      await until(() => retry.code === 0, "the retried command", 30_000).catch(() => undefined);
    } finally {
      stop = true; await Promise.all([status, screen, lock]);
    }
    // The permit, as the old app logged it (to the second, so the figure below is at most a second high).
    const appLog = log("app.log").slice(appOffset);
    const granted = new RegExp(`^(\\S+) localbox-app: update installing: Installing Localbox ${NEXT.replaceAll(".", "\\.")}…$`, "m").exec(appLog)?.[1];
    const grantToExitMs = granted && oldGoneAt ? oldGoneAt - Date.parse(granted) : Number.NaN;
    return { statuses, windows, frontmost, refused, retry, apps, newApp, grantToExitMs, updateLog: appLog.split("\n").filter((line) => / update |exiting for the update|relaunched by an update/.test(line)), hostdLog: log("hostd.log").slice(offset), feedRequests: [...requests] };
  };

  /** The home command once, as an agent runs it. */
  const launcherOnce = (args: string[]) => new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(homeCommand, args, { env: commandEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
  });

  /** Everything this run left under the account's ~/Library, by its bundle id. */
  const accountTraces = () => ["Caches", "HTTPStorages", "Preferences", "Saved Application State", "Application Support", "WebKit"]
    .flatMap((folder) => { try { return readdirSync(join(account, "Library", folder)).filter((name) => name.includes(bundleId)).map((name) => join(account, "Library", folder, name)); } catch { return []; } });

  const cleanup = async (checks: Check[]) => {
    for (const child of owned) { try { child.stdin?.end(); child.kill("SIGTERM"); } catch { /* gone */ } }
    const app = processes().app;
    if (app) { try { process.kill(app, "SIGTERM"); } catch { /* gone */ } await until(() => !processes().app, "the app to quit", 300_000).catch(() => undefined); }
    const left = processes();
    for (const pid of [left.app, ...left.daemons.map((row) => row.pid), ...left.connectors.map((row) => row.pid), ...sparkleProcesses()]) if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    // A real VM's service process belongs to launchd, not the daemon; it is this run's when it holds a file under this root.
    for (const row of rows().filter((row) => row[3].includes("Virtualization.VirtualMachine"))) {
      const pid = Number(row[1]);
      try { if (execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8" }).includes(root)) process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    server?.close();
    spawnSync("defaults", ["delete", bundleId]);
    const traces = accountTraces();
    for (const path of traces) rmSync(path, { recursive: true, force: true });
    evidence.accountTracesRemoved = traces;
    mkdirSync(ctx.evidence, { recursive: true });
    writeFileSync(join(ctx.evidence, `44-${ctx.tier}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    const remaining = accountTraces();
    checks.push({ name: "cleanup: nothing of this run is left running or under this account's ~/Library", ok: remaining.length === 0 && !processes().app && sparkleProcesses().length === 0, ms: 0, detail: remaining.length ? `left: ${remaining.join(", ")}` : undefined });
    if (!ctx.keep) rmSync(scratch, { recursive: true, force: true });
  };

  return {
    prepare, launch, quit, cli, ok, update, until, log, processes, installers, holdCommand, watchUpdate, waitForSocket, cleanup, commandIs,
    home: homeRun, installed, root, paths, home_: home,
    offer: (version: string, signer?: "other key") => writeFeed(version, signer),
    requests: () => [...requests],
    forgetLastCheck: () => { spawnSync("defaults", ["delete", bundleId, "SULastCheckTime"]); },
    record: (name: string, value: unknown) => { evidence[name] = value; },
  };
}
