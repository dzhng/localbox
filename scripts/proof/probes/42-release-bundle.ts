import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { sparklePublicKey, verifyAppcast } from "../../appcast.js";
import { sha256 } from "../../release.js";
import { writeImageFiles } from "../lib/images.js";
import { installationSteps, runSteps, serveRelease, trusting } from "../lib/installation.js";
import { buildRealVMs, realDaemon } from "../lib/real-daemon.js";
import { scratchIdentity } from "../lib/scratch-identity.js";

// The release. Tier a runs the release's build stage as a release is cut (`npm run release -- build --rehearsal`), with
// a scratch identity and a scratch manifest key (never the release credentials), then installs its output with the installation
// procedure's own blocks into a scratch HOME and checks what is new to Localbox in a signed bundle: the sealed guest
// agent, Node's JIT, the CLI identifiers and the daemon's entitlement. Tier v boots a real VM with the daemon from
// inside the signed bundle.
//
//   npm run proof -- 42 --tier a,v

export const id = "42";
export const tiers = ["a", "v"];

const VERSION = "0.42.0";
const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const pem = (key: ReturnType<typeof generateKeyPairSync>["publicKey"]) => key.export({ type: "spki", format: "pem" }).toString();
const codesign = (...args: string[]) => execFileSync("codesign", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** The signing identifier and first authority `codesign -dvv` prints (on stderr) for one file or bundle. */
const signatureOf = (path: string) => {
  const facts = spawnSync("codesign", ["-dvv", path], { encoding: "utf8" }).stderr;
  return { identifier: /^Identifier=(.*)$/m.exec(facts)?.[1], authority: /^Authority=(.*)$/m.exec(facts)?.[1] };
};

export async function run(ctx: ProofContext): Promise<Check[]> {
  return ctx.tier === "v" ? await bundledDaemon(ctx) : await release(ctx);
}

async function release(ctx: ProofContext): Promise<Check[]> {
  const checks: Check[] = [];
  const work = realpathSync(mkdtempSync("/tmp/lb42-"));
  const keys = generateKeyPairSync("ed25519");
  const signing = join(work, "signing"), out = join(work, "release"), image = join(work, "image");
  const home = join(work, "home"), temporary = join(work, "tmp");
  let server: Awaited<ReturnType<typeof serveRelease>> | undefined;
  const identity = scratchIdentity(signing);
  writeFileSync(join(signing, "release-private.pem"), keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(join(signing, "public.json"), JSON.stringify({ sha1: identity.sha1 }));
  writeFileSync(join(work, "release-public.pem"), pem(keys.publicKey));
  // A stand-in linux image (this tier boots no VM), packed the way the real one is.
  writeImageFiles(image, "linux", { bytes: 1024 * 1024 }, VERSION);
  const env = { IMAGE_DIGEST: `sha256:${"0".repeat(64)}`, LOCALBOX_IMAGE: image, LOCALBOX_SIGNING_DIR: signing };
  const releaseBuild = (args: string[], extra: NodeJS.ProcessEnv = {}) => ctx.exec("npx", ["tsx", "scripts/release/main.ts", "build", ...args], { env: { ...env, ...extra } });
  const app = join(home, "Applications/Localbox.app"), contents = join(app, "Contents");
  try {
    checks.push(await ctx.check("a real build refuses a manifest key other than the one installers pin, and a rehearsal key passed as the release's", async () => {
      const refused = await releaseBuild(["--out", join(work, "refused")]);
      assert.equal(refused.code, 1); assert.match(refused.stdout, /release-private\.pem is not the key installers trust/);
      const overridden = await releaseBuild(["--out", join(work, "refused")], { LOCALBOX_RELEASE_PUBLIC_KEY: join(work, "release-public.pem") });
      assert.equal(overridden.code, 1); assert.match(overridden.stdout, /Unset LOCALBOX_RELEASE_PUBLIC_KEY/);
    }));
    checks.push(await ctx.check("the rehearsal build writes the app zip, its appcast, the image parts, release.json and SHA256SUMS, and nothing else, and verifies them", async () => {
      const built = await releaseBuild(["--rehearsal", "--version", VERSION, "--out", out], { LOCALBOX_RELEASE_PUBLIC_KEY: join(work, "release-public.pem") });
      assert.equal(built.code, 0, `${built.stdout.slice(-1500)}${built.stderr.slice(-1500)}`);
      assert.match(built.stdout, /build passed/);
      const files = readdirSync(out).sort();
      assert.deepEqual(files.filter((name) => !name.startsWith(`localbox-linux-${VERSION}.`)), ["Localbox-macos-arm64.zip", "SHA256SUMS", "appcast.xml", "release.json"], files.join(", "));
      assert.ok(files.includes(`localbox-linux-${VERSION}.disk.img.zst.000`));
    }));
    checks.push(await ctx.check("appcast.xml is signed with the manifest's key and offers this release's zip, with the zip's own signature", async () => {
      const feed = verifyAppcast(readFileSync(join(out, "appcast.xml"), "utf8"), keys.publicKey);
      const zip = readFileSync(join(out, "Localbox-macos-arm64.zip"));
      assert.match(feed, new RegExp(`<sparkle:version>${VERSION.replaceAll(".", "\\.")}</sparkle:version>`));
      const enclosure = /<enclosure url="([^"]+)" length="(\d+)" type="application\/octet-stream" sparkle:edSignature="([^"]+)"\/>/.exec(feed);
      assert.ok(enclosure, feed);
      assert.equal(enclosure[1], `https://github.com/dzhng/localbox/releases/download/v${VERSION}/Localbox-macos-arm64.zip`);
      assert.equal(Number(enclosure[2]), zip.length);
      assert.ok(verify(null, zip, keys.publicKey, Buffer.from(enclosure[3], "base64")), "the zip's signature verifies with the release key");
    }));
    checks.push(await ctx.check("the installation procedure's download, verify and place steps install it into a scratch HOME; a tampered manifest is refused", async () => {
      server = await serveRelease(out);
      mkdirSync(temporary, { recursive: true });
      const steps = installationSteps(ctx.root);
      const env = { PATH: FINDER_PATH, HOME: home, TMPDIR: temporary, LOCALBOX_RELEASE_URL: server.url };
      const blocks = [steps.get(2)!, trusting(steps.get(3)!, pem(keys.publicKey)), steps.get(4)!];
      // The release's real pinned key refuses a scratch-key release.
      const pinned = await runSteps([steps.get(2)!, steps.get(3)!], env);
      assert.notEqual(pinned.code, 0); assert.match(pinned.output, /not signed by the pinned Localbox key/);
      const manifest = readFileSync(join(out, "release.json"), "utf8");
      writeFileSync(join(out, "release.json"), manifest.replace(`"version": "${VERSION}"`, `"version": "${VERSION}-tampered"`));
      const tampered = await runSteps(blocks, env);
      writeFileSync(join(out, "release.json"), manifest);
      assert.notEqual(tampered.code, 0); assert.match(tampered.output, /not signed by the pinned Localbox key/);
      assert.ok(!existsSync(app), "nothing was put in place");
      const installed = await runSteps(blocks, env);
      assert.equal(installed.code, 0, installed.output);
      assert.match(installed.output, new RegExp(`Localbox ${VERSION.replaceAll(".", "\\.")}: release\\.json is signed by the pinned key`));
      writeFileSync(join(ctx.evidence, "install.txt"), installed.output);
    }));
    checks.push(await ctx.check("after the zip round trip the bundle still verifies, signed by the release identity, inside out", async () => {
      codesign("--verify", "--deep", "--strict", app);
      for (const file of ["MacOS/Localbox", "MacOS/localbox-hostd", "Resources/bin/localbox", "Resources/node/bin/node"]) {
        codesign("--verify", "--strict", join(contents, file));
        assert.equal(signatureOf(join(contents, file)).authority, "Localbox Scratch", file);
      }
      assert.equal(signatureOf(app).identifier, "sh.localbox.mac");
      for (const file of ["Resources/bin/localbox", "Resources/node/bin/node"]) assert.equal(signatureOf(join(contents, file)).identifier, "sh.localbox.cli", file);
      const entitlements = (file: string) => execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", join(contents, file)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      assert.match(entitlements("MacOS/localbox-hostd"), /com\.apple\.security\.virtualization/);
      for (const file of ["MacOS/Localbox", "Resources/node/bin/node", "Resources/bin/localbox"]) assert.doesNotMatch(entitlements(file), /virtualization/, file);
      assert.equal(execFileSync("xattr", ["-r", app], { encoding: "utf8" }).includes("com.apple.quarantine"), false);
    }));
    checks.push(await ctx.check("Info.plist, the CLI's version, the pinned key and the launch lock come from their one source", async () => {
      const info = (key: string) => execFileSync("plutil", ["-extract", key, "raw", "-o", "-", join(contents, "Info.plist")], { encoding: "utf8" }).trim();
      assert.deepEqual(["CFBundleIdentifier", "CFBundleShortVersionString", "LSMinimumSystemVersion", "LSUIElement", "SUFeedURL"].map(info), ["sh.localbox.mac", VERSION, "14.0", "true", "https://localbox.sh/mac/appcast.xml"]);
      // Sparkle: the release key's public half, a signed feed and a verified archive required, hourly automatic
      // checks, and Sparkle's own automatic installs off (UpdateCoordinator decides).
      assert.equal(info("SUPublicEDKey"), sparklePublicKey(keys.publicKey.export({ type: "spki", format: "pem" }).toString()));
      assert.deepEqual(["SURequireSignedFeed", "SUVerifyUpdateBeforeExtraction", "SUEnableAutomaticChecks", "SUScheduledCheckInterval", "SUAllowsAutomaticUpdates", "SUAutomaticallyUpdate"].map(info),
        ["true", "true", "true", "3600", "false", "false"]);
      codesign("--verify", "--strict", join(contents, "Frameworks/Sparkle.framework"));
      assert.equal(signatureOf(join(contents, "Frameworks/Sparkle.framework")).authority, "Localbox Scratch");
      assert.ok(readFileSync(join(contents, "Frameworks/Sparkle.framework/Versions/B/Autoupdate")).includes(Buffer.from("LocalboxLaunchLockRelativePath")), "the patched Sparkle");
      const lock = info("LocalboxLaunchLockRelativePath");
      assert.equal(lock, "Library/Caches/sh.localbox.mac/launch.lock");
      assert.ok(readFileSync(join(contents, "Resources/bin/localbox")).includes(Buffer.from(`${lock}\0`)), "the launcher holds the same lock path");
      assert.equal(readFileSync(join(contents, "Resources/cli/version"), "utf8"), `${VERSION}\n`);
      assert.equal(readFileSync(join(contents, "Resources/release-public.pem"), "utf8"), pem(keys.publicKey), "the bundle pins the key its manifest is signed with");
    }));
    checks.push(await ctx.check("the guest agent is sealed, not re-signed: its digests are still agent-version.json's", async () => {
      const agent = join(contents, "Resources/guest-agent");
      const version = JSON.parse(readFileSync(join(agent, "agent-version.json"), "utf8"));
      for (const os of ["linux", "darwin"]) assert.equal(await sha256(join(agent, `localbox-agent-${os}-arm64`)), version.sha256[os], os);
      for (const file of readdirSync(join(agent, "darwin"))) assert.equal(await sha256(join(agent, "darwin", file)), await sha256(join(ctx.root, "dist/guest-agent/darwin", file)), `darwin/${file}`);
    }));
    checks.push(await ctx.check("the bundled Node keeps its JIT inside the signed bundle", async () => {
      // Hot loops and generated functions are compiled to machine code; a code-signing refusal would kill the process.
      const script = "let s=0;for(let i=0;i<5e7;i++)s=(s+i*i)%1000003;const f=new Function('x','return x*2');let t=0;for(let i=0;i<1e6;i++)t+=f(i);console.log(s,t)";
      const output = execFileSync(join(contents, "Resources/node/bin/node"), ["-e", script], { encoding: "utf8", timeout: 60_000 });
      assert.match(output, /^\d+ \d+\n$/);
    }));
    checks.push(await ctx.check("packaged smoke: agent setup writes the home command, and localbox help runs through it", async () => {
      const env = { PATH: FINDER_PATH, HOME: home, LOCALBOX_MACHINE_ROOT: join(work, "machine") };
      const reconciled = JSON.parse(execFileSync(join(contents, "Resources/cli/localbox"), ["agents", "reconcile", "--reason", "explicit", "--json"], { env, encoding: "utf8" }));
      assert.deepEqual(reconciled.actions.map((action: any) => `${action.subject}:${action.kind}`), ["skill:installed", "command:installed"], JSON.stringify(reconciled));
      const help = execFileSync(join(home, ".local/bin/localbox"), ["help"], { env, encoding: "utf8" });
      assert.match(help, /^localbox <command> \[options\]/);
      const status = JSON.parse(execFileSync(join(home, ".local/bin/localbox"), ["cli", "status", "--json"], { env, encoding: "utf8" })).result;
      assert.deepEqual([status.state, status.release, status.app], ["installed", VERSION, app]);
    }));
    checks.push(await ctx.check("the installed app's CLI installs the built-in image from this release, checked against the key the bundle pins", async () => {
      const machine = join(work, "machine");
      const env = { PATH: FINDER_PATH, HOME: home, LOCALBOX_MACHINE_ROOT: machine, LOCALBOX_RELEASE_URL: server!.url };
      // Not spawnSync: the release server answers from this process's event loop.
      const ensured = await ctx.exec(join(contents, "Resources/cli/localbox"), ["app", "image", "ensure", "--json"], { env });
      assert.equal(ensured.code, 0, `${ensured.stdout}${ensured.stderr}`);
      assert.equal(JSON.parse(ensured.stdout.trim().split("\n").at(-1)!).phase, "ready");
      assert.equal(await sha256(join(machine, "images/linux/disk.img")), await sha256(join(image, "disk.img")));
    }));
    return checks;
  } finally {
    server?.close();
    if (!ctx.keep) rmSync(work, { recursive: true, force: true });
  }
}

async function bundledDaemon(ctx: ProofContext): Promise<Check[]> {
  const checks: Check[] = [];
  const work = realpathSync(mkdtempSync("/tmp/lb42v-"));
  const identity = scratchIdentity(join(work, "signing"));
  const app = join(work, "Localbox.app");
  const daemon = realDaemon(ctx, { probe: "42", env: { LOCALBOX_GUEST_AGENT: join(app, "Contents/Resources/guest-agent") } });
  try {
    checks.push(await ctx.check("build: the dev image and a release bundle signed with a scratch identity", async () => {
      await buildRealVMs(ctx);
      if (!existsSync(join(ctx.root, "dist/guest-agent/agent-version.json"))) assert.equal((await ctx.exec("npm", ["run", "-s", "build:guest-agent"])).code, 0, "build:guest-agent");
      const built = await ctx.exec("node", ["apps/macos/App/scripts/build-app.mjs", "--release", "--out", work]);
      assert.equal(built.code, 0, built.stderr.slice(-1500));
      const signed = await ctx.exec("node", ["apps/macos/App/scripts/sign.mjs", app, "--p12", identity.p12, "--password-file", identity.passwordFile, "--sha1", identity.sha1]);
      assert.equal(signed.code, 0, signed.stderr.slice(-1500));
    }));
    checks.push(await ctx.check("localbox-hostd from inside the signed bundle boots a Linux VM", async () => {
      await daemon.start(join(app, "Contents/MacOS"), { supervised: true });
      const created = await daemon.ok("sandbox.create", "sandbox_p42_alpha", { name: "alpha-p42", image: "linux", cpus: 2, memory_bytes: 2 * 1024 ** 3, sleep_after_ms: 60 * 60_000 });
      assert.deepEqual(created.actions.map((action: any) => action.kind), ["created", "cold_booted"]);
      assert.equal(await daemon.sh("sandbox_p42_alpha", "uname -m"), "aarch64");
      assert.equal((await daemon.closeStdin()), 0, "the bundled daemon stops cleanly when its stdin closes");
    }));
    return checks;
  } finally {
    await daemon.cleanup();
    if (!ctx.keep) rmSync(work, { recursive: true, force: true });
  }
}
