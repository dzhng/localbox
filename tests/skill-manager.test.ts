import test from "node:test";
import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SkillManager } from "../apps/cli/src/skill-manager.js";

const execFileAsync = promisify(execFile);

test("the pinned skills installer runs from the release dependency without npx", async () => {
  const root = await mkdtemp(join(tmpdir(), "localbox-bundled-skills-"));
  const home = join(root, "home");
  const source = join(root, "source");
  const bin = join(root, "bin");
  await mkdir(home); await mkdir(source); await mkdir(bin);
  await writeFile(join(source, "SKILL.md"), "---\nname: localbox\ndescription: fixture\n---\n\nFixture.\n");
  const npx = join(bin, "npx");
  await writeFile(npx, "#!/bin/sh\necho npx-was-run >&2\nexit 1\n"); await chmod(npx, 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const installer = join(process.cwd(), "node_modules/skills/bin/cli.mjs");
  await execFileAsync(process.execPath, [installer, "add", source, "--all", "--global", "--yes"], { env, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(await readFile(join(home, ".agents/skills/localbox/SKILL.md"), "utf8"), await readFile(join(source, "SKILL.md"), "utf8"));
});

test("skill manager stages a complete bundle, verifies discovery paths, and records ownership", async () => {
  const home = await mkdtemp(join(tmpdir(), "localbox-skill-home-"));
  const source = await mkdtemp(join(tmpdir(), "localbox-skill-source-"));
  await writeFile(join(source, "SKILL.md"), await readFile(join(process.cwd(), "skills/localbox/SKILL.md"), "utf8"));
  const calls: { executable: string; args: string[] }[] = [];
  const run = async (executable: string, args: string[]) => {
    calls.push({ executable, args });
    if (args.includes("ls")) {
      const entries = [".agents/skills/localbox", ".codex/skills/localbox", ".claude/skills/localbox"];
      return { code: 0, output: JSON.stringify((await Promise.all(entries.map(async (relative) => {
        const path = join(home, relative);
        try { await lstat(path); return { name: "localbox", path, scope: "global", source: "fixture" }; } catch { return undefined; }
      }))).filter(Boolean)) };
    }
    if (args.includes("add")) {
      const canonical = join(home, ".agents/skills/localbox");
      await mkdir(join(home, ".agents/skills"), { recursive: true });
      await cp(source, canonical, { recursive: true });
      await mkdir(join(home, ".codex/skills"), { recursive: true });
      await mkdir(join(home, ".claude/skills"), { recursive: true });
      await symlink(canonical, join(home, ".codex/skills/localbox"));
      await symlink(canonical, join(home, ".claude/skills/localbox"));
    }
    return { code: 0, output: "" };
  };
  const manager = new SkillManager({ home, source, nodePath: process.execPath, installerPath: join(process.cwd(), "node_modules/skills/bin/cli.mjs"), run });
  const installed = await manager.install();
  assert.equal(installed.state, "installed");
  assert.equal(installed.managed, true);
  assert.equal(installed.paths.length, 3);
  assert.equal(calls[0]?.executable, process.execPath);
  assert.equal(calls[0]?.args[0], join(process.cwd(), "node_modules/skills/bin/cli.mjs"));
  assert.equal(calls.some(({ args }) => args.includes("npx")), false);
  assert.match(await readFile(join(home, ".config/localbox/skill-install.json"), "utf8"), /"managed": true/);
  const removed = await manager.uninstall();
  assert.equal(removed.state, "disabled");
});

test("skill manager keeps unmanaged skills intact when disabling maintenance", async () => {
  const home = await mkdtemp(join(tmpdir(), "localbox-skill-unmanaged-"));
  await mkdir(join(home, ".agents/skills/localbox"), { recursive: true });
  const manager = new SkillManager({ home, nodePath: process.execPath, installerPath: join(process.cwd(), "node_modules/skills/bin/cli.mjs"), run: async () => ({ code: 1, output: "offline" }) });
  const result = await manager.uninstall();
  assert.equal(result.state, "disabled");
  await lstat(join(home, ".agents/skills/localbox/SKILL.md")).catch((error) => assert.equal(error.code, "ENOENT"));
});
