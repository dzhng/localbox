#!/usr/bin/env node
// Assembles Localbox.app: the one definition of the bundle layout, for the development build and the release.
//
//   node apps/macos/App/scripts/build-app.mjs [--release] [--out DIR] [--version V] [--node PATH] [--public-key PEM] [--open]
//
// Expects `npm run build` to have run (the compiled CLI in dist/ and the launcher in dist/launcher); a release also
// needs `npm run build:guest-agent`. Prints the bundle's path.
//
// - Development (default): `DIR/Localbox Dev.app` (default dist/app-dev), bundle id sh.localbox.mac.dev, debug Swift
//   builds (probes run the daemon on the process fixture, which release builds refuse), no update feed, the guest
//   agent only if it was built, signed ad hoc. `--open` then starts it without focusing it.
// - `--release`: `DIR/Localbox.app` (default dist/app-release), bundle id sh.localbox.mac, release Swift builds,
//   Sparkle and its update feed, the guest agent required, and unsigned: the release's build stage
//   (scripts/release/build.ts) signs it with sign.mjs.
//
// `--version` replaces package.json's version, `--node` the running Node, `--public-key` the skill's
// release-public.pem (a scratch release signed with a scratch key carries that key; it is also the update feed's key,
// `SUPublicEDKey`).
//
// Sparkle: with LOCALBOX_SPARKLE_FRAMEWORK naming the patched framework (`npm run sparkle:build`), the app links it
// and the bundle carries it in Contents/Frameworks, after its build receipt is checked against the pin. A release
// always does (dist/sparkle/Sparkle.framework when the variable is unset) and adds Sparkle's Info.plist keys; a
// development build without the variable cannot update itself.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { frameworkProblem } from "../sparkle/framework.mjs";
import { signApp } from "./sign.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const release = process.argv.includes("--release");
const out = resolve(argument("--out") ?? join(root, release ? "dist/app-release" : "dist/app-dev"));
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options }).trim();
const fail = (message) => { process.stderr.write(`build-app.mjs: ${message}\n`); process.exit(2); };
const version = argument("--version") ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const node = resolve(argument("--node") ?? process.execPath);
const publicKey = resolve(argument("--public-key") ?? join(root, "skills/localbox/release-public.pem"));
const name = release ? "Localbox" : "Localbox Dev";
const guestAgent = join(root, "dist/guest-agent");

/** The update feed; the app treats a bundle with one as a release. apps/site redirects it to the latest release's asset. */
const FEED_URL = "https://localbox.sh/mac/appcast.xml";
/** The launch lock's path under the account home has one source, the launcher; the Info.plist key is copied from it. */
const launchLock = /#define LOCALBOX_LAUNCH_LOCK_RELATIVE_PATH "([^"]+)"/.exec(readFileSync(join(root, "apps/macos/App/launcher/main.c"), "utf8"))?.[1] ?? fail("main.c defines no LOCALBOX_LAUNCH_LOCK_RELATIVE_PATH");

