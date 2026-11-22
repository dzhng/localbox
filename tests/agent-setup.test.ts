import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentSetup, type Release } from "../apps/cli/src/agent-setup.js";
import { PATH_BLOCK } from "../apps/cli/src/shell-profile.js";
import { SkillManager } from "../apps/cli/src/skill-manager.js";
import { ContractError, type ActionReport } from "../packages/contract/src/index.js";

const installer = join(process.cwd(), "node_modules/skills/bin/cli.mjs");
const LAUNCHER = "#!/bin/sh\n# sh.localbox.launcher, build 1\n";

/** A Mac with its own HOME and machine root, and an installed release `revision` whose CLI the link should reach. */
async function mac(): Promise<{ home: string; root: string; at(revision: string): AgentSetup }> {
  const base = await mkdtemp(join(tmpdir(), "localbox-agent-setup-"));
  const home = join(base, "home"), root = join(base, "machine");
  const cli = join(base, "releases/active/localbox-cli/bin/localbox");
  await mkdir(join(base, "releases/active/localbox-cli/bin"), { recursive: true }); await writeFile(cli, "#!/bin/sh\n");
  const at = (revision: string) => {
    const release: Release = { revision, cli, app: null, launcher: null };
    return new AgentSetup({ env: { HOME: home, LOCALBOX_MACHINE_ROOT: root }, release, skills: new SkillManager({ home, revision, installerPath: installer }) });
  };
  return { home, root, at };
}

/** A Mac with Localbox.app in `folder` (under its HOME unless absolute) whose bundled launcher is `LAUNCHER`. */
async function appMac(folder = "Applications"): Promise<{ home: string; app: string; launcher: string; command: string; at(revision?: string, shell?: string): AgentSetup }> {
  const base = await mkdtemp(join(tmpdir(), "localbox-agent-setup-app-"));
  const home = join(base, "home"), app = join(home, folder, "Localbox.app"), launcher = join(app, "Contents/Resources/bin/localbox");
  await mkdir(dirname(launcher), { recursive: true }); await writeFile(launcher, LAUNCHER, { mode: 0o755 });
  const at = (revision = "0.1.0", shell = "/bin/zsh") => new AgentSetup({
    env: { HOME: home, LOCALBOX_MACHINE_ROOT: join(base, "machine") }, shell,
    release: { revision, cli: null, app, launcher }, skills: new SkillManager({ home, revision, installerPath: installer }),
  });
  return { home, app, launcher, command: join(home, ".local/bin/localbox"), at };
}
const kinds = (report: ActionReport) => report.actions.map((action) => `${action.subject ?? "setting"}:${action.kind}`);
const produced = (report: ActionReport) => report.produced as { state: string; managed: boolean; source_revision: string | null; command: { state: string } };
const cliStatus = async (setup: AgentSetup) => await setup.handle("cli.status", {}) as Record<string, unknown>;

