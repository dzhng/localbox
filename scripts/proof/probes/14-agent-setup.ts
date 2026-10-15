import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { makeManifest, signManifest, writeRelease } from "../../release.js";
import { asMachine } from "../lib/as-machine.js";
import { fixtureHome, machineRoot, stopConnector } from "../lib/login.js";
import { mcp, registerClient, signInAgent } from "../lib/mcp.js";
import { signedInWithSandboxes } from "../lib/sandboxes.js";

export const id = "14";
export const tiers = ["u", "l"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FIRST = "0.14.1", SECOND = "0.14.2";
/** The environment of a Mac whose HOME is `home`: this shell's, minus every LOCALBOX_ override. */
const macEnv = (home: string): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LOCALBOX_"))), HOME: home });

function capture(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

/** One fake Mac: its own HOME, under which install-release.sh puts the install root, the skill and the CLI link. */
class Mac {
  daemon?: ChildProcess;
  constructor(readonly home: string, private readonly ctx: ProofContext) { mkdirSync(home, { recursive: true }); }
  get log(): string { return join(this.home, "hostd.log"); }
  /** The kit is signed with the run's key; `ALLOW_UNSIGNED` only skips codesign, which the fixture app does not have. */
  install(release: string, env: NodeJS.ProcessEnv = {}) {
    return capture("sh", [join(this.ctx.root, "scripts/install-release.sh"), release], { ...macEnv(this.home), RELEASE_PUBLIC_KEY: join(release, "..", "release-public.pem"), ALLOW_UNSIGNED: "1", LOCALBOX_SKIP_LAUNCHD: "1", ...env });
  }
  /** `localbox …` through the installed link; `--json` output parsed. */
  async cli(args: string[]): Promise<any> {
    const result = await capture(join(this.home, ".local/bin/localbox"), [...args, "--json"], macEnv(this.home));
    try { return JSON.parse(result.stdout); } catch { throw new Error(`localbox ${args.join(" ")} printed no JSON: ${result.stdout}${result.stderr}`); }
  }
  /** Starts the installed daemon exactly as its launchd plist would, with the process fixture for sandboxes. */
  startDaemon(): void {
    const plist = join(this.home, "Library/LaunchAgents/com.localbox.hostd.plist");
    const read = (key: string) => JSON.parse(execFileSync("plutil", ["-extract", key, "json", "-o", "-", plist], { encoding: "utf8" }));
    writeFileSync(this.log, "");
    const fd = openSync(this.log, "a");
    this.daemon = spawn(read("ProgramArguments")[0], [], { env: { ...macEnv(this.home), ...read("EnvironmentVariables"), LOCALBOX_VM_BACKEND: "process-fixture", LOCALBOX_REPO_ROOT: this.ctx.root }, detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
  }
  async stopDaemon(): Promise<void> {
    const child = this.daemon; this.daemon = undefined;
    if (!child?.pid || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try { process.kill(child.pid, "SIGTERM"); } catch { return; }
    if (await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)])) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  async restartDaemon(): Promise<any> { await this.stopDaemon(); this.startDaemon(); return await reconciled(this.log); }
}

/** The daemon-start reconcile the daemon logged, parsed. */
async function reconciled(log: string, timeoutMs = 60_000): Promise<any> {
  const marker = "agent setup (daemon_start): ";
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(250)) {
    const line = readFileSync(log, "utf8").split("\n").find((entry) => entry.includes(marker));
    if (line) { const text = line.slice(line.indexOf(marker) + marker.length); try { return JSON.parse(text); } catch { throw new Error(`the daemon's reconcile did not report JSON: ${text}`); } }
  }
  throw new Error(`no daemon-start reconcile in ${log} after ${timeoutMs / 1000} s: ${readFileSync(log, "utf8").slice(-1000)}`);
}

/** Every agent harness path the pinned installer linked the skill into, under `home`. */
function harnessPaths(home: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[] = []; try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      if (name === "localbox" && dir.endsWith("/skills")) { found.push(path); continue; }
      if (depth < 4 && !["Library", "node_modules", ".localbox"].includes(name) && lstatSync(path).isDirectory()) walk(path, depth + 1);
    }
  };
  walk(home, 0);
  return found;
}

