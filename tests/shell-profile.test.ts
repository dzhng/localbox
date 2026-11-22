import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPathBlock, adding, covered as anyCovers, loginFiles, PATH_BLOCK, removePathBlock, removing, target as targetFile } from "../apps/cli/src/shell-profile.js";

/** Whether the files a login `shell` reads, among `files`, already cover `~/.local/bin`. */
const covered = (files: Record<string, string>, shell = "/bin/zsh") => anyCovers(Object.fromEntries(Object.entries(files).filter(([name]) => loginFiles(shell).includes(name))));
const target = (shell: string, existing: string[] = []) => targetFile(shell, new Set(existing)) ?? "none";

test("an uncommented PATH .local/bin line in the login shell's own startup files suppresses the block", () => {
  const line = '  path=($HOME/bin $path)\n  export PATH="$HOME/.local/bin:$PATH"\n';
  for (const file of [".zshenv", ".zprofile"]) assert.equal(covered({ [file]: line }), true, file);
  for (const file of [".bash_profile", ".bash_login", ".profile"]) assert.equal(covered({ [file]: line }, "/bin/bash"), true, file);
});

test("startup files another shell reads do not count", () => {
  const line = 'export PATH="$HOME/.local/bin:$PATH"\n';
  assert.equal(covered({ ".bash_profile": line, ".profile": line }), false, "zsh ignores bash files");
  assert.equal(covered({ ".zshrc": line }, "/bin/bash"), false, "bash ignores zsh files");
  // Agents run non-interactive login shells (zsh -lc), which read neither rc file.
  assert.equal(covered({ ".zshrc": line }), false, "zsh -lc skips .zshrc");
  assert.equal(covered({ ".bashrc": line }, "/bin/bash"), false, "bash -lc skips .bashrc");
  assert.equal(covered({ ".zshrc": line, ".profile": line }, "/opt/homebrew/bin/fish"), false, "fish");
});

test("covered heuristics", () => {
  assert.equal(covered({ ".zprofile": "export PATH=~/.local/bin:$PATH" }), true);
  assert.equal(covered({ ".zshrc": "alias ll='ls -l'\n", ".profile": "" }), false);
  assert.equal(covered({ ".zprofile": 'export PATH="$HOME/bin:$PATH"\n' }), false, "PATH without .local/bin");
  assert.equal(covered({}), false);
});

test("a commented line does not count", () => {
  assert.equal(covered({ ".zprofile": '# export PATH="$HOME/.local/bin:$PATH"\n' }), false);
  assert.equal(covered({ ".zprofile": '   #export PATH="$HOME/.local/bin:$PATH"\n' }), false);
});

test("add is idempotent", () => {
  assert.equal(adding(""), PATH_BLOCK);
  const once = adding("export EDITOR=vim\n");
  assert.equal(once, `export EDITOR=vim\n${PATH_BLOCK}`);
  assert.equal(adding(once), once);
  assert.equal(adding("export EDITOR=vim"), `export EDITOR=vim\n${PATH_BLOCK}`);
});

test("remove deletes exactly the block", () => {
  const before = "export EDITOR=vim\n", after = "alias ll='ls -l'\n";
  assert.equal(removing(`${before}${PATH_BLOCK}${after}`), `${before}${after}`);
  assert.equal(removing(adding(before)), before);
  // A person's own lines that merely resemble the block stay.
  const own = 'export PATH="$HOME/.local/bin:$PATH"\n# <<< localbox <<<\n';
  assert.equal(removing(own), own);
});

test("bash edits the login file it already reads, never shadowing ~/.profile", () => {
  assert.equal(target("/bin/bash"), ".bash_profile");
  assert.equal(target("/opt/homebrew/bin/bash", [".profile"]), ".profile");
  assert.equal(target("/bin/bash", [".bash_login", ".profile"]), ".bash_login");
  assert.equal(target("/bin/bash", [".bash_profile", ".profile"]), ".bash_profile");
});

test("zsh targets .zprofile; other shells get no edit", () => {
  assert.equal(target("/bin/zsh"), ".zprofile");
  assert.equal(target(""), ".zprofile");
  assert.equal(target("/opt/homebrew/bin/fish"), "none");
});

test("a profile that is a link is edited where it points and stays a link", async () => {
  const home = await mkdtemp(join(tmpdir(), "localbox-shell-profile-"));
  await mkdir(join(home, "dotfiles")); await writeFile(join(home, "dotfiles/zprofile"), "export EDITOR=vim\n");
  await symlink(join(home, "dotfiles/zprofile"), join(home, ".zprofile"));
  assert.equal(await addPathBlock(home, "/bin/zsh"), join(home, ".zprofile"));
  assert.equal(lstatSync(join(home, ".zprofile")).isSymbolicLink(), true);
  assert.equal(await readFile(join(home, "dotfiles/zprofile"), "utf8"), `export EDITOR=vim\n${PATH_BLOCK}`);
  assert.deepEqual(await removePathBlock(home), [join(home, ".zprofile")]);
  assert.equal(await readFile(join(home, "dotfiles/zprofile"), "utf8"), "export EDITOR=vim\n");
  assert.equal(await addPathBlock(home, "/opt/homebrew/bin/fish"), null, "a shell Localbox doesn't configure is left alone");
});
