import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_SETUP_OPERATIONS, ContractError, type ActionReport, type Json, type OperationId } from "../../../packages/contract/src/index.js";
import { machinePaths } from "../../../packages/config/src/index.js";
import { layout, type Layout } from "./layout.js";
import { addPathBlock, pathStatus, removePathBlock } from "./shell-profile.js";
import { SkillManager, type SkillStatus } from "./skill-manager.js";

/** What started a reconcile: the installer, a rollback, a daemon start (every launch, including after an update), or a request. */
export type Reason = "install" | "rollback" | "daemon_start" | "explicit";
export const REASONS: readonly Reason[] = ["install", "rollback", "daemon_start", "explicit"];

/** The agent setup setting, `<machine root>/agent-setup.json`. Without the file it is on. */
export interface Setting { enabled: boolean; changed_at: string | null }

/** The release this CLI belongs to: its version, the app it ships in and that app's launcher, or the old install's link target. */
export type Release = Pick<Layout, "revision" | "cli" | "app" | "launcher">;

export interface AgentSetupOptions {
  env?: NodeJS.ProcessEnv;
  skills?: SkillManager;
  release?: Release;
  /** The login shell, which picks the startup file the PATH block goes in; `$SHELL` by default. */
  shell?: string;
}

type Action = ActionReport["actions"][number];
/**
 * `~/.local/bin/localbox` for a CLI inside the app: the launcher's bytes (`installed`), nothing (`missing`), other
 * bytes (`different`), an app outside an Applications folder (`not_in_applications`), or a CLI in no app
 * (`not_app_managed`, a checkout). `on_path` says whether the login shell's startup files put it on PATH.
 */
type CommandState = "installed" | "missing" | "different" | "not_in_applications" | "not_app_managed";
interface CommandView { path: string; state: CommandState; app: string | null; launcher: string | null; on_path: boolean; profile: string | null }
/** The old install's symlink into `releases/active`, until slice 10 of specs/menu-bar-app deletes that install. */
type LinkState = "linked" | "missing" | "elsewhere" | "not_a_link";
interface LinkView { path: string; state: LinkState; target: string | null; expected: string }
/** Every launcher apps/macos/App/launcher/main.c builds carries this, so an earlier Localbox launcher is replaced and anyone else's file is not. */
const LAUNCHER_MARK = "sh.localbox.launcher";
/** The folders the launcher looks in for Localbox.app. */
const applications = (home: string) => [join(home, "Applications"), "/Applications"];

/**
 * The one owner of "the skill, the `localbox` command and its PATH block match this release". `reconcile` runs at the
 * end of install-release.sh and rollback-release.sh, at every daemon start and on an explicit skill.install/update;
 * the catalog's agent setup operations read and change the same state. Every result is an action report: what was
 * installed, replaced (and where the backup is), or left alone, and why.
 */
export class AgentSetup {
  private readonly env: NodeJS.ProcessEnv;
  private readonly release: Release;
  private readonly skills: SkillManager;
  private readonly shell: string;
  constructor(options: AgentSetupOptions = {}) {
    this.env = options.env ?? process.env;
    this.release = options.release ?? layout();
    this.skills = options.skills ?? new SkillManager({ revision: this.release.revision });
    this.shell = options.shell ?? this.env.SHELL ?? "/bin/zsh";
  }

