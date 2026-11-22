import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { before, test } from "node:test";
import { temporary } from "./driver.mjs";

// The assembler is the one definition of the bundle layout. This builds the development bundle (signed ad hoc by
// sign.mjs, as every build is signed) and checks what other code relies on: the Info.plist keys, the launch lock's one
// source, the pinned key, the sealed guest agent and where the signature puts identifiers and the entitlement.
// Needs `npm run build` (and, for the guest agent, `npm run build:guest-agent`).
const root = resolve(new URL("../../../..", import.meta.url).pathname);
const guestAgent = join(root, "dist/guest-agent/agent-version.json");
let app;
before(() => {
  const out = temporary("lb-build-app-");
  app = execFileSync("node", [join(root, "apps/macos/App/scripts/build-app.mjs"), "--out", out, "--version", "9.8.7"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").at(-1);
});
const contents = (path) => join(app, "Contents", path);
const info = (key) => spawnSync("plutil", ["-extract", key, "raw", "-o", "-", contents("Info.plist")], { encoding: "utf8" }).stdout.trim();
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const signature = (path) => spawnSync("codesign", ["-dvv", path], { encoding: "utf8" }).stderr;

test("Info.plist names the dev build, its version, macOS 14 and the launcher's own lock path", () => {
  assert.deepEqual(["CFBundleIdentifier", "CFBundleName", "CFBundleExecutable", "CFBundleShortVersionString", "LSMinimumSystemVersion", "LSUIElement"].map(info), ["sh.localbox.mac.dev", "Localbox Dev", "Localbox", "9.8.7", "14.0", "true"]);
  assert.equal(info("SUFeedURL"), "", "a development build has no update feed");
  const lock = info("LocalboxLaunchLockRelativePath");
  assert.equal(lock, /#define LOCALBOX_LAUNCH_LOCK_RELATIVE_PATH "([^"]+)"/.exec(readFileSync(join(root, "apps/macos/App/launcher/main.c"), "utf8"))[1]);
  assert.ok(readFileSync(contents("Resources/bin/localbox")).includes(Buffer.from(`${lock}\0`)), "the launcher built into the bundle holds that path");
});

test("the CLI's revision is the bundle's version and the bundle pins the skill's release key", () => {
  assert.equal(readFileSync(contents("Resources/cli/version"), "utf8"), "9.8.7\n");
  assert.equal(readFileSync(contents("Resources/release-public.pem"), "utf8"), readFileSync(join(root, "skills/localbox/release-public.pem"), "utf8"));
  assert.ok(!existsSync(contents("Resources/cli/dist/scripts/proof")), "proof helpers never ship");
});

test("the guest agent is sealed as built: its digests are agent-version.json's", { skip: existsSync(guestAgent) ? false : "npm run build:guest-agent has not run" }, () => {
  const version = JSON.parse(readFileSync(contents("Resources/guest-agent/agent-version.json"), "utf8"));
  for (const os of ["linux", "darwin"]) assert.equal(digest(contents(`Resources/guest-agent/localbox-agent-${os}-arm64`)), version.sha256[os], os);
  for (const file of readdirSync(join(root, "dist/guest-agent/darwin"))) assert.equal(digest(contents(`Resources/guest-agent/darwin/${file}`)), digest(join(root, "dist/guest-agent/darwin", file)), file);
});

test("without LOCALBOX_SPARKLE_FRAMEWORK the app neither links nor carries Sparkle", () => {
  assert.ok(!existsSync(contents("Frameworks")));
  assert.doesNotMatch(execFileSync("otool", ["-L", contents("MacOS/Localbox")], { encoding: "utf8" }), /Sparkle/);
});

const framework = join(root, "dist/sparkle/Sparkle.framework");
test("with the patched framework the app links it from Contents/Frameworks, signed inside out; a dev build still has no feed", { skip: existsSync(framework) ? false : "npm run sparkle:build has not run" }, () => {
  const out = temporary("lb-build-app-sparkle-");
  const built = execFileSync("node", [join(root, "apps/macos/App/scripts/build-app.mjs"), "--out", out], { cwd: root, encoding: "utf8", env: { ...process.env, LOCALBOX_SPARKLE_FRAMEWORK: framework }, stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").at(-1);
  const inside = (path) => join(built, "Contents", path);
  assert.match(execFileSync("otool", ["-L", inside("MacOS/Localbox")], { encoding: "utf8" }), /@rpath\/Sparkle\.framework\/Versions\/B\/Sparkle/);
  for (const nested of ["Frameworks/Sparkle.framework", "Frameworks/Sparkle.framework/Versions/B/Updater.app", "Frameworks/Sparkle.framework/Versions/B/Autoupdate"])
    execFileSync("codesign", ["--verify", "--strict", inside(nested)]);
  execFileSync("codesign", ["--verify", "--deep", "--strict", built]);
  assert.equal(spawnSync("plutil", ["-extract", "SUFeedURL", "raw", "-o", "-", inside("Info.plist")], { encoding: "utf8" }).stdout.trim(), "");
  // The patch under Localbox's names: the Info.plist key the helper reads and the relaunch argument.
  assert.ok(readFileSync(inside("Frameworks/Sparkle.framework/Versions/B/Autoupdate")).includes(Buffer.from("LocalboxLaunchLockRelativePath")));
  assert.ok(readFileSync(inside("Frameworks/Sparkle.framework/Versions/B/Updater.app/Contents/MacOS/Updater")).includes(Buffer.from("--localbox-update-relaunch")));
});

test("signed inside out: the CLI's identifier on the launcher and Node, the entitlement on the daemon alone", () => {
  execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
  for (const file of ["Resources/bin/localbox", "Resources/node/bin/node"]) assert.match(signature(contents(file)), /^Identifier=sh\.localbox\.cli$/m, file);
  assert.match(signature(app), /^Identifier=sh\.localbox\.mac\.dev$/m);
  const entitlements = (file) => spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", contents(file)], { encoding: "utf8" }).stdout;
  assert.match(entitlements("MacOS/localbox-hostd"), /com\.apple\.security\.virtualization/);
  for (const file of ["MacOS/Localbox", "Resources/bin/localbox", "Resources/node/bin/node"]) assert.doesNotMatch(entitlements(file), /virtualization/, file);
});
