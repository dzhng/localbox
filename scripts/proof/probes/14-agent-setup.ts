import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { asMachine } from "../lib/as-machine.js";
import { fixtureHome, machineRoot, stopConnector } from "../lib/login.js";
import { mcp, registerClient, signInAgent } from "../lib/mcp.js";
import { packagedApp } from "../lib/packaged-app.js";
import { signedInWithSandboxes } from "../lib/sandboxes.js";

// Agent setup: the skill, the `localbox` command and its PATH block follow the app. Tier a installs the assembled
// development app into a scratch HOME's Applications folder and drives it as a user's Mac would: its first launch
// installs everything, a relaunch leaves it alone, a newer bundle replaces the skill, and setup off or a skill
// uninstall are honoured. Tier l checks that MCP answers exactly what the CLI answers.
//
//   npm run proof -- 14 --tier u,a,l

export const id = "14";
export const tiers = ["u", "a", "l"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FIRST = "0.14.1", SECOND = "0.14.2";
const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function capture(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => done({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

/** Every agent harness path the pinned installer linked the skill into, under `home`. */
function harnessPaths(home: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[] = []; try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      if (name === "localbox" && dir.endsWith("/skills")) { found.push(path); continue; }
      if (depth < 4 && !["Library", "Applications", "node_modules", ".localbox"].includes(name) && lstatSync(path).isDirectory()) walk(path, depth + 1);
    }
  };
  walk(home, 0);
  return found;
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
  return ctx.tier === "a" ? await installedApp(ctx) : await mcpParity(ctx);
}

async function installedApp(ctx: ProofContext): Promise<Check[]> {
  const app = packagedApp(ctx, { probe: "14", backend: "process-fixture" });
  const applications = join(app.home, "Applications"), command = join(app.home, ".local/bin/localbox");
  const checks: Check[] = [];
  const evidence = (name: string, value: unknown) => writeFileSync(join(ctx.evidence, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  /** `localbox …` through the home command, as an agent runs it; the launcher finds the dev bundle through LOCALBOX_APP. */
  const home = async (args: string[], json = true): Promise<any> => {
    const result = await capture(command, json ? [...args, "--json"] : args, { ...app.env, PATH: FINDER_PATH, LOCALBOX_APP: app.bundle });
    if (!json) return result;
    try { return JSON.parse(result.stdout); } catch { throw new Error(`localbox ${args.join(" ")} printed no JSON (exit ${result.code}): ${result.stdout}${result.stderr}`); }
  };
  /** The daemon-start reconcile the daemon logged after `offset` bytes of its log, parsed. */
  const reconciled = async (offset: number): Promise<any> => {
    const marker = "agent setup (daemon_start): ";
    let line: string | undefined;
    await app.until(() => (line = app.log("hostd.log").slice(offset).split("\n").find((entry) => entry.includes(marker))) !== undefined, "the daemon's start reconcile");
    const text = line!.slice(line!.indexOf(marker) + marker.length);
    try { return JSON.parse(text); } catch { throw new Error(`the daemon's reconcile did not report JSON: ${text}`); }
  };
  /** Quits the app (it waits for its daemon), runs `between`, launches it again and returns that launch's reconcile. */
  const relaunch = async (between: () => Promise<void> = async () => {}) => {
    await app.stop(() => undefined);
    await between();
    const offset = app.log("hostd.log").length;
    await app.start();
    return await reconciled(offset);
  };
  try {
    checks.push(await ctx.check(`first launch of ${FIRST} from ~/Applications: the skill (a hand copy backed up), the home command and its PATH block`, async () => {
      assert.equal((await ctx.exec("npm", ["run", "-s", "build"])).code, 0, "npm run build");
      mkdirSync(applications);
      await app.build({ into: applications, version: FIRST });
      const handCopy = join(app.home, ".agents/skills/localbox");
      mkdirSync(handCopy, { recursive: true }); writeFileSync(join(handCopy, "SKILL.md"), "---\nname: localbox\ndescription: hand copy\n---\nhand copy\n");
      await app.start();
      const report = await reconciled(0); evidence("first-launch", report);
      assert.deepEqual(report.actions.map((action: any) => `${action.subject}:${action.kind}`), ["skill:replaced", "command:installed"]);
      assert.match(readFileSync(join(report.actions[0].backup, ".agents/skills/localbox/SKILL.md"), "utf8"), /hand copy/);
      const skill = (await home(["skill", "status"])).result; evidence("skill-status", skill);
      assert.deepEqual({ state: skill.state, managed: skill.managed, source_revision: skill.source_revision, release: skill.release }, { state: "installed", managed: true, source_revision: FIRST, release: FIRST });
      const paths = harnessPaths(app.home); evidence("harness-paths", paths);
      assert.ok(paths.length > 2 && paths.includes(join(app.home, ".agents/skills/localbox")) && paths.includes(join(app.home, ".claude/skills/localbox")), `harness paths: ${paths.join(", ")}`);
      for (const path of paths) assert.equal(readFileSync(join(path, "SKILL.md"), "utf8"), readFileSync(join(ctx.root, "skills/localbox/SKILL.md"), "utf8"), path);
      const cli = (await home(["cli", "status"])).result; evidence("cli-status", cli);
      assert.deepEqual({ state: cli.state, on_path: cli.on_path, profile: cli.profile, managed: cli.managed }, { state: "installed", on_path: true, profile: join(app.home, ".zprofile"), managed: true });
      assert.ok(readFileSync(command).equals(readFileSync(join(app.bundle, "Contents/Resources/bin/localbox"))), "the command is the launcher's bytes");
      const help = await home(["help"], false);
      assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /^localbox <command> \[options\]/);
    }));
    checks.push(await ctx.check("a relaunch's reconcile leaves a skill and command that match the app alone", async () => {
      const report = await relaunch(); evidence("relaunch", report);
      assert.deepEqual(report.actions.map((action: any) => action.kind), ["left_alone", "left_alone"]);
    }));
    checks.push(await ctx.check(`${SECOND}'s bundle in place of ${FIRST}'s: its first launch replaces the skill and keeps the command`, async () => {
      const report = await relaunch(async () => { await app.build({ into: applications, version: SECOND }); }); evidence("after-update", report);
      assert.equal(report.actions[0].kind, "replaced"); assert.match(report.actions[0].detail, new RegExp(`release ${FIRST}'s skill with release ${SECOND}'s`));
      assert.equal(report.actions[1].kind, "left_alone");
      const status = (await home(["skill", "status"])).result;
      assert.deepEqual({ state: status.state, source_revision: status.source_revision, release: status.release }, { state: "installed", source_revision: SECOND, release: SECOND });
    }));
    checks.push(await ctx.check("agent setup off removes the PATH block; an edited skill then survives a relaunch and reads unmanaged", async () => {
      const off = (await home(["agents", "setup", "off"])).result; evidence("setup-off", off);
      assert.equal(off.actions[0].kind, "turned_off"); assert.match(off.actions[0].detail, /removed its PATH block/);
      assert.ok(!readFileSync(join(app.home, ".zprofile"), "utf8").includes(".local/bin"));
      const skill = join(app.home, ".agents/skills/localbox/SKILL.md"), edited = `${readFileSync(skill, "utf8")}\nA local note.\n`;
      writeFileSync(skill, edited);
      const report = await relaunch(); evidence("relaunch-setup-off", report);
      assert.deepEqual(report.actions.map((action: any) => action.kind), ["left_alone", "left_alone"]); assert.match(report.actions[0].detail, /agent setup is off/);
      assert.equal(readFileSync(skill, "utf8"), edited);
      const status = (await home(["skill", "status"])).result;
      assert.equal(status.state, "unmanaged"); assert.equal(status.managed, false);
    }));
    checks.push(await ctx.check("skill.uninstall with setup on: the next launch reinstalls it, and both results say so", async () => {
      await home(["agents", "setup", "on"]);
      const removed = (await home(["skill", "uninstall"])).result; evidence("uninstall", removed);
      assert.equal(removed.actions[0].kind, "uninstalled"); assert.match(removed.actions[0].detail, /next reconcile .* installs it again/);
      assert.equal(removed.produced.state, "disabled"); assert.deepEqual(harnessPaths(app.home), []);
      const report = await relaunch(); evidence("relaunch-after-uninstall", report);
      assert.equal(report.actions[0].kind, "reinstalled"); assert.match(report.actions[0].detail, /after skill\.uninstall removed it/);
      assert.equal((await home(["skill", "status"])).result.state, "installed");
    }));
    if (app.processes().app) await app.stop(() => undefined);
    return checks;
  } finally { await app.cleanup(); }
}

async function mcpParity(ctx: ProofContext): Promise<Check[]> {
  let connector: ChildProcess | undefined; let stackUp = false;
  const evidence = (name: string, value: unknown) => writeFileSync(join(ctx.evidence, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  try {
    const up = await ctx.stack("up", ["a"]); stackUp = true;
    if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
    return [await ctx.check("the agent setup operations through MCP tools/call return what the CLI returns", async () => {
      const root = machineRoot(ctx.root, "a"), home = fixtureHome(root);
      const log = join(root, "logs/hostd.log");
      for (const deadline = Date.now() + 60_000; !readFileSync(log, "utf8").includes("agent setup (daemon_start): ") && Date.now() < deadline;) await sleep(250);
      const email = `proof-14-${Date.now()}@example.com`;
      connector = (await signedInWithSandboxes(ctx.root, ["a"], email, { create: false })).connectors.a;
      const { metadata, clientId } = await registerClient("Proof Agent 14");
      const token = (await signInAgent(ctx.root, metadata, clientId, email)).access_token;
      const tools = (await mcp(token, "tools/list")).body.result.tools;
      assert.ok(tools.find((tool: any) => tool.name === "skill.status").inputSchema.properties.machine, "every tool takes the machine selector");
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
    })];
  } finally {
    stopConnector(connector);
    if (stackUp && !ctx.keep) await ctx.stack("down");
  }
}
