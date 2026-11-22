import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { PROTOCOL_VERSION, RELEASE_ID } from "../packages/contract/src/index.js";

// The launcher is compiled here with a scratch account home and Applications folder, so no test touches the real
// `~/Library/Caches` or `/Applications`.
let scratch: string, launcher: string, holder: string, account: string, system: string;
const lock = () => join(account, "Library/Caches/sh.localbox.mac/launch.lock");

before(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "localbox-launcher-")));
  account = join(scratch, "account"); system = join(scratch, "SystemApplications");
  mkdirSync(account); mkdirSync(system);
  launcher = join(scratch, "localbox"); holder = join(scratch, "holder");
  execFileSync("cc", ["-Wall", "-Werror", `-DLOCALBOX_ACCOUNT_HOME="${account}"`, `-DLOCALBOX_SYSTEM_APPLICATIONS="${system}"`, "-o", launcher, join(process.cwd(), "apps/macos/App/launcher/main.c")]);
  // What an updater does to the lock: `holder PATH ex` holds it exclusively until stdin closes; `try-ex` asks once.
  writeFileSync(join(scratch, "holder.c"), `#include <sys/file.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int fd = open(argv[1], O_CREAT | O_RDWR, 0600);
  if (!strcmp(argv[2], "try-ex")) return flock(fd, LOCK_EX | LOCK_NB) == 0 ? 0 : 1;
  flock(fd, LOCK_EX); puts("held"); fflush(stdout);
  char byte; while (read(0, &byte, 1) > 0) {}
  return 0;
}
`);
  execFileSync("cc", ["-o", holder, join(scratch, "holder.c")]);
});
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A hand-assembled Localbox.app at `folder` whose CLI entry prints what it was given, then runs `then`. */
function bundle(folder: string, then = ""): string {
  const app = join(folder, "Localbox.app"), cli = join(app, "Contents/Resources/cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "localbox"), `#!/bin/sh\necho "app=$LOCALBOX_APP self=$0 args=$* lock=$LOCALBOX_LAUNCH_LOCK fd=$LOCALBOX_LAUNCH_LOCK_FD"\n${then}\n`);
  chmodSync(join(cli, "localbox"), 0o755);
  return app;
}
const home = () => { const path = mkdtempSync(join(scratch, "home-")); return path; };
const run = (env: NodeJS.ProcessEnv, args = ["help"]) => spawnSync(launcher, args, { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", input: "", timeout: 10_000 });

test("with the lock free the launcher runs the app's CLI, holding the shared lock for the CLI's whole life", async () => {
  // The fake CLI stays running until its stdin closes.
  const user = home(), app = bundle(join(user, "Applications"), "read line || true");
  const child = spawn(launcher, ["sandbox", "list", "--json"], { env: { PATH: process.env.PATH, HOME: user }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    let out = ""; child.stdout.on("data", (chunk) => { out += chunk; });
    while (!out.includes("\n") && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(out.trim(), `app=${app} self=${join(app, "Contents/Resources/cli/localbox")} args=sandbox list --json lock=${lock()} fd=${out.match(/fd=(\d+)/)?.[1]}`);
    assert.equal(spawnSync(holder, [lock(), "try-ex"], { timeout: 10_000 }).status, 1, "an updater cannot take the lock while the CLI runs");
    // Shared: a second CLI runs alongside the first.
    assert.equal(run({ HOME: user }, ["status"]).status, 0);
  } finally { child.stdin.end(); await exited; }
  assert.equal(spawnSync(holder, [lock(), "try-ex"], { timeout: 10_000 }).status, 0, "the lock is free once the CLI exits");
});

test("while an update holds the lock exclusively the launcher exits 75 with the CLI's retryable failure envelope", async () => {
  const user = home(); bundle(join(user, "Applications"));
  const update = spawn(holder, [lock(), "ex"], { stdio: ["pipe", "pipe", "inherit"], timeout: 10_000 });
  try {
    await once(update.stdout, "data");
    const refused = run({ HOME: user });
    assert.equal(refused.status, 75);
    assert.deepEqual(JSON.parse(refused.stdout), {
      protocol_version: PROTOCOL_VERSION, request_id: "launcher", operation: "launcher", sandbox_id: null, release_id: RELEASE_ID,
      ok: false, error: { code: "conflict", message: "Localbox is updating; try again in a moment", retryable: true },
    });
    assert.equal(refused.stderr, "conflict: Localbox is updating; try again in a moment\n");
  } finally { update.stdin.end(); await once(update, "exit"); }
});

test("the app is $LOCALBOX_APP, then ~/Applications/Localbox.app, then the system Applications folder", () => {
  const user = home(), chosen = bundle(join(scratch, "chosen")), systemApp = bundle(system);
  assert.match(run({ HOME: user }).stdout, new RegExp(`^app=${systemApp} `), "only the system copy exists");
  const own = bundle(join(user, "Applications"));
  assert.match(run({ HOME: user }).stdout, new RegExp(`^app=${own} `), "the home copy wins over the system one");
  assert.match(run({ HOME: user, LOCALBOX_APP: chosen }).stdout, new RegExp(`^app=${chosen} `), "an explicit app wins over both");
  rmSync(systemApp, { recursive: true });
});

test("with no app anywhere the launcher refuses, and a lock that is not private is never used", () => {
  const missing = run({ HOME: home() });
  assert.equal(missing.status, 69);
  const envelope = JSON.parse(missing.stdout);
  assert.equal(envelope.error.code, "internal"); assert.match(envelope.error.message, /Localbox\.app was not found in ~\/Applications or \/Applications/);
  chmodSync(lock(), 0o644);
  try {
    const user = home(); bundle(join(user, "Applications"));
    const exposed = run({ HOME: user });
    assert.equal(exposed.status, 74); assert.match(JSON.parse(exposed.stdout).error.message, /not a private file/);
  } finally { chmodSync(lock(), 0o600); }
});
