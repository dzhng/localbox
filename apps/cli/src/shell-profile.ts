import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * The marked block that puts `~/.local/bin` (where the `localbox` command lives) on a login shell's PATH. The text
 * rules are pure; `addPathBlock` and `removePathBlock` apply them to the files under a home. The same markers as
 * scripts/localbox-path.sh, which the old installer still sources until slice 10 of specs/menu-bar-app deletes it.
 */
export const PATH_BLOCK = '# >>> localbox >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< localbox <<<\n';

/** Every startup file the block may have been added to, zsh and bash alike, relative to the home. */
export const STARTUP_FILES = [".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bash_login", ".profile", ".bashrc"];

/**
 * The startup files a login shell reads even when it is not interactive, as agents run it (`zsh -lc`); only their
 * PATH lines count. `.zshrc` and `.bashrc` are interactive-only, and a shell Localbox doesn't know reads none.
 */
export function loginFiles(shell: string): string[] {
  switch (basename(shell)) {
    case "bash": return [".bash_profile", ".bash_login", ".profile"];
    case "zsh": case "": return [".zshenv", ".zprofile"];
    default: return [];
  }
}

/** True when any file has an uncommented line naming both `PATH` and `.local/bin`: a heuristic over text that never runs the user's shell. */
export function covered(files: Record<string, string>): boolean {
  return Object.values(files).some((contents) => contents.split(/\r?\n/).some((raw) => {
    const line = raw.trim();
    return !line.startsWith("#") && line.includes("PATH") && line.includes(".local/bin");
  }));
}

/** Appends the block once, on its own lines. */
export function adding(contents: string): string {
  if (contents.includes(PATH_BLOCK)) return contents;
  return contents === "" || contents.endsWith("\n") ? contents + PATH_BLOCK : `${contents}\n${PATH_BLOCK}`;
}

/** Removes exactly the marked block and nothing else. */
export const removing = (contents: string): string => contents.replaceAll(PATH_BLOCK, "");

/**
 * The file the block goes in, or null for a shell Localbox doesn't configure. Bash reads only the first of
 * `.bash_profile`, `.bash_login`, `.profile` that exists, so the block joins that one: creating `.bash_profile`
 * beside an existing `.profile` would stop `.profile` loading.
 */
export function target(shell: string, existing: ReadonlySet<string>): string | null {
  switch (basename(shell)) {
    case "bash": return [".bash_profile", ".bash_login", ".profile"].find((file) => existing.has(file)) ?? ".bash_profile";
    case "zsh": case "": return ".zprofile";
    default: return null;
  }
}

export interface PathStatus { on_path: boolean; profile: string | null }

/** Whether the login shell's own startup files put `~/.local/bin` on PATH, and which file holds Localbox's block. */
export async function pathStatus(home: string, shell: string): Promise<PathStatus> {
  const files = await startupFiles(home);
  const own = Object.fromEntries(Object.entries(files).filter(([name]) => loginFiles(shell).includes(name)));
  const profile = STARTUP_FILES.find((name) => files[name]?.includes(PATH_BLOCK));
  return { on_path: covered(own), profile: profile ? join(home, profile) : null };
}

/** Adds the block unless the login files already cover `~/.local/bin`; returns the file it edited, if any. */
export async function addPathBlock(home: string, shell: string): Promise<string | null> {
  const files = await startupFiles(home);
  if (covered(Object.fromEntries(Object.entries(files).filter(([name]) => loginFiles(shell).includes(name))))) return null;
  const name = target(shell, new Set(Object.keys(files)));
  if (!name) return null;
  const path = join(home, name);
  await replace(path, adding(files[name] ?? ""));
  return path;
}

/** Removes the block from every startup file that has it; returns the files it edited. */
export async function removePathBlock(home: string): Promise<string[]> {
  const edited: string[] = [];
  for (const [name, contents] of Object.entries(await startupFiles(home))) {
    if (!contents.includes(PATH_BLOCK)) continue;
    await replace(join(home, name), removing(contents));
    edited.push(join(home, name));
  }
  return edited;
}

/** The startup files that exist under `home`, by name. */
async function startupFiles(home: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of STARTUP_FILES) { try { files[name] = await readFile(join(home, name), "utf8"); } catch { /* absent */ } }
  return files;
}

/**
 * Writes `contents` under a temporary name and renames it over `path`, keeping the file's mode, so a shell never reads
 * half a profile. A profile that is a link (a dotfiles checkout) is edited where it points, and stays a link.
 */
async function replace(link: string, contents: string): Promise<void> {
  const path = await realpath(link).catch(() => link);
  const staging = `${path}.localbox-${process.pid}`;
  const mode = await stat(path).then((info) => info.mode & 0o7777, () => 0o644);
  try { await writeFile(staging, contents, { mode }); await chmod(staging, mode); await rename(staging, path); }
  catch (error) { await rm(staging, { force: true }); throw error; }
}
