import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SETUP_OPERATIONS, ContractError, type ActionReport, type Json, type OperationId } from "../../../packages/contract/src/index.js";
import { machinePaths } from "../../../packages/config/src/index.js";
import { SkillManager, type SkillStatus } from "./skill-manager.js";

/** What started a reconcile: the installer, a daemon start (every launch, including after an update), or a request. */
export type Reason = "install" | "daemon_start" | "explicit";
export const REASONS: readonly Reason[] = ["install", "daemon_start", "explicit"];

/** The agent setup setting, `<machine root>/agent-setup.json`. Without the file it is on. */
export interface Setting { enabled: boolean; changed_at: string | null }

/** The release this CLI belongs to: its version, and the `localbox` link target when it is an installed release. */
export interface Release { revision: string | null; cli: string | null }

export interface AgentSetupOptions {
  env?: NodeJS.ProcessEnv;
  skills?: SkillManager;
  release?: Release;
}

type Action = ActionReport["actions"][number];
type LinkState = "linked" | "missing" | "elsewhere" | "not_a_link" | "not_a_release";
interface LinkView { path: string; state: LinkState; target: string | null; expected: string | null }

/**
 * The installed release's own location. A release CLI runs from `<releases>/<version>/localbox-cli/dist/apps/cli/src`
 * next to that version's `release.json`, and the link points through `<releases>/active`. A checkout has neither, so its
 * revision is its package.json version and it has nothing to link.
 */
