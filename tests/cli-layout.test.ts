import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Layout } from "../apps/cli/src/layout.js";

/** `apps/cli/src/layout.ts` placed at `dir` inside a fake tree, as that tree's CLI would load it; `via` is the path it is loaded through. */
async function layoutAt(dir: string, via = dir): Promise<Layout> {
  await mkdir(dir, { recursive: true });
  await copyFile(join(process.cwd(), "apps/cli/src/layout.ts"), join(dir, "layout.ts"));
  return (await import(join(via, "layout.ts")) as { layout(): Layout }).layout();
}

// An update runs the new release's CLI from the old one's, so nothing may come from an inherited environment.
test("an installed release CLI uses the skill and installer beside it and its release's version", async () => {
  const releases = join(await realpath(await mkdtemp(join(tmpdir(), "localbox-layout-"))), "releases");
  const cli = join(releases, "0.2.0/localbox-cli");
  await mkdir(join(releases, "active"), { recursive: true }); await mkdir(cli, { recursive: true });
  await writeFile(join(releases, "0.2.0/release.json"), JSON.stringify({ version: "0.2.0" }));
  assert.deepEqual(await layoutAt(join(cli, "dist/apps/cli/src")), {
    skill: join(cli, "skill"), skillsInstaller: join(cli, "skills-installer/bin/cli.mjs"), installer: join(cli, "scripts/install-release.sh"),
    revision: "0.2.0", cli: join(releases, "active/localbox-cli/bin/localbox"), app: null, launcher: null,
  });
});

test("a CLI inside Localbox.app knows its bundle from its realpath, even loaded through a link", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "localbox-layout-app-")));
  const app = join(base, "Applications/Localbox.app"), cli = join(app, "Contents/Resources/cli");
  await mkdir(cli, { recursive: true }); await writeFile(join(cli, "version"), "0.4.0\n");
  await symlink(join(cli, "dist"), join(base, "linked-dist"));
  assert.deepEqual(await layoutAt(join(cli, "dist/apps/cli/src"), join(base, "linked-dist/apps/cli/src")), {
    skill: join(cli, "skill"), skillsInstaller: join(cli, "skills-installer/bin/cli.mjs"), installer: join(cli, "scripts/install-release.sh"),
    revision: "0.4.0", cli: null, app, launcher: join(app, "Contents/Resources/bin/localbox"),
  });
});

test("a checkout uses the repo's skill and installer, its package.json version, and has nothing to install", async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "localbox-layout-checkout-")));
  await writeFile(join(repo, "package.json"), JSON.stringify({ version: "0.3.0" }));
  assert.deepEqual(await layoutAt(join(repo, "apps/cli/src")), {
    skill: join(repo, "skills/localbox"), skillsInstaller: join(repo, "node_modules/skills/bin/cli.mjs"), installer: join(repo, "scripts/install-release.sh"),
    revision: "0.3.0", cli: null, app: null, launcher: null,
  });
});