  get settingPath(): string { return join(machinePaths(this.env).root, "agent-setup.json"); }
  private get home(): string { return this.env.HOME || homedir(); }
  private get commandPath(): string { return join(this.env.LOCALBOX_BIN_DIR ?? join(this.home, ".local/bin"), "localbox"); }

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
   * Make the skill and the command match this release. With setup off, only an explicit request acts. A skill already
   * from this release, at every path, is left alone; an explicit request reinstalls it anyway.
   */
  async reconcile(reason: Reason, requested: Json = { reason }): Promise<ActionReport> {
    const { enabled } = await this.setting();
    if (!enabled && reason !== "explicit") {
      const why = "agent setup is off, so the skill and the localbox command are the user's";
      return this.report(requested, [{ kind: "left_alone", subject: "skill", detail: why }, { kind: "left_alone", subject: "command", detail: why }]);
    }
    const actions = [await this.reconcileSkill(reason === "explicit", !enabled), await this.reconcileCommand()];
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

  /**
   * Makes `~/.local/bin/localbox` the app's launcher, written as fresh bytes and renamed into place (a copied file
   * would carry the bundle's quarantine), then puts `~/.local/bin` on the login shell's PATH. Only for an app in an
   * Applications folder, where the launcher looks; a file Localbox did not write is left in place.
   */
  private async reconcileCommand(): Promise<Action> {
    if (!this.release.app && this.release.cli) return await this.reconcileLink(this.release.cli);
    const command = await this.command() as CommandView;
    if (command.state === "not_app_managed") return { kind: "left_alone", subject: "command", detail: "this CLI runs from a checkout, not Localbox.app, so there is no command to install" };
    if (command.state === "not_in_applications") return { kind: "left_alone", subject: "command", detail: `${command.app} is not in ~/Applications or /Applications, where the localbox command looks for it, so Localbox installs no command for it` };
    try {
      if (command.state === "different" && !(await readFile(command.path).catch(() => Buffer.alloc(0))).includes(LAUNCHER_MARK))
        return { kind: "left_alone", subject: "command", detail: `${command.path} is a file Localbox did not write; remove it to let Localbox install the command` };
      if (command.state !== "installed") await this.writeCommand(await readFile(command.launcher!));
      const profile = await addPathBlock(this.home, this.shell);
      const onPath = profile ? `; added ~/.local/bin to PATH in ${profile}` : "";
      if (command.state === "installed") return { kind: "left_alone", subject: "command", detail: `${command.path} is already ${command.app}'s launcher${onPath}` };
      return command.state === "missing"
        ? { kind: "installed", subject: "command", detail: `installed ${command.app}'s launcher at ${command.path}${onPath}` }
        : { kind: "replaced", subject: "command", detail: `replaced an earlier Localbox launcher at ${command.path} with ${command.app}'s${onPath}` };
    } catch (error) {
      return { kind: "failed", subject: "command", detail: `could not install the localbox command at ${command.path}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** The launcher's bytes under a temporary name beside the command, then one rename over it. */
  private async writeCommand(bytes: Buffer): Promise<void> {
    const path = this.commandPath, staging = `${path}.installing-${process.pid}`;
    await mkdir(dirname(path), { recursive: true });
    try { await writeFile(staging, bytes, { mode: 0o755 }); await chmod(staging, 0o755); await rename(staging, path); }
    catch (error) { await rm(staging, { force: true }); throw error; }
  }

  /** The old install: points the link at the active release's CLI; a file Localbox did not write is left in place. */
  private async reconcileLink(expected: string): Promise<Action> {
    const link = await this.link(expected);
    if (link.state === "linked") return { kind: "left_alone", subject: "command", detail: `${link.path} already points at ${link.expected}` };
    if (link.state === "not_a_link") return { kind: "left_alone", subject: "command", detail: `${link.path} is a file Localbox did not write; remove it to let Localbox link the command` };
    await mkdir(dirname(link.path), { recursive: true });
    if (link.state === "elsewhere") await rm(link.path, { force: true });
    await symlink(link.expected, link.path);
    return link.state === "missing"
      ? { kind: "linked", subject: "command", detail: `linked ${link.path} to ${link.expected}` }
      : { kind: "replaced", subject: "command", detail: `pointed ${link.path} at ${link.expected} instead of ${link.target}` };
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
    if (enabled) return this.report(requested, [{ kind: "turned_on", detail: "Localbox maintains the skill and the localbox command again from the next reconcile (the daemon's next start, or skill.install)" }]);
    // Only the app's CLI adds the PATH block; the old installer's block is the installer's to remove.
    const removed = this.release.app ? await removePathBlock(this.home) : [];
    return this.report(requested, [{ kind: "turned_off", detail: `Localbox leaves the skill and the localbox command alone until agent setup is turned on${removed.length ? `; removed its PATH block from ${removed.join(", ")}` : ""}` }]);
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
    const [command, { enabled }] = await Promise.all([this.command(), this.setting()]);
    return { ...command, release: this.release.revision, managed: enabled && command.state !== "not_app_managed" && command.state !== "not_in_applications" };
  }

  async status(): Promise<{ [key: string]: Json }> {
    const [setting, skill, command] = await Promise.all([this.setting(), this.skillStatus(), this.command()]);
    return { enabled: setting.enabled, changed_at: setting.changed_at, setting: this.settingPath, release: this.release.revision, skill: skill.state, source_revision: skill.source_revision, command: command.state };
  }

  private async report(requested: Json, actions: Action[]): Promise<ActionReport> {
    const [skill, command] = await Promise.all([this.skillStatus(), this.command()]);
    return { requested, produced: { state: skill.state, managed: skill.managed, source_revision: skill.source_revision, receipt: skill.receipt, command: command as unknown as Json }, actions };
  }

  private async command(): Promise<CommandView | LinkView> {
    const { app, launcher, cli } = this.release, path = this.commandPath;
    if (!app && cli) return await this.link(cli);
    const view = (state: CommandState, onPath = false, profile: string | null = null): CommandView => ({ path, state, app, launcher, on_path: onPath, profile });
    if (!app || !launcher) return view("not_app_managed");
    // Compared as realpaths: the layout found `app` through its realpath, while HOME may run through a link.
    const real = (path: string) => realpath(path).catch(() => path);
    if (!(await Promise.all(applications(this.home).map(real))).includes(await real(dirname(app)))) return view("not_in_applications");
    const [current, bundled, shell] = await Promise.all([readFile(path).catch(() => null), readFile(launcher).catch(() => null), pathStatus(this.home, this.shell)]);
    return view(!current ? "missing" : bundled && current.equals(bundled) ? "installed" : "different", shell.on_path, shell.profile);
  }

  private async link(expected: string): Promise<LinkView> {
    const path = this.commandPath;
    let target: string | null = null, kind: "missing" | "link" | "file" = "missing";
    try { const info = await lstat(path); kind = info.isSymbolicLink() ? "link" : "file"; if (kind === "link") target = await readlink(path); } catch { /* missing */ }
    const state: LinkState = kind === "missing" ? "missing" : kind === "file" ? "not_a_link" : target === expected ? "linked" : "elsewhere";
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