export function thisRelease(): Release {
  const here = dirname(fileURLToPath(import.meta.url));
  const releaseCli = resolve(here, "../../../.."), manifest = join(dirname(releaseCli), "release.json");
  if (existsSync(manifest)) {
    const releases = dirname(dirname(releaseCli));
    return { revision: (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? null, cli: existsSync(join(releases, "active")) ? join(releases, "active/localbox-cli/bin/localbox") : null };
  }
  const packageJson = [resolve(here, "../../../package.json"), join(releaseCli, "package.json")].find((path) => existsSync(path));
  return { revision: packageJson ? (JSON.parse(readFileSync(packageJson, "utf8")) as { version?: string }).version ?? null : null, cli: null };
}

/**
 * The one owner of "the skill and the `localbox` link match this release" (D16). `reconcile` runs at the end of
 * install-release.sh, at every daemon start and on an explicit skill.install/update; the catalog's agent setup
 * operations read and change the same state. Results follow P1: what was installed, replaced (and where the backup
 * is), or left alone, and why.
 */
export class AgentSetup {
  private readonly env: NodeJS.ProcessEnv;
  private readonly release: Release;
  private readonly skills: SkillManager;
  constructor(options: AgentSetupOptions = {}) {
    this.env = options.env ?? process.env;
    this.release = options.release ?? thisRelease();
    this.skills = options.skills ?? new SkillManager({ revision: this.release.revision });
  }

  get settingPath(): string { return join(machinePaths(this.env).root, "agent-setup.json"); }
  private get linkPath(): string { return join(this.env.LOCALBOX_BIN_DIR ?? join(this.env.HOME || homedir(), ".local/bin"), "localbox"); }

  async setting(): Promise<Setting> {
    try { const value = JSON.parse(await readFile(this.settingPath, "utf8")) as Partial<Setting>; return { enabled: value.enabled !== false, changed_at: value.changed_at ?? null }; }
    catch { return { enabled: true, changed_at: null }; }
  }

  /** A catalog agent setup operation, as the CLI and (through HostDaemon) MCP answer it. */
  async handle(operation: OperationId, input: Json): Promise<Json> {
    const asked = (input ?? {}) as { [key: string]: Json };
    switch (operation) {
      case "skill.status": return await this.skillStatus() as unknown as Json;
      case "skill.install": case "skill.update": return await this.reconcile("explicit", asked) as unknown as Json;
      case "skill.uninstall": return await this.uninstall(asked) as unknown as Json;
      case "cli.status": return await this.cliStatus() as unknown as Json;
      case "agents.setup.status": return await this.status() as unknown as Json;
      case "agents.setup.set": return await this.set(asked.enabled === true, asked) as unknown as Json;
      default: throw new ContractError("invalid_input", `${operation} is not an agent setup operation; they are ${AGENT_SETUP_OPERATIONS.join(", ")}`);
    }
  }

  /**
   * Make the skill and the link match this release. With setup off, only an explicit request acts. A skill already
   * from this release, at every path, is left alone; an explicit request reinstalls it anyway.
   */
  async reconcile(reason: Reason, requested: Json = { reason }): Promise<ActionReport> {
    const { enabled } = await this.setting();
    if (!enabled && reason !== "explicit") {
      const why = "agent setup is off, so the skill and the localbox link are the user's";
      return this.report(requested, [{ kind: "left_alone", subject: "skill", detail: why }, { kind: "left_alone", subject: "cli_link", detail: why }]);
    }
    const actions = [await this.reconcileSkill(reason === "explicit", !enabled), await this.reconcileLink()];
    return this.report(requested, actions);
  }

  /** `force` reinstalls a skill that already matches; `userOwned` (setup off) keeps a backup of whatever is replaced. */
  private async reconcileSkill(force: boolean, userOwned: boolean): Promise<Action> {
    const before = await this.skills.status();
    const revision = this.release.revision ?? "this checkout";
    const present = before.destinations.filter((entry) => entry.exists).map((entry) => entry.path);
    if (!force && before.state === "installed" && before.managed && before.sourceRevision === this.release.revision) {
      return { kind: "left_alone", subject: "skill", detail: `already release ${revision}'s skill, for ${harnesses(before)} agent harnesses` };
    }
    const after = await this.skills.install({ keepBackup: userOwned });
    if (after.state !== "installed") return { kind: "failed", subject: "skill", detail: `could not install release ${revision}'s skill: ${after.error ?? after.state}; restored what was there${after.backupPath ? ` (backup at ${after.backupPath})` : ""}` };
    if (after.backupPath) return { kind: "replaced", subject: "skill", backup: after.backupPath, detail: `backed up ${userOwned ? "the copy agent setup was not maintaining" : "a copy Localbox did not write"} (${(after.replaced ?? present).join(", ")}) to ${after.backupPath}, then installed release ${revision}'s skill` };
    if (before.state === "disabled") return { kind: "reinstalled", subject: "skill", detail: `installed release ${revision}'s skill again after skill.uninstall removed it, because agent setup is on` };
    if (before.managed && before.sourceRevision !== this.release.revision) return { kind: "replaced", subject: "skill", detail: `replaced release ${before.sourceRevision ?? "unknown"}'s skill with release ${revision}'s` };
    if (before.managed || present.length) return { kind: "reinstalled", subject: "skill", detail: `reinstalled release ${revision}'s skill${before.state === "installed" ? "" : ` (it was ${before.state})`}` };
    return { kind: "installed", subject: "skill", detail: `installed release ${revision}'s skill for ${harnesses(after)} agent harnesses` };
  }

  /** Points the link at the active release's CLI; a file Localbox did not write is left in place. */
  private async reconcileLink(): Promise<Action> {
    const link = await this.link();
    if (link.state === "not_a_release") return { kind: "left_alone", subject: "cli_link", detail: "this CLI runs from a checkout, not an installed release, so there is nothing to link" };
    if (link.state === "linked") return { kind: "left_alone", subject: "cli_link", detail: `${link.path} already points at ${link.expected}` };
    if (link.state === "not_a_link") return { kind: "left_alone", subject: "cli_link", detail: `${link.path} is a file Localbox did not write; remove it to let Localbox link the command` };
    await mkdir(dirname(link.path), { recursive: true });
    if (link.state === "elsewhere") await rm(link.path, { force: true });
    await symlink(link.expected!, link.path);
    return link.state === "missing"
      ? { kind: "linked", subject: "cli_link", detail: `linked ${link.path} to ${link.expected}` }
      : { kind: "replaced", subject: "cli_link", detail: `pointed ${link.path} at ${link.expected} instead of ${link.target}` };
  }

  /** Removes the skill Localbox installed; with setup on, the result says the next reconcile brings it back. */
  async uninstall(requested: Json = {}): Promise<ActionReport> {
    const { enabled } = await this.setting();
    const before = await this.skills.status();
    const after = await this.skills.uninstall();
    const removed = after.replaced ?? [];
    const comeback = enabled ? "; agent setup is on, so the next reconcile (the daemon's next start) installs it again; turn agent setup off to keep it removed" : "";
    const action: Action = after.state === "needs_attention" ? { kind: "failed", subject: "skill", detail: `could not remove the skill: ${after.error ?? "unknown error"}` }
      : removed.length ? { kind: "uninstalled", subject: "skill", detail: `removed ${removed.join(", ")}${comeback}` }
      : { kind: "left_alone", subject: "skill", detail: `${before.destinations.some((entry) => entry.exists) ? "Localbox did not write the skill here, so uninstall leaves it" : "no skill was installed"}${comeback}` };
    return this.report(requested, [action]);
  }

  async set(enabled: boolean, requested: Json = { enabled }): Promise<ActionReport> {
    const current = await this.setting();
    if (current.enabled === enabled) return this.report(requested, [{ kind: "left_alone", detail: `agent setup was already ${enabled ? "on" : "off"}` }]);
    await mkdir(dirname(this.settingPath), { recursive: true });
    await writeFile(this.settingPath, `${JSON.stringify({ enabled, changed_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return this.report(requested, [enabled
      ? { kind: "turned_on", detail: "Localbox maintains the skill and the localbox link again from the next reconcile (the daemon's next start, or skill.install)" }
      : { kind: "turned_off", detail: "Localbox leaves the skill and the localbox link alone until agent setup is turned on" }]);
  }

  /** `skill.status`. While setup is off Localbox maintains nothing, so a skill that is there reads `unmanaged`. */
  async skillStatus(): Promise<{ [key: string]: Json }> {
    const [status, { enabled }] = await Promise.all([this.skills.status(), this.setting()]);
    const present = status.destinations.some((entry) => entry.exists);
    const state = enabled ? status.state : present ? "unmanaged" : status.state === "disabled" ? "disabled" : "missing";
    return {
      state, managed: enabled && status.managed, source_revision: status.sourceRevision, release: this.release.revision, receipt: status.receipt,
      paths: status.paths, destinations: status.destinations, source: status.source, installer: status.installer, agent_setup: enabled,
      ...optional(status),
    };
  }

  async cliStatus(): Promise<{ [key: string]: Json }> {
    const [link, { enabled }] = await Promise.all([this.link(), this.setting()]);
    return { ...link, release: this.release.revision, managed: enabled && link.state !== "not_a_release" };
  }

  async status(): Promise<{ [key: string]: Json }> {
    const [setting, skill, link] = await Promise.all([this.setting(), this.skillStatus(), this.link()]);
    return { enabled: setting.enabled, changed_at: setting.changed_at, setting: this.settingPath, release: this.release.revision, skill: skill.state, source_revision: skill.source_revision, cli_link: link.state };
  }

  private async report(requested: Json, actions: Action[]): Promise<ActionReport> {
    const [skill, link] = await Promise.all([this.skillStatus(), this.link()]);
    return { requested, produced: { state: skill.state, managed: skill.managed, source_revision: skill.source_revision, receipt: skill.receipt, cli_link: link as unknown as Json }, actions };
  }

  private async link(): Promise<LinkView> {
    const path = this.linkPath, expected = this.release.cli;
    let target: string | null = null, kind: "missing" | "link" | "file" = "missing";
    try { const info = await lstat(path); kind = info.isSymbolicLink() ? "link" : "file"; if (kind === "link") target = await readlink(path); } catch { /* missing */ }
    const state: LinkState = !expected ? "not_a_release" : kind === "missing" ? "missing" : kind === "file" ? "not_a_link" : target === expected ? "linked" : "elsewhere";
    return { path, state, target, expected };
  }
}

const harnesses = (status: SkillStatus) => new Set((status.entries ?? []).flatMap((entry) => entry.agents ?? [])).size;

function optional(status: SkillStatus): { [key: string]: Json } {
  return {
    ...(status.operationId ? { operation_id: status.operationId } : {}), ...(status.error ? { error: status.error } : {}),
    ...(status.backupPath ? { backup_path: status.backupPath } : {}), ...(status.discoveryError ? { discovery_error: status.discoveryError } : {}),
  };
}

export const isAgentSetupOperation = (operation: string): operation is OperationId => (AGENT_SETUP_OPERATIONS as readonly string[]).includes(operation);
