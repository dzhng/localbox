import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSTALLER = "skills@1.7.0";
const KNOWN_PATHS = [".agents/skills/localbox", ".codex/skills/localbox", ".claude/skills/localbox"];
const SOURCE_URL = "https://github.com/dzhng/agent-computer/tree/main/skills/localbox";

function bundledSkillSource(): string {
  const here = new URL(".", import.meta.url);
  const candidates = [
    new URL("../../../skills/localbox", here),
    new URL("../../../../skills/localbox", here),
  ];
  return candidates.map((candidate) => resolve(candidate.pathname)).find((candidate) => existsSync(join(candidate, "SKILL.md"))) ?? resolve(candidates[0].pathname);
}

type Entry = { name: string; path: string; scope?: string; agents?: string[]; source?: string; sourceUrl?: string; sourceType?: string };
type Receipt = { managed: boolean; source: string; installer: string; paths: string[]; entries: Entry[]; operationId: string; installedAt: string };
type State = { state: string; operationId?: string; error?: string; backupPath?: string };
type Runner = (executable: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; output: string }>;

export interface SkillManagerOptions {
  home?: string;
  source?: string;
  sourceUrl?: string;
  nodePath?: string;
  installerPath?: string;
  run?: Runner;
}

export interface SkillStatus {
  state: "installed" | "updating" | "missing" | "unmanaged" | "disabled" | "needs_attention";
  managed: boolean;
  paths: string[];
  destinations: { path: string; exists: boolean; symlink: boolean }[];
  source: string;
  sourceRevision?: string | null;
  installer: string;
  operationId?: string;
  error?: string;
  backupPath?: string;
  entries?: Entry[];
  discoveryError?: string;
}

async function defaultRun(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  try {
    const result = await execFileAsync(executable, args, { env, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, output: result.stdout };
  } catch (error) {
    const value = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: Number(value.code ?? 1), output: `${value.stdout ?? ""}${value.stderr ?? ""}${value.message ?? ""}` };
  }
}

