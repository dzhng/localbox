import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appBundle } from "../../../packages/config/src/app-bundle.js";

/**
 * This CLI's own files. A compiled CLI runs from `<cli>/dist/apps/cli/src` with its skill and the pinned skills
 * installer beside it. Inside the app, `<cli>` is `<X>.app/Contents/Resources/cli`: `app` is that bundle, `launcher`
 * the bytes of the home command, and the revision is `<cli>/version`. In the old install (deleted by slice 10 of
 * specs/menu-bar-app), `<cli>` is `<releases>/<version>/localbox-cli` next to that version's `release.json`, and the
 * `localbox` link points through `<releases>/active`. A checkout runs the TypeScript in `<repo>/apps/cli/src`: its
 * revision is its package.json version and it has nothing to install. Everything comes from this file's realpath,
 * never from the environment, so a CLI started by another copy's CLI still uses its own skill, and a home command
 * that reaches the app through a link still finds the bundle.
 */
export interface Layout {
  skill: string; skillsInstaller: string; installer: string; revision: string | null;
  /** The old install's link target, `<releases>/active/localbox-cli/bin/localbox`. */
  cli: string | null;
  app: string | null; launcher: string | null;
}

export function layout(): Layout {
  const here = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const compiled = basename(resolve(here, "../../..")) === "dist";
  const root = resolve(here, compiled ? "../../../.." : "../../..");
  const installer = join(root, "scripts/install-release.sh");
  if (!compiled) return { skill: join(root, "skills/localbox"), skillsInstaller: join(root, "node_modules/skills/bin/cli.mjs"), installer, revision: version(join(root, "package.json")), cli: null, app: null, launcher: null };
  const shipped = { skill: join(root, "skill"), skillsInstaller: join(root, "skills-installer/bin/cli.mjs"), installer };
  const app = appBundle(fileURLToPath(import.meta.url))?.path ?? null;
  if (app) return { ...shipped, revision: text(join(root, "version")), cli: null, app, launcher: join(app, "Contents/Resources/bin/localbox") };
  const releases = dirname(dirname(root)), manifest = join(dirname(root), "release.json");
  return {
    ...shipped,
    revision: existsSync(manifest) ? version(manifest) : null,
    cli: existsSync(manifest) && existsSync(join(releases, "active")) ? join(releases, "active/localbox-cli/bin/localbox") : null,
    app: null, launcher: null,
  };
}

const version = (file: string): string | null => { try { return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? null; } catch { return null; } };
const text = (file: string): string | null => { try { return readFileSync(file, "utf8").trim() || null; } catch { return null; } };