if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) fail(`invalid version ${version}`);
for (const built of ["dist/apps/cli/src/index.js", "dist/launcher/localbox", "dist/scripts/appcast.js"]) if (!existsSync(join(root, built))) fail(`missing ${built}: run npm run build first`);
const sparkle = process.env.LOCALBOX_SPARKLE_FRAMEWORK || (release ? join(root, "dist/sparkle/Sparkle.framework") : undefined);
if (sparkle) verifyFramework(resolve(sparkle));
if (release) {
  if (!existsSync(join(guestAgent, "agent-version.json"))) fail("missing dist/guest-agent: run npm run build:guest-agent first");
  // The bundled Node must run on any Mac: an arm64 build linked only against the system's libraries (nvm's and
  // nodejs.org's are; Homebrew's links its own).
  if (!/arm64/.test(run("file", ["-b", node]))) fail(`${node} is not an arm64 executable`);
  const foreign = run("otool", ["-L", node]).split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter((library) => library && !/^\/(System\/Library|usr\/lib)\//.test(library));
  if (foreign.length) fail(`${node} links libraries a stock Mac lacks: ${foreign.join(", ")}`);
}

const swift = (packagePath, product, env = process.env) => {
  const configuration = release ? ["-c", "release"] : [];
  run("swift", ["build", "--package-path", packagePath, "--product", product, ...configuration], { env });
  return join(run("swift", ["build", "--package-path", packagePath, "--show-bin-path", ...configuration], { env }), product);
};
// The app links Sparkle exactly when this bundle carries it (Package.swift reads the variable).
const { LOCALBOX_SPARKLE_FRAMEWORK: _, ...withoutSparkle } = process.env;
const appBinary = swift("apps/macos/App", "Localbox", sparkle ? { ...process.env, LOCALBOX_SPARKLE_FRAMEWORK: resolve(sparkle) } : withoutSparkle);
const daemonBinary = swift("apps/macos/HostDaemon", "localbox-hostd");
const { sparklePublicKey } = await import(pathToFileURL(join(root, "dist/scripts/appcast.js")).href);

const app = join(out, `${name}.app`);
const staging = join(out, `.${name}.app.${process.pid}`);
rmSync(staging, { recursive: true, force: true });
const contents = join(staging, "Contents"), resources = join(contents, "Resources"), cli = join(resources, "cli");
for (const directory of [join(contents, "MacOS"), join(resources, "bin"), join(resources, "node/bin"), cli]) mkdirSync(directory, { recursive: true });

writeFileSync(join(contents, "Info.plist"), plist({
  CFBundleDevelopmentRegion: "en", CFBundleExecutable: "Localbox", CFBundleIdentifier: release ? "sh.localbox.mac" : "sh.localbox.mac.dev",
  CFBundleInfoDictionaryVersion: "6.0", CFBundleName: name, CFBundlePackageType: "APPL",
  CFBundleShortVersionString: version, CFBundleVersion: version, LSMinimumSystemVersion: "14.0", LSUIElement: true,
  LocalboxLaunchLockRelativePath: launchLock, ...(release ? sparkleKeys() : {}),
}));
cpSync(appBinary, join(contents, "MacOS/Localbox"));
if (sparkle) cpSync(resolve(sparkle), join(contents, "Frameworks/Sparkle.framework"), { recursive: true, verbatimSymlinks: true });
cpSync(daemonBinary, join(contents, "MacOS/localbox-hostd"));
// The home command's bytes (AgentSetup copies them to ~/.local/bin/localbox for an app in an Applications folder).
cpSync(join(root, "dist/launcher/localbox"), join(resources, "bin/localbox"));

// The CLI: its entry beside the compiled JS, the package.json that makes dist/ ES modules, production node_modules,
// the skill and the pinned skills installer, and the revision the skill receipts compare against.
cpSync(join(root, "apps/macos/App/cli-entry.sh"), join(cli, "localbox")); chmodSync(join(cli, "localbox"), 0o755);
// The proof harness's helpers compile into dist/scripts/proof only because tests import them; they never ship.
for (const part of ["apps", "packages", "scripts"]) cpSync(join(root, "dist", part), join(cli, "dist", part), { recursive: true, filter: (path) => !path.startsWith(join(root, "dist/scripts/proof")) });
cpSync(join(root, "package.json"), join(cli, "package.json"));
cpSync(productionModules(), join(cli, "node_modules"), { recursive: true, verbatimSymlinks: true });
cpSync(join(root, "skills/localbox"), join(cli, "skill"), { recursive: true });
cpSync(join(cli, "node_modules/skills"), join(cli, "skills-installer"), { recursive: true, filter: (path) => !/\/(node_modules|\.cache)$/.test(path) });
writeFileSync(join(cli, "version"), `${version}\n`);
cpSync(node, join(resources, "node/bin/node"));
cpSync(publicKey, join(resources, "release-public.pem"));
// The status item's art, once drawn; without it the app draws a placeholder symbol (LocalboxMenu's StatusIcon).
for (const art of ["StatusItem.pdf", "StatusItemWarning.pdf"]) if (existsSync(join(root, "apps/macos/App/art", art))) cpSync(join(root, "apps/macos/App/art", art), join(resources, art));
// The host's guest agent builds, sealed as resources and never re-signed, so the digests in agent-version.json stay
// true; the daemon pushes them into every guest running another build. A development build without them keeps the
// agent each image carries.
if (existsSync(join(guestAgent, "agent-version.json"))) cpSync(guestAgent, join(resources, "guest-agent"), { recursive: true });

if (!release) signApp(staging, { identity: "-" });
rmSync(app, { recursive: true, force: true });
renameSync(staging, app);
process.stdout.write(`${app}\n`);
if (process.argv.includes("--open") && !release) run("/usr/bin/open", ["-g", app]);

/**
 * The CLI's production dependencies, installed once per lockfile into dist/app-cache, so a rebuild copies them
 * instead of reinstalling.
 */
function productionModules() {
  const manifest = ["package.json", "package-lock.json"].map((file) => readFileSync(join(root, file))).reduce((hash, bytes) => hash.update(bytes), createHash("sha256")).digest("hex").slice(0, 16);
  const cache = join(root, "dist/app-cache", `cli-${manifest}`);
  if (!existsSync(join(cache, "node_modules/skills/bin/cli.mjs"))) {
    const partial = `${cache}.${process.pid}`;
    rmSync(partial, { recursive: true, force: true }); mkdirSync(partial, { recursive: true });
    for (const file of ["package.json", "package-lock.json"]) cpSync(join(root, file), join(partial, file));
    run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", "--workspaces=false"], { cwd: partial });
    rmSync(cache, { recursive: true, force: true }); renameSync(partial, cache);
  }
  return join(cache, "node_modules");
}

/**
 * Sparkle's keys: the feed and the key it must be signed with, a signed feed and a
 * verified archive required, hourly checks on by default, and Sparkle's own automatic installs off, since
 * `UpdateCoordinator` decides when to install.
 */
function sparkleKeys() {
  return {
    SUFeedURL: FEED_URL, SUPublicEDKey: sparklePublicKey(readFileSync(publicKey, "utf8")), SURequireSignedFeed: true, SUVerifyUpdateBeforeExtraction: true,
    SUSignedFeedFailureExpirationInterval: 0, SUEnableAutomaticChecks: true, SUScheduledCheckInterval: 3600,
    SUAllowsAutomaticUpdates: false, SUAutomaticallyUpdate: false,
  };
}

/** The framework `npm run sparkle:build` made from the pinned source and patch, unchanged since (its receipt). */
function verifyFramework(framework) {
  const problem = frameworkProblem(framework);
  if (problem) fail(problem);
}

function plist(values) {
  const value = (item) => typeof item === "boolean" ? `<${item}/>` : typeof item === "number" ? `<integer>${item}</integer>` : `<string>${item}</string>`;
  const entry = ([key, item]) => `  <key>${key}</key>\n  ${value(item)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${Object.entries(values).map(entry).join("\n")}\n</dict>\n</plist>\n`;
}
