import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSetup, type Release } from "../apps/cli/src/agent-setup.js";
import { SkillManager } from "../apps/cli/src/skill-manager.js";
import { ContractError, type ActionReport } from "../packages/contract/src/index.js";

const installer = join(process.cwd(), "node_modules/skills/bin/cli.mjs");

/** A Mac with its own HOME and machine root, and an installed release `revision` whose CLI the link should reach. */
async function mac(): Promise<{ home: string; root: string; at(revision: string): AgentSetup }> {
  const base = await mkdtemp(join(tmpdir(), "localbox-agent-setup-"));
  const home = join(base, "home"), root = join(base, "machine");
  const cli = join(base, "releases/active/localbox-cli/bin/localbox");
  await mkdir(join(base, "releases/active/localbox-cli/bin"), { recursive: true }); await writeFile(cli, "#!/bin/sh\n");
  const at = (revision: string) => {
    const release: Release = { revision, cli };
    return new AgentSetup({ env: { HOME: home, LOCALBOX_MACHINE_ROOT: root }, release, skills: new SkillManager({ home, revision, installerPath: installer }) });
  };
  return { home, root, at };
}
const kinds = (report: ActionReport) => report.actions.map((action) => `${action.subject ?? "setting"}:${action.kind}`);
const produced = (report: ActionReport) => report.produced as { state: string; managed: boolean; source_revision: string | null; cli_link: { state: string } };

test("a fresh install installs the skill and links the CLI; the next daemon start leaves both alone", async () => {
  const { home, at } = await mac();
  const installed = await at("0.1.0").reconcile("install");
  assert.deepEqual(kinds(installed), ["skill:installed", "cli_link:linked"]);
  assert.deepEqual({ ...produced(installed), cli_link: produced(installed).cli_link.state }, { state: "installed", managed: true, source_revision: "0.1.0", receipt: join(home, ".config/localbox/skill-install.json"), cli_link: "linked" });
  assert.match(await readlink(join(home, ".local/bin/localbox")), /releases\/active\/localbox-cli\/bin\/localbox$/);
  const again = await at("0.1.0").reconcile("daemon_start");
  assert.deepEqual(kinds(again), ["skill:left_alone", "cli_link:left_alone"]);
  assert.match(again.actions[0].detail!, /already release 0\.1\.0's skill/);
});

test("a hand-copied skill is backed up and replaced while setup is on; a newer release replaces Localbox's own copy", async () => {
  const { home, at } = await mac();
  await mkdir(join(home, ".agents/skills/localbox"), { recursive: true }); await writeFile(join(home, ".agents/skills/localbox/SKILL.md"), "hand copy\n");
  const replaced = await at("0.1.0").reconcile("install");
  assert.deepEqual(kinds(replaced), ["skill:replaced", "cli_link:linked"]);
  assert.equal(await readFile(join(String(replaced.actions[0].backup), ".agents/skills/localbox/SKILL.md"), "utf8"), "hand copy\n");
  const updated = await at("0.2.0").reconcile("daemon_start");
  assert.deepEqual(kinds(updated), ["skill:replaced", "cli_link:left_alone"]);
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
  assert.deepEqual(kinds(skipped), ["skill:left_alone", "cli_link:left_alone"]); assert.match(skipped.actions[0].detail!, /agent setup is off/);
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
  assert.equal(kept.actions[1].kind, "left_alone"); assert.equal(produced(kept).cli_link.state, "not_a_link");
  assert.equal(await readFile(join(other.home, ".local/bin/localbox"), "utf8"), "mine\n");
});

test("the catalog operations read the same state, and a checkout has no link to make", async () => {
  const { home, at } = await mac();
  await at("0.1.0").reconcile("install");
  const setup = await at("0.1.0").handle("agents.setup.status", {}) as Record<string, unknown>;
  assert.deepEqual({ enabled: setup.enabled, skill: setup.skill, source_revision: setup.source_revision, cli_link: setup.cli_link }, { enabled: true, skill: "installed", source_revision: "0.1.0", cli_link: "linked" });
  const cli = await at("0.1.0").handle("cli.status", {}) as Record<string, unknown>;
  assert.equal(cli.path, join(home, ".local/bin/localbox")); assert.equal(cli.managed, true);
  const checkout = new AgentSetup({ env: { HOME: home, LOCALBOX_MACHINE_ROOT: join(home, "m") }, release: { revision: "0.1.0", cli: null }, skills: new SkillManager({ home, revision: "0.1.0", installerPath: installer }) });
  assert.equal((await checkout.handle("cli.status", {}) as Record<string, unknown>).state, "not_a_release");
  await assert.rejects(() => checkout.handle("sandbox.list", {}), (error) => error instanceof ContractError && error.code === "invalid_input");
});