test("a fresh install installs the skill and links the CLI; the next daemon start leaves both alone", async () => {
  const { home, at } = await mac();
  const installed = await at("0.1.0").reconcile("install");
  assert.deepEqual(kinds(installed), ["skill:installed", "command:linked"]);
  assert.deepEqual({ ...produced(installed), command: produced(installed).command.state }, { state: "installed", managed: true, source_revision: "0.1.0", receipt: join(home, ".config/localbox/skill-install.json"), command: "linked" });
  assert.match(await readlink(join(home, ".local/bin/localbox")), /releases\/active\/localbox-cli\/bin\/localbox$/);
  const again = await at("0.1.0").reconcile("daemon_start");
  assert.deepEqual(kinds(again), ["skill:left_alone", "command:left_alone"]);
  assert.match(again.actions[0].detail!, /already release 0\.1\.0's skill/);
});

test("a hand-copied skill is backed up and replaced while setup is on; a newer release replaces Localbox's own copy", async () => {
  const { home, at } = await mac();
  await mkdir(join(home, ".agents/skills/localbox"), { recursive: true }); await writeFile(join(home, ".agents/skills/localbox/SKILL.md"), "hand copy\n");
  const replaced = await at("0.1.0").reconcile("install");
  assert.deepEqual(kinds(replaced), ["skill:replaced", "command:linked"]);
  assert.equal(await readFile(join(String(replaced.actions[0].backup), ".agents/skills/localbox/SKILL.md"), "utf8"), "hand copy\n");
  const updated = await at("0.2.0").reconcile("daemon_start");
  assert.deepEqual(kinds(updated), ["skill:replaced", "command:left_alone"]);
  assert.equal(updated.actions[0].backup, undefined); assert.match(updated.actions[0].detail!, /release 0\.1\.0's skill with release 0\.2\.0's/);
  assert.equal(produced(updated).source_revision, "0.2.0");
});

test("with setup off nothing is touched, the skill reads unmanaged, and an explicit install still acts", async () => {
  const { home, root, at } = await mac();
  await at("0.1.0").reconcile("install");
  const off = await at("0.1.0").set(false);
  assert.deepEqual(kinds(off), ["setting:turned_off"]);
  assert.equal(JSON.parse(await readFile(join(root, "agent-setup.json"), "utf8")).enabled, false);
  await writeFile(join(home, ".agents/skills/localbox/SKILL.md"), "customised\n");
  const skipped = await at("0.2.0").reconcile("daemon_start");
  assert.deepEqual(kinds(skipped), ["skill:left_alone", "command:left_alone"]); assert.match(skipped.actions[0].detail!, /agent setup is off/);
  assert.equal(await readFile(join(home, ".agents/skills/localbox/SKILL.md"), "utf8"), "customised\n");
  const status = await at("0.2.0").skillStatus();
  assert.equal(status.state, "unmanaged"); assert.equal(status.managed, false); assert.equal(status.agent_setup, false);
  assert.deepEqual(kinds(await at("0.2.0").set(false)), ["setting:left_alone"]);
  const explicit = await at("0.2.0").reconcile("explicit");
  assert.equal(explicit.actions[0].kind, "replaced"); assert.equal(produced(explicit).source_revision, "0.2.0");
  assert.equal(await readFile(join(String(explicit.actions[0].backup), ".agents/skills/localbox/SKILL.md"), "utf8"), "customised\n", "the customised copy is backed up");
});

test("skill.uninstall with setup on says the next reconcile reinstalls it, and that reconcile says so too", async () => {
  const { at } = await mac();
  await at("0.1.0").reconcile("install");
  const removed = await at("0.1.0").handle("skill.uninstall", {}) as unknown as ActionReport;
  assert.equal(removed.actions[0].kind, "uninstalled"); assert.match(removed.actions[0].detail!, /next reconcile .* installs it again/);
  assert.equal(produced(removed).state, "disabled");
  const back = await at("0.1.0").reconcile("daemon_start");
  assert.equal(back.actions[0].kind, "reinstalled"); assert.match(back.actions[0].detail!, /after skill\.uninstall removed it/);
  assert.equal(produced(back).state, "installed");
});

test("the link is repointed when it goes elsewhere and left alone when it is a file Localbox did not write", async () => {
  const { home, at } = await mac();
  await mkdir(join(home, ".local/bin"), { recursive: true }); await symlink("/somewhere/else", join(home, ".local/bin/localbox"));
  const repointed = await at("0.1.0").reconcile("install");
  assert.equal(repointed.actions[1].kind, "replaced"); assert.match(repointed.actions[1].detail!, /instead of \/somewhere\/else/);
  const other = await mac();
  await mkdir(join(other.home, ".local/bin"), { recursive: true }); await writeFile(join(other.home, ".local/bin/localbox"), "mine\n");
  const kept = await other.at("0.1.0").reconcile("install");
  assert.equal(kept.actions[1].kind, "left_alone"); assert.equal(produced(kept).command.state, "not_a_link");
  assert.equal(await readFile(join(other.home, ".local/bin/localbox"), "utf8"), "mine\n");
});

test("the catalog operations read the same state, and a checkout has no command to install", async () => {
  const { home, at } = await mac();
  await at("0.1.0").reconcile("install");
  const setup = await at("0.1.0").handle("agents.setup.status", {}) as Record<string, unknown>;
  assert.deepEqual({ enabled: setup.enabled, skill: setup.skill, source_revision: setup.source_revision, command: setup.command }, { enabled: true, skill: "installed", source_revision: "0.1.0", command: "linked" });
  const cli = await cliStatus(at("0.1.0"));
  assert.equal(cli.path, join(home, ".local/bin/localbox")); assert.equal(cli.managed, true);
  const checkout = new AgentSetup({ env: { HOME: home, LOCALBOX_MACHINE_ROOT: join(home, "m") }, release: { revision: "0.1.0", cli: null, app: null, launcher: null }, skills: new SkillManager({ home, revision: "0.1.0", installerPath: installer }) });
  assert.deepEqual([(await cliStatus(checkout)).state, (await cliStatus(checkout)).managed], ["not_app_managed", false]);
  await assert.rejects(() => checkout.handle("sandbox.list", {}), (error) => error instanceof ContractError && error.code === "invalid_input");
});

test("in the app, reconcile writes the launcher's bytes as the command and puts ~/.local/bin on PATH, once", async () => {
  const { home, app, command, at } = await appMac();
  const installed = await at().reconcile("install");
  assert.deepEqual(kinds(installed), ["skill:installed", "command:installed"]);
  assert.equal(await readFile(command, "utf8"), LAUNCHER);
  assert.equal((await stat(command)).mode & 0o777, 0o755);
  assert.equal(await readFile(join(home, ".zprofile"), "utf8"), PATH_BLOCK);
  assert.deepEqual(await cliStatus(at()), { path: command, state: "installed", app, launcher: join(app, "Contents/Resources/bin/localbox"), on_path: true, profile: join(home, ".zprofile"), release: "0.1.0", managed: true });
  const again = await at().reconcile("daemon_start");
  assert.deepEqual(kinds(again), ["skill:left_alone", "command:left_alone"]);
  assert.equal(await readFile(join(home, ".zprofile"), "utf8"), PATH_BLOCK, "the block is added once");
});

test("a file someone else put at the command is left alone; an edited or older launcher reads different and is replaced", async () => {
  const foreign = await appMac();
  await mkdir(dirname(foreign.command), { recursive: true }); await writeFile(foreign.command, "#!/bin/sh\necho mine\n");
  assert.equal((await cliStatus(foreign.at())).state, "different");
  const kept = await foreign.at().reconcile("install");
  assert.equal(kept.actions[1].kind, "left_alone"); assert.match(kept.actions[1].detail!, /did not write/);
  assert.equal(await readFile(foreign.command, "utf8"), "#!/bin/sh\necho mine\n");

  const edited = await appMac();
  await edited.at().reconcile("install");
  await writeFile(edited.command, `${LAUNCHER}# edited\n`);
  assert.equal((await cliStatus(edited.at())).state, "different");
  await writeFile(edited.launcher, `${LAUNCHER}# build 2\n`);
  const updated = await edited.at().reconcile("daemon_start");
  assert.equal(updated.actions[1].kind, "replaced");
  assert.equal(await readFile(edited.command, "utf8"), `${LAUNCHER}# build 2\n`);
  assert.equal((await cliStatus(edited.at())).state, "installed");
});

test("an app outside an Applications folder gets no command and no PATH block", async () => {
  const { home, command, at } = await appMac("Downloads");
  const report = await at().reconcile("install");
  assert.deepEqual(kinds(report), ["skill:installed", "command:left_alone"]); assert.match(report.actions[1].detail!, /not in ~\/Applications/);
  const status = await cliStatus(at());
  assert.deepEqual([status.state, status.managed], ["not_in_applications", false]);
  await assert.rejects(stat(command)); await assert.rejects(stat(join(home, ".zprofile")));
});

test("PATH a login file already covers gets no block, and turning setup off removes exactly Localbox's block", async () => {
  const covered = await appMac();
  await mkdir(covered.home, { recursive: true }); await writeFile(join(covered.home, ".zshenv"), 'export PATH="$HOME/.local/bin:$PATH"\n');
  await covered.at().reconcile("install");
  await assert.rejects(stat(join(covered.home, ".zprofile")));
  assert.deepEqual([(await cliStatus(covered.at())).on_path, (await cliStatus(covered.at())).profile], [true, null]);

  const { home, at } = await appMac();
  await mkdir(home, { recursive: true }); await writeFile(join(home, ".bash_login"), "export EDITOR=vim\n", { mode: 0o600 });
  await at("0.1.0", "/bin/bash").reconcile("install");
  assert.equal(await readFile(join(home, ".bash_login"), "utf8"), `export EDITOR=vim\n${PATH_BLOCK}`, "bash's block joins the login file it already reads");
  const off = await at("0.1.0", "/bin/bash").set(false);
  assert.match(off.actions[0].detail!, /removed its PATH block from .*\.bash_login/);
  assert.equal(await readFile(join(home, ".bash_login"), "utf8"), "export EDITOR=vim\n");
  assert.equal((await stat(join(home, ".bash_login"))).mode & 0o777, 0o600, "the profile keeps its mode");
});