/** A release kit for `version`, laid out and signed as scripts/release.sh does it, from this checkout's build and Node. */
async function releaseKit(ctx: ProofContext, work: string, hostd: string, version: string, key: KeyObject): Promise<string> {
  const stage = join(work, `stage-${version}`), out = join(work, `release-${version}`), cli = join(stage, "localbox-cli");
  for (const dir of [join(cli, "bin"), join(cli, "scripts"), join(cli, "dist"), out]) mkdirSync(dir, { recursive: true });
  for (const part of ["apps", "packages", "scripts"]) cpSync(join(ctx.root, "dist", part), join(cli, "dist", part), { recursive: true });
  for (const script of ["install-release.sh", "rollback-release.sh", "localbox-path.sh"]) copyFileSync(join(ctx.root, "scripts", script), join(cli, "scripts", script));
  cpSync(join(ctx.root, "skills/localbox"), join(cli, "skill"), { recursive: true });
  cpSync(join(ctx.root, "node_modules/skills"), join(cli, "skills-installer"), { recursive: true, filter: (source) => !/\/skills\/(node_modules|\.cache)(\/|$)/.test(source) });
  copyFileSync(join(ctx.root, "package.json"), join(cli, "package.json"));
  copyFileSync(join(ctx.root, "scripts/cli-launcher.sh"), join(cli, "bin/localbox")); chmodSync(join(cli, "bin/localbox"), 0o755);
  writeFileSync(join(cli, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  // The compiled CLI's runtime dependencies (release.sh installs them with npm).
  symlinkSync(join(ctx.root, "node_modules"), join(cli, "node_modules"));
  const app = join(stage, "Localbox.app/Contents");
  mkdirSync(join(app, "MacOS"), { recursive: true }); mkdirSync(join(app, "Resources/vm"), { recursive: true });
  copyFileSync(hostd, join(app, "MacOS/localbox-hostd")); chmodSync(join(app, "MacOS/localbox-hostd"), 0o755);
  for (const plist of ["com.localbox.hostd.plist", "com.localbox.updater.plist", "com.localbox.connector.plist"]) copyFileSync(join(ctx.root, "apps/macos/HostDaemon/Resources", plist), join(app, "Resources", plist));
  for (const file of ["vmlinuz", "initrd", "template.img"]) writeFileSync(join(app, "Resources/vm", file), "");
  execFileSync("ditto", ["-c", "-k", "--keepParent", join(stage, "Localbox.app"), join(out, `Localbox-${version}.zip`)]);
  execFileSync("tar", ["-czf", join(out, `localbox-cli-${version}.tar.gz`), "-C", stage, "localbox-cli"]);
  await writeRelease(out, signManifest(await makeManifest(out, version, `sha256:${"0".repeat(64)}`), key, "proof-14"));
  return out;
}

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    const home = mkdtempSync("/tmp/lb14-u-");
    try {
      return [await ctx.check("skill manager, agent setup, skill commands, MCP tools and relay parity unit tests (fake HOME)", async () => {
        const result = await ctx.exec("npx", ["tsx", "--test", "tests/skill-manager.test.ts", "tests/agent-setup.test.ts", "tests/skill-commands.test.ts", "tests/oauth-mcp.test.ts", "tests/catalog-relay-parity.test.ts"], { env: { HOME: home } });
        assert.equal(result.code, 0, result.stdout.slice(-2000));
      })];
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  const checks: Check[] = [];
  const evidence = (name: string, value: unknown) => writeFileSync(join(ctx.evidence, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  // Short paths: a daemon's socket lives under its fake HOME, and socket paths are limited to 104 bytes.
  const work = mkdtempSync("/tmp/lb14-");
  const fresh = new Mac(join(work, "m1/home"), ctx), copied = new Mac(join(work, "m2/home"), ctx);
  let connector: ChildProcess | undefined; let stackUp = false;
  try {
    const built = await ctx.exec("npm", ["run", "build"]);
    if (built.code !== 0) throw new Error(`npm run build failed: ${built.stdout.slice(-1000)}`);
    await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--product", "localbox-hostd"]);
    const hostd = join((await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim(), "localbox-hostd");
    const keys = generateKeyPairSync("ed25519");
    writeFileSync(join(work, "release-public.pem"), keys.publicKey.export({ type: "spki", format: "pem" }));
    const first = await releaseKit(ctx, work, hostd, FIRST, keys.privateKey), second = await releaseKit(ctx, work, hostd, SECOND, keys.privateKey);

    checks.push(await ctx.check(`fresh install of ${FIRST}: skill installed and managed from that release, at every harness path; the CLI is linked`, async () => {
      const installed = await fresh.install(first);
      assert.equal(installed.code, 0, installed.stderr); assert.match(installed.stdout, /\nSkill: installed\n?$/);
      const status = (await fresh.cli(["skill", "status"])).result; evidence("fresh-skill-status", status);
      assert.deepEqual({ state: status.state, managed: status.managed, source_revision: status.source_revision, release: status.release }, { state: "installed", managed: true, source_revision: FIRST, release: FIRST });
      assert.ok(existsSync(status.receipt), "the ownership receipt exists");
      const paths = harnessPaths(fresh.home); evidence("fresh-harness-paths", paths);
      assert.ok(paths.length > 2 && paths.includes(join(fresh.home, ".agents/skills/localbox")) && paths.includes(join(fresh.home, ".claude/skills/localbox")), `harness paths: ${paths.join(", ")}`);
      for (const path of paths) assert.equal(readFileSync(join(path, "SKILL.md"), "utf8"), readFileSync(join(ctx.root, "skills/localbox/SKILL.md"), "utf8"), path);
      const link = (await fresh.cli(["cli", "status"])).result;
      assert.equal(link.state, "linked"); assert.match(link.target, /releases\/active\/localbox-cli\/bin\/localbox$/);
    }));
    checks.push(await ctx.check("a hand-copied skill is backed up and replaced while setup is on", async () => {
      const handCopy = join(copied.home, ".agents/skills/localbox");
      mkdirSync(handCopy, { recursive: true }); writeFileSync(join(handCopy, "SKILL.md"), "---\nname: localbox\ndescription: hand copy\n---\nhand copy\n");
      const installed = await copied.install(first);
      assert.equal(installed.code, 0, installed.stderr); assert.match(installed.stdout, /Skill: installed/);
      const status = (await copied.cli(["skill", "status"])).result;
      assert.equal(status.state, "installed"); assert.equal(status.source_revision, FIRST);
      assert.equal(readFileSync(join(handCopy, "SKILL.md"), "utf8"), readFileSync(join(ctx.root, "skills/localbox/SKILL.md"), "utf8"));
      const backups = readdirSync(join(copied.home, ".localbox")).map((name) => join(copied.home, ".localbox", name, "backup/.agents/skills/localbox/SKILL.md")).filter(existsSync);
      evidence("hand-copy-backups", backups);
      assert.equal(backups.length, 1); assert.match(readFileSync(backups[0], "utf8"), /hand copy/);
    }));
    checks.push(await ctx.check("the daemon's start reconcile leaves a skill and link that match the release alone", async () => {
      fresh.startDaemon();
      const report = await reconciled(fresh.log); evidence("daemon-start-matching", report);
      assert.deepEqual(report.actions.map((action: any) => action.kind), ["left_alone", "left_alone"]);
    }));
    checks.push(await ctx.check(`simulated update to ${SECOND}: after the daemon restarts, source_revision changes with no other action`, async () => {
      const updated = await fresh.install(second, { LOCALBOX_SKIP_AGENT_SETUP: "1" });
      assert.equal(updated.code, 0, updated.stderr); assert.match(updated.stdout, /Skill: skipped/);
      assert.equal((await fresh.cli(["skill", "status"])).result.source_revision, FIRST, "nothing but the daemon touches it");
      const report = await fresh.restartDaemon(); evidence("daemon-start-after-update", report);
      assert.equal(report.actions[0].kind, "replaced"); assert.match(report.actions[0].detail, new RegExp(`release ${FIRST}'s skill with release ${SECOND}'s`));
      const status = (await fresh.cli(["skill", "status"])).result;
      assert.deepEqual({ state: status.state, source_revision: status.source_revision, release: status.release }, { state: "installed", source_revision: SECOND, release: SECOND });
    }));
    checks.push(await ctx.check("agent setup off, then edit the skill: a daemon restart leaves it untouched and skill.status reports unmanaged", async () => {
      const off = (await fresh.cli(["agents", "setup", "off"])).result; evidence("setup-off", off);
      assert.equal(off.actions[0].kind, "turned_off");
      const skill = join(fresh.home, ".agents/skills/localbox/SKILL.md"), edited = `${readFileSync(skill, "utf8")}\nA local note.\n`;
      writeFileSync(skill, edited);
      const report = await fresh.restartDaemon(); evidence("daemon-start-setup-off", report);
      assert.deepEqual(report.actions.map((action: any) => action.kind), ["left_alone", "left_alone"]); assert.match(report.actions[0].detail, /agent setup is off/);
      assert.equal(readFileSync(skill, "utf8"), edited);
      const status = (await fresh.cli(["skill", "status"])).result;
      assert.equal(status.state, "unmanaged"); assert.equal(status.managed, false);
    }));
    checks.push(await ctx.check("skill.uninstall with setup on: the next reconcile reinstalls it, and both results say so", async () => {
      await fresh.cli(["agents", "setup", "on"]);
      const removed = (await fresh.cli(["skill", "uninstall"])).result; evidence("uninstall", removed);
      assert.equal(removed.actions[0].kind, "uninstalled"); assert.match(removed.actions[0].detail, /next reconcile .* installs it again/);
      assert.equal(removed.produced.state, "disabled"); assert.deepEqual(harnessPaths(fresh.home), []);
      const report = await fresh.restartDaemon(); evidence("daemon-start-after-uninstall", report);
      assert.equal(report.actions[0].kind, "reinstalled"); assert.match(report.actions[0].detail, /after skill\.uninstall removed it/);
      assert.equal((await fresh.cli(["skill", "status"])).result.state, "installed");
    }));
    await fresh.stopDaemon();

    const up = await ctx.stack("up", ["a"]); stackUp = true;
    if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
    checks.push(await ctx.check("the same operations through MCP tools/call return what the CLI returns", async () => {
      const root = machineRoot(ctx.root, "a"), home = fixtureHome(root);
      await reconciled(join(root, "logs/hostd.log"));
      const email = `proof-14-${Date.now()}@example.com`;
      connector = (await signedInWithSandboxes(ctx.root, ["a"], email, { create: false })).connectors.a;
      const { metadata, clientId } = await registerClient("Proof Agent 14");
      const token = (await signInAgent(ctx.root, metadata, clientId, email)).access_token;
      const tools = (await mcp(token, "tools/list")).body.result.tools;
      assert.ok(tools.find((tool: any) => tool.name === "skill.status").inputSchema.properties.machine, "machine-level tools take a machine");
      const viaCli = async (args: string[]) => {
        const result = await asMachine("a", [...args, "--json"], { cwd: ctx.root, env: { HOME: home } });
        const envelope = JSON.parse(result.stdout); assert.equal(envelope.ok, true, result.stdout); return envelope.result;
      };
      const viaMcp = async (name: string, args: Record<string, unknown> = {}) => {
        const called = await mcp(token, "tools/call", { name, arguments: args });
        assert.equal(called.status, 200); assert.notEqual(called.body.result.isError, true, JSON.stringify(called.body)); return called.body.result.structuredContent;
      };
      const pairs: Array<[string, unknown, unknown]> = [];
      for (const [args, tool] of [[["skill", "status"], "skill.status"], [["cli", "status"], "cli.status"], [["agents", "setup", "status"], "agents.setup.status"]] as const) pairs.push([tool, await viaCli([...args]), await viaMcp(tool)]);
      // Each change once through the CLI and once through MCP, from the same starting state.
      const off = await viaCli(["agents", "setup", "off"]), on = await viaCli(["agents", "setup", "on"]);
      pairs.push(["agents.setup.set off", off, await viaMcp("agents.setup.set", { enabled: false })], ["agents.setup.set on", on, await viaMcp("agents.setup.set", { enabled: true })]);
      const uninstalled = await viaCli(["skill", "uninstall"]), installed = await viaCli(["skill", "install"]);
      pairs.push(["skill.uninstall", uninstalled, await viaMcp("skill.uninstall")], ["skill.install", installed, await viaMcp("skill.install")]);
      evidence("mcp-parity", pairs.map(([name, cli, viaTool]) => ({ name, cli, mcp: viaTool })));
      for (const [name, cli, viaTool] of pairs) assert.deepEqual(viaTool, cli, name);
      assert.equal((installed as any).actions[0].kind, "reinstalled");
    }));
    return checks;
  } finally {
    stopConnector(connector);
    await fresh.stopDaemon(); await copied.stopDaemon();
    if (stackUp && !ctx.keep) await ctx.stack("down");
    if (!ctx.keep) rmSync(work, { recursive: true, force: true });
  }
}
