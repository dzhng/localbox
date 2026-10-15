import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This CLI's own files. A release CLI runs compiled from `<cli>/dist/apps/cli/src` with its skill, the pinned skills
 * installer and the install scripts beside it (scripts/release.sh); installed, `<cli>` is
 * `<releases>/<version>/localbox-cli` next to that version's `release.json`, and the `localbox` link points through
 * `<releases>/active`. A checkout runs the TypeScript in `<repo>/apps/cli/src`: its revision is its package.json
 * version and it has nothing to link. Everything comes from where this file is, never from the environment, so a CLI
 * started by another release's CLI (an update) still uses its own skill.
 */
export interface Layout { skill: string; skillsInstaller: string; installer: string; revision: string | null; cli: string | null }

export function layout(): Layout {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = basename(resolve(here, "../../..")) === "dist";
  const root = resolve(here, compiled ? "../../../.." : "../../..");
  const installer = join(root, "scripts/install-release.sh");
  if (!compiled) return { skill: join(root, "skills/localbox"), skillsInstaller: join(root, "node_modules/skills/bin/cli.mjs"), installer, revision: version(join(root, "package.json")), cli: null };
  const releases = dirname(dirname(root)), manifest = join(dirname(root), "release.json");
  return {
    skill: join(root, "skill"), skillsInstaller: join(root, "skills-installer/bin/cli.mjs"), installer,
    revision: existsSync(manifest) ? version(manifest) : null,
    cli: existsSync(manifest) && existsSync(join(releases, "active")) ? join(releases, "active/localbox-cli/bin/localbox") : null,
  };
}

const version = (file: string): string | null => { try { return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? null; } catch { return null; } };