export class SkillManager {
  private readonly home: string;
  private readonly source: string;
  private readonly sourceUrl: string;
  private readonly nodePath?: string;
  private readonly installerPath?: string;
  private readonly run: Runner;
  constructor(options: SkillManagerOptions = {}) {
    this.home = resolve(options.home ?? process.env.LOCALBOX_SKILL_HOME ?? homedir());
    this.source = resolve(options.source ?? process.env.LOCALBOX_SKILL_SOURCE ?? bundledSkillSource());
    this.sourceUrl = options.sourceUrl ?? SOURCE_URL;
    this.nodePath = options.nodePath ?? process.env.LOCALBOX_NODE_PATH;
    this.installerPath = options.installerPath ?? process.env.LOCALBOX_SKILLS_INSTALLER;
    this.run = options.run ?? defaultRun;
  }
  async status(explicit?: Partial<SkillStatus>): Promise<SkillStatus> {
    const receipt = await this.readReceipt();
    const discovered = receipt ? { entries: receipt.entries, error: undefined } : await this.discover();
    const paths = (receipt?.paths ?? discovered.entries.filter((entry) => entry.name === "localbox").map((entry) => entry.path)).filter((path) => this.safePath(path));
    const destinations = await Promise.all(paths.sort().map(async (path) => ({ path, exists: await this.exists(path), symlink: await this.isSymlink(path) })));
    const state = await this.readState();
    const effective = explicit?.state ?? state?.state ?? (receipt?.managed ? (destinations.every((entry) => entry.exists) ? "installed" : "needs_attention") : discovered.entries.some((entry) => entry.name === "localbox") ? "unmanaged" : "missing");
    return {
      state: effective as SkillStatus["state"], managed: receipt?.managed === true, paths, destinations,
      source: receipt?.source ?? this.sourceUrl, sourceRevision: receipt?.entries[0]?.source ?? null,
      installer: receipt?.installer ?? INSTALLER, ...(explicit?.operationId ?? state?.operationId ? { operationId: explicit?.operationId ?? state?.operationId } : {}),
      ...(state?.error ? { error: state.error } : {}), ...(state?.backupPath ? { backupPath: state.backupPath } : {}),
      ...(receipt?.entries ? { entries: receipt.entries } : {}), ...(discovered.error ? { discoveryError: discovered.error } : {}),
    };
  }
  async install(): Promise<SkillStatus> { return this.replace(); }
  async update(): Promise<SkillStatus> { return this.replace(); }
  async uninstall(): Promise<SkillStatus> {
    const operationId = randomUUID();
    const receipt = await this.readReceipt();
    if (!receipt?.managed) { await this.writeState({ state: "disabled", operationId }); return this.status({ state: "disabled", operationId }); }
    try {
      const paths = new Set([...receipt.paths, ...(await this.discover()).entries.filter((entry) => entry.name === "localbox" && entry.scope === "global").map((entry) => entry.path)]);
      for (const path of paths) if (this.safePath(path)) await rm(path, { recursive: true, force: true });
      if ((await this.exists(this.receiptPath))) await rm(this.receiptPath, { force: true });
      if ((await this.exists(this.statePath))) await rm(this.statePath, { force: true });
      return this.status({ state: "disabled", operationId });
    } catch (error) {
      await this.writeState({ state: "needs_attention", operationId, error: error instanceof Error ? error.message : String(error) });
      return this.status({ state: "needs_attention", operationId });
    }
  }
  private async replace(): Promise<SkillStatus> {
    const operationId = randomUUID();
    const stage = join(this.home, ".localbox", `skill-${operationId}`);
    const backup = join(stage, "backup");
    const backedUp: string[] = [];
    try {
      const marker = join(this.source, "SKILL.md");
      await access(marker, constants.F_OK);
      await mkdir(backup, { recursive: true });
      const previousReceipt = await this.readReceipt();
      const discovered = await this.discover();
      const paths = new Set([...KNOWN_PATHS.map((path) => join(this.home, path)), ...discovered.entries.filter((entry) => entry.name === "localbox" && entry.scope === "global").map((entry) => entry.path), ...(previousReceipt?.paths ?? [])]);
      for (const path of paths) {
        if (!this.safePath(path) || !(await this.exists(path))) continue;
        const saved = join(backup, relative(this.home, path));
        await mkdir(dirname(saved), { recursive: true });
        await copyPreservingSymlink(path, saved);
        backedUp.push(path);
        await rm(path, { recursive: true, force: true });
      }
      if (await this.exists(this.receiptPath)) {
        const saved = join(backup, relative(this.home, this.receiptPath));
        await mkdir(dirname(saved), { recursive: true }); await copyPreservingSymlink(this.receiptPath, saved); backedUp.push(this.receiptPath); await rm(this.receiptPath, { force: true });
      }
      const installer = await this.resolveInstaller();
      const result = await this.run(installer.node, [installer.script, "add", this.source, "--all", "--global", "--yes"], this.commandEnv(installer.node));
      if (result.code !== 0) throw new Error(result.output.trim() || "bundled skills installer failed");
      const after = await this.discover();
      const entries = after.entries.filter((entry) => entry.name === "localbox" && entry.scope === "global");
      const canonical = join(this.home, ".agents/skills/localbox");
      if (!(await this.exists(canonical)) || !(await this.exists(join(canonical, "SKILL.md"))) || !entries.every((entry) => this.safePath(entry.path))) throw new Error("installed skill verification failed");
      for (const entry of entries) if (!(await this.exists(join(entry.path, "SKILL.md")))) throw new Error("installed skill verification failed");
      const receipt: Receipt = { managed: true, source: this.sourceUrl, installer: INSTALLER, paths: entries.map((entry) => entry.path).filter((path) => this.safePath(path)), entries, operationId, installedAt: new Date().toISOString() };
      await mkdir(dirname(this.receiptPath), { recursive: true }); await writeFile(this.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      await rm(this.statePath, { force: true }); await rm(stage, { recursive: true, force: true });
      return this.status({ state: "installed", operationId });
    } catch (error) {
      await this.restore(backup, backedUp);
      await this.writeState({ state: "needs_attention", operationId, error: error instanceof Error ? error.message : String(error), backupPath: backup });
      return this.status({ state: "needs_attention", operationId });
    }
  }
  private async discover(): Promise<{ entries: Entry[]; error?: string }> {
    try {
      const installer = await this.resolveInstaller(); const result = await this.run(installer.node, [installer.script, "ls", "--global", "--json"], this.commandEnv(installer.node));
      if (result.code !== 0) return { entries: await this.fallbackEntries(), error: result.output.trim() || "skill discovery failed" };
      const entries = JSON.parse(result.output) as Entry[]; return { entries: Array.isArray(entries) ? entries : [], error: undefined };
    } catch (error) { return { entries: await this.fallbackEntries(), error: error instanceof Error ? error.message : String(error) }; }
  }
  private async fallbackEntries(): Promise<Entry[]> { return (await Promise.all(KNOWN_PATHS.map(async (path): Promise<Entry | undefined> => { const full = join(this.home, path); return (await this.exists(full)) ? { name: "localbox", path: full, scope: "global" } : undefined; }))).filter((entry): entry is Entry => Boolean(entry)); }
  private async resolveInstaller(): Promise<{ node: string; script: string }> {
    const node = this.nodePath ?? process.execPath;
    if (!(await this.isExecutable(node))) throw new Error("Localbox's bundled Node runtime is unavailable");
    const scripts = [
      this.installerPath,
      join(this.home, ".localbox/skills-installer/cli.mjs"),
      resolve(new URL("../../../node_modules/skills/bin/cli.mjs", import.meta.url).pathname),
      resolve(new URL("../../../../node_modules/skills/bin/cli.mjs", import.meta.url).pathname),
    ].filter((candidate): candidate is string => Boolean(candidate));
    const script = scripts.find((candidate) => existsSync(candidate));
    if (!script) throw new Error(`${INSTALLER} is not bundled in this release`);
    return { node, script };
  }
  private commandEnv(node: string): NodeJS.ProcessEnv { return { ...process.env, HOME: this.home, USERPROFILE: this.home, DISABLE_TELEMETRY: "1", PATH: `${dirname(node)}:${process.env.PATH ?? "/usr/bin:/bin"}` }; }
  private get receiptPath(): string { return join(this.home, ".config/localbox/skill-install.json"); }
  private get statePath(): string { return join(this.home, ".config/localbox/skill-state.json"); }
  private async readReceipt(): Promise<Receipt | undefined> { try { return JSON.parse(await readFile(this.receiptPath, "utf8")) as Receipt; } catch { return undefined; } }
  private async readState(): Promise<State | undefined> { try { return JSON.parse(await readFile(this.statePath, "utf8")) as State; } catch { return undefined; } }
  private async writeState(state: State): Promise<void> { await mkdir(dirname(this.statePath), { recursive: true }); await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); }
  private async restore(backup: string, paths: string[]): Promise<void> { for (const path of paths.sort((a, b) => a.length - b.length)) { const source = join(backup, relative(this.home, path)); if (!(await this.exists(source))) continue; await rm(path, { recursive: true, force: true }); await mkdir(dirname(path), { recursive: true }); await copyPreservingSymlink(source, path); } }
  private safePath(path: string): boolean { const root = this.home.endsWith("/") ? this.home : `${this.home}/`; return resolve(path).startsWith(root); }
  private async exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch { return false; } }
  private async isExecutable(path: string): Promise<boolean> { try { await access(path, constants.X_OK); return true; } catch { return false; } }
  private async isSymlink(path: string): Promise<boolean> { try { return (await lstat(path)).isSymbolicLink(); } catch { return false; } }
}

async function copyPreservingSymlink(source: string, destination: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) return symlink(await readlink(source), destination);
  await cp(source, destination, { recursive: true, force: true, dereference: false });
}
