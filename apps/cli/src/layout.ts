import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appBundle } from "../../../packages/config/src/app-bundle.js";

/**
 * This CLI's own files. A compiled CLI runs from `<cli>/dist/apps/cli/src` with its skill, the pinned skills
 * installer and its revision (`<cli>/version`) beside it. Inside the app, `<cli>` is
 * `<X>.app/Contents/Resources/cli`: `app` is that bundle and `launcher` the bytes of the home command. A checkout runs
 * the TypeScript in `<repo>/apps/cli/src`: its revision is its package.json version and it has nothing to install.
 * Everything comes from this file's realpath, never from the environment, so a CLI started by another copy's CLI
 * still uses its own skill, and a home command that reaches the app through a link still finds the bundle.
 */
export interface Layout { skill: string; skillsInstaller: string; revision: string | null; app: string | null; launcher: string | null }

export function layout(): Layout {
  const here = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const compiled = basename(resolve(here, "../../..")) === "dist";
  const root = resolve(here, compiled ? "../../../.." : "../../..");
  if (!compiled) return { skill: join(root, "skills/localbox"), skillsInstaller: join(root, "node_modules/skills/bin/cli.mjs"), revision: version(join(root, "package.json")), app: null, launcher: null };
  const app = appBundle(fileURLToPath(import.meta.url))?.path ?? null;
  return { skill: join(root, "skill"), skillsInstaller: join(root, "skills-installer/bin/cli.mjs"), revision: text(join(root, "version")), app, launcher: app ? join(app, "Contents/Resources/bin/localbox") : null };
}

const version = (file: string): string | null => { try { return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? null; } catch { return null; } };
const text = (file: string): string | null => { try { return readFileSync(file, "utf8").trim() || null; } catch { return null; } };
