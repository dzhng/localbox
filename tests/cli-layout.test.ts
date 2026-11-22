import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Layout } from "../apps/cli/src/layout.js";

/**
 * `apps/cli/src/layout.ts` placed at `dir` inside a fake tree, as that tree's CLI would load it (with the bundle
 * detection it imports at the same relative place); `via` is the path it is loaded through.
 */
async function layoutAt(dir: string, via = dir): Promise<Layout> {
  const config = join(dir, "../../../packages/config/src");
  await mkdir(dir, { recursive: true }); await mkdir(config, { recursive: true });
  await copyFile(join(process.cwd(), "apps/cli/src/layout.ts"), join(dir, "layout.ts"));
  await copyFile(join(process.cwd(), "packages/config/src/app-bundle.ts"), join(config, "app-bundle.ts"));
  return (await import(join(via, "layout.ts")) as { layout(): Layout }).layout();
}

// A CLI started by another copy's CLI inherits its environment, so nothing may come from it.
test("a CLI inside Localbox.app knows its bundle from its realpath, even loaded through a link", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "localbox-layout-app-")));
  const app = join(base, "Applications/Localbox.app"), cli = join(app, "Contents/Resources/cli");
  await mkdir(cli, { recursive: true }); await writeFile(join(cli, "version"), "0.4.0\n");
  await symlink(join(cli, "dist"), join(base, "linked-dist"));
  assert.deepEqual(await layoutAt(join(cli, "dist/apps/cli/src"), join(base, "linked-dist/apps/cli/src")), {
    skill: join(cli, "skill"), skillsInstaller: join(cli, "skills-installer/bin/cli.mjs"),
    revision: "0.4.0", app, launcher: join(app, "Contents/Resources/bin/localbox"), publicKey: join(app, "Contents/Resources/release-public.pem"),
  });
});

test("a checkout uses the repo's skill and installer, its package.json version, and has nothing to install", async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "localbox-layout-checkout-")));
  await writeFile(join(repo, "package.json"), JSON.stringify({ version: "0.3.0" }));
  assert.deepEqual(await layoutAt(join(repo, "apps/cli/src")), {
    skill: join(repo, "skills/localbox"), skillsInstaller: join(repo, "node_modules/skills/bin/cli.mjs"),
    revision: "0.3.0", app: null, launcher: null, publicKey: join(repo, "skills/localbox/release-public.pem"),
  });
});
