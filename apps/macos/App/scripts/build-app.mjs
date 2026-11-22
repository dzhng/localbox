#!/usr/bin/env node
// Assembles Localbox.app: the one definition of the bundle layout (specs/menu-bar-app, README "Contracts"). Slice 08
// builds the development bundle; slice 10 adds the release build (Sparkle, the release identity) to this same file.
//
//   node apps/macos/App/scripts/build-app.mjs [--out DIR] [--open]
//
// Expects `npm run build` to have run (the compiled CLI in dist/ and the launcher in dist/launcher). Writes
// `DIR/Localbox Dev.app` (default dist/app-dev), bundle id sh.localbox.mac.dev, no SUFeedURL, signed ad hoc with the
// daemon's virtualization entitlement. `--open` then starts it without focusing it. Prints the bundle's path.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const out = resolve(argument("--out") ?? join(root, "dist/app-dev"));
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options }).trim();
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

for (const built of ["dist/apps/cli/src/index.js", "dist/launcher/localbox"]) {
  if (!existsSync(join(root, built))) { process.stderr.write(`missing ${built}: run npm run build first\n`); process.exit(2); }
}

// Debug builds: the development bundle runs probes on the process-fixture backend, which release builds refuse.
const swift = (packagePath, product) => {
  run("swift", ["build", "--package-path", packagePath, "--product", product]);
  return join(run("swift", ["build", "--package-path", packagePath, "--show-bin-path"]), product);
};
const appBinary = swift("apps/macos/App", "Localbox");
const daemonBinary = swift("apps/macos/HostDaemon", "localbox-hostd");

const app = join(out, "Localbox Dev.app");
const staging = join(out, `.Localbox Dev.app.${process.pid}`);
rmSync(staging, { recursive: true, force: true });
const contents = join(staging, "Contents"), resources = join(contents, "Resources"), cli = join(resources, "cli");
for (const directory of [join(contents, "MacOS"), join(resources, "bin"), join(resources, "node/bin"), cli]) mkdirSync(directory, { recursive: true });

writeFileSync(join(contents, "Info.plist"), plist({
  CFBundleDevelopmentRegion: "en", CFBundleExecutable: "Localbox", CFBundleIdentifier: "sh.localbox.mac.dev",
  CFBundleInfoDictionaryVersion: "6.0", CFBundleName: "Localbox Dev", CFBundlePackageType: "APPL",
  CFBundleShortVersionString: version, CFBundleVersion: version, LSMinimumSystemVersion: "14.0", LSUIElement: true,
}));
cpSync(appBinary, join(contents, "MacOS/Localbox"));
cpSync(daemonBinary, join(contents, "MacOS/localbox-hostd"));
// The home command's bytes (AgentSetup copies them to ~/.local/bin/localbox for an app in an Applications folder).
cpSync(join(root, "dist/launcher/localbox"), join(resources, "bin/localbox"));

// The CLI: its entry beside the compiled JS, the package.json that makes dist/ ES modules, production node_modules,
// the skill and the pinned skills installer, and the revision the skill receipts compare against.
cpSync(join(root, "apps/macos/App/cli-entry.sh"), join(cli, "localbox")); chmodSync(join(cli, "localbox"), 0o755);
for (const part of ["apps", "packages", "scripts"]) cpSync(join(root, "dist", part), join(cli, "dist", part), { recursive: true });
cpSync(join(root, "package.json"), join(cli, "package.json"));
cpSync(productionModules(), join(cli, "node_modules"), { recursive: true, verbatimSymlinks: true });
cpSync(join(root, "skills/localbox"), join(cli, "skill"), { recursive: true });
cpSync(join(cli, "node_modules/skills"), join(cli, "skills-installer"), { recursive: true, filter: (path) => !/\/(node_modules|\.cache)$/.test(path) });
writeFileSync(join(cli, "version"), `${version}\n`);
cpSync(process.execPath, join(resources, "node/bin/node"));
cpSync(join(root, "skills/localbox/release-public.pem"), join(resources, "release-public.pem"));
// Sealed as resources, never re-signed, so the digests in agent-version.json stay true. Only when it was built
// (npm run build:guest-agent); without it the daemon keeps the agent each image carries.
if (existsSync(join(root, "dist/guest-agent/agent-version.json"))) cpSync(join(root, "dist/guest-agent"), join(resources, "guest-agent"), { recursive: true });

// Inside out, ad hoc (as scripts/proof/lib/sign-dev.sh): the daemon with its entitlement, Node without the hardened
// runtime so V8 can JIT, then the bundle, which seals everything else as resources.
run("codesign", ["--force", "--sign", "-", "--entitlements", join(root, "apps/macos/HostDaemon/Resources/localbox-hostd.entitlements"), join(contents, "MacOS/localbox-hostd")]);
run("codesign", ["--force", "--sign", "-", join(resources, "node/bin/node")]);
run("codesign", ["--force", "--sign", "-", staging]);
run("codesign", ["--verify", "--strict", staging]);

rmSync(app, { recursive: true, force: true });
renameSync(staging, app);
process.stdout.write(`${app}\n`);
if (process.argv.includes("--open")) run("/usr/bin/open", ["-g", app]);

/**
 * The CLI's production dependencies, installed once per lockfile into dist/app-cache (as scripts/release.sh installs
 * them for the release), so a rebuild copies them instead of reinstalling.
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

function plist(values) {
  const entry = ([key, value]) => `  <key>${key}</key>\n  ${typeof value === "boolean" ? `<${value}/>` : `<string>${value}</string>`}`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${Object.entries(values).map(entry).join("\n")}\n</dict>\n</plist>\n`;
}
