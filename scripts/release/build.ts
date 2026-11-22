import { createHash, verify } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signApp, withIdentity } from "../../apps/macos/App/scripts/sign.mjs";
import { appcast, signAppcast, sparklePublicKey, sparkleSignature, verifyAppcast } from "../appcast.js";
import { buildGuestAgent } from "../build-guest-agent.js";
import { checkManifest, makeManifest, packImage, signManifest, verifyManifestSignature, verifyRelease, writeRelease, type ReleaseManifest } from "../release.js";
import { BUNDLE_ID, MINIMUM_MACOS, REPOSITORY, ZIP, signingFile, type BuildReceipt, type ReleaseConfig } from "./config.js";
import { capture, step } from "./process.js";
import { tagOf } from "./version.js";

/**
 * `build`: the release's files into `config.out`, every one of them an asset: the signed app zip (the CLI, its Node and
 * the patched Sparkle inside), `appcast.xml` (Sparkle's signed feed offering that zip at its versioned URL), the linux
 * image's parts, `release.json` (the signed manifest) and `SHA256SUMS`. Then it checks its own output as an installer and
 * an updater would (`verifyBuild`) and writes the receipt `smoke` and `publish` act on.
 */
export async function build(config: ReleaseConfig): Promise<BuildReceipt> {
  const { root, version, out } = config;
  const privateKey = readFileSync(signingFile(config, "privateKey"));
  const publicJson = JSON.parse(readFileSync(signingFile(config, "publicJson"), "utf8")) as { sha1: string };
  // The manifest lists every file in the folder, so nothing from an earlier build may stay in it.
  rmSync(out, { recursive: true, force: true });
  rmSync(config.receipt, { force: true });
  mkdirSync(out, { recursive: true });
  const stage = realpathSync(mkdtempSync(join(tmpdir(), "localbox-release-")));
  try {
    await step("npm", ["run", "build"], { cwd: root });
    console.log(`building the guest agent for ${version}`);
    await buildGuestAgent(undefined, version);
    await step("node", ["apps/macos/App/scripts/build-app.mjs", "--release", "--out", stage, "--version", version, "--public-key", config.publicKey, ...(config.node ? ["--node", config.node] : [])],
      { cwd: root, env: { ...process.env, LOCALBOX_SPARKLE_FRAMEWORK: config.sparkle } });
    const app = join(stage, "Localbox.app");
    // The identity goes into a disposable keychain for this one signing; public.json's sha1 refuses any other.
    await withIdentity({ p12: signingFile(config, "p12"), passwordFile: signingFile(config, "password"), sha1: publicJson.sha1 }, (identity) => signApp(app, identity));
    console.log(`signed ${app}`);
    await step("ditto", ["-c", "-k", "--keepParent", "--norsrc", "--noextattr", "--noqtn", app, join(out, ZIP)]);

    const zip = readFileSync(join(out, ZIP));
    const feed = appcast({ version, url: downloadUrl(version, ZIP), length: zip.length, signature: sparkleSignature(zip, privateKey), minimumSystemVersion: MINIMUM_MACOS });
    writeFileSync(join(out, "appcast.xml"), signAppcast(feed, privateKey));

    console.log(`compressing the linux image from ${config.image}`);
    const image = await packImage(config.image!, out, `localbox-linux-${version}`);
    const digest = config.imageDigest && /^sha256:[0-9a-f]{64}$/i.test(config.imageDigest) ? config.imageDigest : `sha256:${"0".repeat(64)}`;
    // The manifest carries no public key: installers trust only the pinned one.
    await writeRelease(out, signManifest(await makeManifest(out, version, digest, MINIMUM_MACOS, image), privateKey, "release"));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  console.log("\nverifying the build's own output");
  for (const line of await verifyBuild(out, { version, publicKey: readFileSync(config.publicKey, "utf8"), identitySha1: publicJson.sha1 })) console.log(`  ok  ${line}`);
  const receipt: BuildReceipt = {
    version, commit: capture("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim(), rehearsal: config.rehearsal,
    publicKeySha256: createHash("sha256").update(readFileSync(config.publicKey)).digest("hex"), builtAt: new Date().toISOString(),
  };
  writeFileSync(config.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export const downloadUrl = (version: string, name: string) => `https://github.com/${REPOSITORY}/releases/download/${tagOf(version)}/${name}`;

/**
 * The release folder's own consistency, as the installation procedure and Sparkle check it: the manifest's signature
 * and version, every artifact's digest, `SHA256SUMS` listing exactly the signed artifacts, no file the manifest does not
 * name, and a signed feed offering exactly this zip at this tag. Returns what it checked; throws at the first mismatch.
 */
export async function verifyReleaseFiles(out: string, options: { version: string; publicKey: string }): Promise<{ manifest: ReleaseManifest; checked: string[] }> {
  const checked: string[] = [];
  const manifest = JSON.parse(readFileSync(join(out, "release.json"), "utf8")) as ReleaseManifest;
  verifyManifestSignature(manifest, options.publicKey);
  checkManifest(manifest);
  if (manifest.version !== options.version) throw new Error(`release.json names version ${manifest.version}, not ${options.version}`);
  checked.push(`release.json is ${options.version}, signed by the release key`);
  await verifyRelease(out, manifest);
  const sums = manifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}\n`).join("");
  if (readFileSync(join(out, "SHA256SUMS"), "utf8") !== sums) throw new Error("SHA256SUMS does not list exactly the signed artifacts");
  checked.push(`every artifact matches its signed digest, and SHA256SUMS lists exactly those ${manifest.artifacts.length}`);
  const expected = [...manifest.artifacts.map((artifact) => artifact.name), "release.json", "SHA256SUMS"].sort();
  const present = readdirSync(out).sort();
  if (JSON.stringify(present) !== JSON.stringify(expected)) throw new Error(`the release folder holds ${present.join(", ")}, but the manifest names ${expected.join(", ")}`);
  for (const name of [ZIP, "appcast.xml"]) if (!expected.includes(name)) throw new Error(`the release has no ${name}`);
  if (!manifest.image) throw new Error("release.json names no linux image");
  checked.push("the folder holds exactly the manifest's files, the app zip, the feed and the image among them");

  const feed = verifyAppcast(readFileSync(join(out, "appcast.xml"), "utf8"), options.publicKey);
  const zip = readFileSync(join(out, ZIP));
  const enclosure = /<enclosure url="([^"]+)" length="(\d+)" type="application\/octet-stream" sparkle:edSignature="([^"]+)"\/>/.exec(feed);
  const feedVersion = /<sparkle:version>([^<]+)<\/sparkle:version>/.exec(feed)?.[1];
  if (feedVersion !== options.version) throw new Error(`appcast.xml offers version ${feedVersion}, not ${options.version}`);
  if (!enclosure || enclosure[1] !== downloadUrl(options.version, ZIP)) throw new Error(`appcast.xml offers ${enclosure?.[1]}, not ${downloadUrl(options.version, ZIP)}`);
  if (Number(enclosure[2]) !== zip.length || !verify(null, zip, options.publicKey, Buffer.from(enclosure[3], "base64"))) throw new Error("appcast.xml's length or signature does not match the zip");
  checked.push(`appcast.xml is signed, offers ${options.version} at ${tagOf(options.version)}'s ${ZIP}, with the zip's length and signature`);
  return { manifest, checked };
}

/**
 * `verifyReleaseFiles`, then the app as an installer gets it: unzipped, its code signature verified (inside out, by
 * the release identity), and its Info.plist, CLI version and pinned key the ones this release names.
 */
export async function verifyBuild(out: string, options: { version: string; publicKey: string; identitySha1: string }): Promise<string[]> {
  const { checked } = await verifyReleaseFiles(out, options);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "localbox-verify-")));
  try {
    execFileSync("ditto", ["-x", "-k", join(out, ZIP), scratch]);
    const app = join(scratch, "Localbox.app"), contents = join(app, "Contents");
    const verified = spawnSync("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
    if (verified.status !== 0) throw new Error(`the unzipped app's signature does not verify: ${verified.stderr.trim()}`);
    execFileSync("codesign", ["-d", `--extract-certificates=${join(scratch, "certificate")}`, app], { stdio: "ignore" });
    const leaf = createHash("sha1").update(readFileSync(join(scratch, "certificate0"))).digest("hex");
    if (leaf !== options.identitySha1.toLowerCase()) throw new Error(`the app is signed by certificate ${leaf}, not the release identity ${options.identitySha1}`);
    checked.push("after the zip round trip the app's signature verifies (deep, strict), by the release identity");
    const info = (key: string) => execFileSync("plutil", ["-extract", key, "raw", "-o", "-", join(contents, "Info.plist")], { encoding: "utf8" }).trim();
    const facts = { CFBundleIdentifier: info("CFBundleIdentifier"), CFBundleShortVersionString: info("CFBundleShortVersionString"), CFBundleVersion: info("CFBundleVersion"), SUPublicEDKey: info("SUPublicEDKey") };
    const wanted = { CFBundleIdentifier: BUNDLE_ID, CFBundleShortVersionString: options.version, CFBundleVersion: options.version, SUPublicEDKey: sparklePublicKey(options.publicKey) };
    if (JSON.stringify(facts) !== JSON.stringify(wanted)) throw new Error(`the app's Info.plist says ${JSON.stringify(facts)}, not ${JSON.stringify(wanted)}`);
    const cliVersion = readFileSync(join(contents, "Resources/cli/version"), "utf8").trim();
    if (cliVersion !== options.version) throw new Error(`the bundled CLI is ${cliVersion}, not ${options.version}`);
    if (readFileSync(join(contents, "Resources/release-public.pem"), "utf8") !== options.publicKey) throw new Error("the app pins another release key than the one that signed this release");
    if (!existsSync(join(contents, "Frameworks/Sparkle.framework"))) throw new Error("the app carries no Sparkle framework");
    checked.push(`the app is ${BUNDLE_ID} ${options.version}, its CLI ${cliVersion}, and it pins this release's key for the manifest and the feed`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return checked;
}

/** The receipt `build` left, which must name this version and match the folder's manifest. */
export function readReceipt(config: ReleaseConfig): BuildReceipt {
  if (!existsSync(config.receipt) || !existsSync(join(config.out, "release.json"))) throw new Error(`there is no build in ${config.out}: run npm run release -- build${config.rehearsal ? " --rehearsal" : ""} first`);
  const receipt = JSON.parse(readFileSync(config.receipt, "utf8")) as BuildReceipt;
  if (receipt.version !== config.version) throw new Error(`${config.out} holds a build of ${receipt.version}, not ${config.version}: run the build stage again`);
  if (receipt.publicKeySha256 !== createHash("sha256").update(readFileSync(config.publicKey)).digest("hex")) throw new Error(`${config.out} was built with another release key than ${config.publicKey}: run the build stage again`);
  return receipt;
}

export const releaseBytes = (out: string) => readdirSync(out).reduce((total, name) => total + statSync(join(out, name)).size, 0);
