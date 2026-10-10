import test from "node:test";
import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillManager } from "../apps/cli/src/skill-manager.js";

test("skill manager stages a complete bundle, verifies discovery paths, and records ownership", async () => {
  const home = await mkdtemp(join(tmpdir(), "localbox-skill-home-"));
  const source = await mkdtemp(join(tmpdir(), "localbox-skill-source-"));
  await writeFile(join(source, "SKILL.md"), await readFile(join(process.cwd(), "skills/localbox/SKILL.md"), "utf8"));
  const run = async (_executable: string, args: string[]) => {
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
  const manager = new SkillManager({ home, source, npxPath: "/fake/npx", run });
  const installed = await manager.install();
  assert.equal(installed.state, "installed");
  assert.equal(installed.managed, true);
  assert.equal(installed.paths.length, 3);
  assert.match(await readFile(join(home, ".config/localbox/skill-install.json"), "utf8"), /"managed": true/);
  const removed = await manager.uninstall();
  assert.equal(removed.state, "disabled");
});

test("skill manager keeps unmanaged skills intact when disabling maintenance", async () => {
  const home = await mkdtemp(join(tmpdir(), "localbox-skill-unmanaged-"));
  await mkdir(join(home, ".agents/skills/localbox"), { recursive: true });
  const manager = new SkillManager({ home, npxPath: "/fake/npx", run: async () => ({ code: 1, output: "offline" }) });
  const result = await manager.uninstall();
  assert.equal(result.state, "disabled");
  await lstat(join(home, ".agents/skills/localbox/SKILL.md")).catch((error) => assert.equal(error.code, "ENOENT"));
});
