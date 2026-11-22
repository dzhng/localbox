import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, statSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { certificateOf } from "../../apps/macos/App/scripts/sign.mjs";
import { frameworkProblem } from "../../apps/macos/App/sparkle/framework.mjs";
import { sparklePublicKey } from "../appcast.js";
import { BUN_VERSION, bunVersion } from "../build-guest-agent.js";
import { installationSteps, pinnedKey } from "../proof/lib/installation.js";
import { IMAGE_FILES } from "../release.js";
import { PINNED_PUBLIC_KEY, REPOSITORY, SIGNING_FILES, signingFile, type ReleaseConfig } from "./config.js";
import { capture } from "./process.js";
import { compareVersions, newestVersion, parseVersion, tagOf } from "./version.js";

/**
 * `validate`: everything a release needs, gathered as plain facts (`gatherFacts`, which only reads) and judged by
 * `judge`, a pure function, so each refusal is tested against fake facts. Every refusal is one sentence that says what
 * to do. A rehearsal turns the git refusals into notes; nothing else is waived.
 *
 * Each stage judges the groups it depends on: `build` the tree it builds from and the local inputs, `publish` git and
 * GitHub, `validate` all.
 */

export type Group = "platform" | "git" | "version" | "github" | "signing" | "tools" | "sparkle" | "image" | "disk";
export const BUILD_GROUPS: Group[] = ["platform", "git", "version", "signing", "tools", "sparkle", "image", "disk"];
export const PUBLISH_GROUPS: Group[] = ["git", "version", "github"];
export const ALL_GROUPS: Group[] = ["platform", "git", "version", "github", "signing", "tools", "sparkle", "image", "disk"];

export interface Facts {
  version: string;
  packageVersion: string;
  rehearsal: boolean;
  platform: { os: string; arch: string };
  git: { branch: string; commit: string; dirty: string[]; pushed: boolean | "unknown"; fetchError?: string };
  /** The versions package-lock.json records for the root package. */
  lockVersions: string[];
  github: { authenticated: boolean; error?: string; tagExists: boolean; release: "none" | "draft" | "published"; newest?: string };
  signing: {
    dir: string;
    missing: Array<keyof typeof SIGNING_FILES>;
    /** Whether the private key's public half is the key the release pins (`publicKey`). */
    keyMatches?: boolean;
    keyError?: string;
    publicKeyOverridden: boolean;
    /** The pinned PEM and the key printed in the installation procedure agree. */
    installationPinMatches: boolean;
    identity?: { sha1: string; sha256: string; name?: string };
    identityError?: string;
    publicJson?: { sha1?: string; certificateSha256?: string; releasePublicKey?: string };
    /** public.json's `releasePublicKey`, when present, names the private key's public half. */
    publicJsonKeyMatches?: boolean;
  };
  tools: { fullXcode: boolean; zstd: boolean; bun?: string; gh: boolean };
  sparkle: { problem: string | null };
  image: { dir?: string; missing: string[]; manifest?: { image_id?: string; os?: string }; digest?: string; allocatedBytes?: number };
  disk: { freeBytes: number; volume: string };
}

export interface Judgement { refusals: string[]; notes: string[]; passed: string[] }

const GiB = 1024 ** 3;
const gib = (bytes: number) => `${(bytes / GiB).toFixed(1)} GiB`;
const BACKUP = "restore .release-signing/ whole from the owner's offline backup (never generate new keys: installed copies trust only the pinned ones)";
const IMAGE_BUILD = "npm run image:build -- --out DIR (Docker: colima start --arch aarch64)";
/** Room for the compressed image, the staged app and the smoke's expanded copy of the image. */
export const neededBytes = (allocatedImageBytes: number) => 2 * allocatedImageBytes + 4 * GiB;

export function judge(facts: Facts, groups: Group[]): Judgement {
  const refusals: string[] = [], notes: string[] = [], passed: string[] = [];
  const tag = tagOf(facts.version);
  const group = (name: Group, check: (refuse: (sentence: string) => void, note: (sentence: string) => void) => string) => {
    if (!groups.includes(name)) return;
    const before = refusals.length;
    const summary = check((sentence) => refusals.push(sentence), (sentence) => notes.push(sentence));
    if (refusals.length === before) passed.push(`${name}: ${summary}`);
  };

  group("platform", (refuse) => {
    if (facts.platform.os !== "darwin" || facts.platform.arch !== "arm64") refuse(`Build releases on an Apple Silicon Mac: this is ${facts.platform.os}/${facts.platform.arch}.`);
    return "Apple Silicon Mac";
  });

  group("git", (refuse, note) => {
    const { git } = facts;
    const problems: string[] = [];
    if (git.branch !== "main") problems.push(`Check out main: a release is cut from main, and this checkout is on ${git.branch || "a detached HEAD"}.`);
    if (git.dirty.length) problems.push(`Commit or discard the ${git.dirty.length} changed file${git.dirty.length === 1 ? "" : "s"} git status lists (${git.dirty.slice(0, 3).join(", ")}${git.dirty.length > 3 ? ", …" : ""}): a release is built from a clean tree.`);
    if (git.pushed === "unknown") problems.push(`Could not fetch origin/main to check that ${git.commit.slice(0, 7)} is pushed (${git.fetchError ?? "no answer"}): check the network and run again.`);
    else if (!git.pushed) problems.push(`Push ${git.commit.slice(0, 7)} to origin/main first: the release's tag must name a commit everyone can fetch.`);
    for (const problem of problems) (facts.rehearsal ? (text: string) => note(`rehearsal, not refused: ${text}`) : refuse)(problem);
    return problems.length ? `${git.branch || "HEAD"} at ${git.commit.slice(0, 7)}, ${problems.length} check${problems.length === 1 ? "" : "s"} waived for the rehearsal` : `${git.branch} at ${git.commit.slice(0, 7)}, clean, pushed`;
  });

  group("version", (refuse) => {
    if (!parseVersion(facts.version)) refuse(`Set a release version: "${facts.version}" is not MAJOR.MINOR.PATCH (with an optional -suffix); bump it with npm version X.Y.Z --no-git-tag-version.`);
    if (!facts.rehearsal && facts.version !== facts.packageVersion) refuse(`Release package.json's version: this run asked for ${facts.version}, package.json says ${facts.packageVersion}.`);
    const stale = facts.lockVersions.filter((version) => version !== facts.packageVersion);
    if (stale.length) refuse(`Sync package-lock.json, which records version ${stale[0]} for the root package, with package.json's ${facts.packageVersion}: run npm install --package-lock-only (npm version updates both).`);
    return `${facts.version}${facts.version === facts.packageVersion ? " (package.json and its lock agree)" : " (rehearsal version)"}`;
  });

  group("github", (refuse, note) => {
    const { github } = facts;
    if (!facts.tools.gh) { refuse("Install the GitHub CLI (brew install gh): publishing and the version checks use it."); return ""; }
    if (!github.authenticated) { refuse(`Sign the GitHub CLI in (gh auth login) as an account that can publish to ${REPOSITORY}.`); return ""; }
    if (github.error) { refuse(`Could not list ${REPOSITORY}'s releases (${github.error}): check gh auth status and the network, then run again.`); return ""; }
    if (github.release === "published") refuse(`Bump the version: ${tag} is already published, and a published version is never rebuilt (npm version X.Y.Z --no-git-tag-version, then commit).`);
    else if (github.tagExists) refuse(`Bump the version: tag ${tag} already exists on origin, so ${facts.version} was released or reserved before.`);
    if (github.release === "draft") note(`A draft release ${tag} exists; publish uploads into it again.`);
    if (github.release !== "published" && !github.tagExists && github.newest && parseVersion(facts.version) && compareVersions(facts.version, github.newest) <= 0)
      refuse(`Bump the version past the newest release, ${github.newest}: ${facts.version} is not newer, and Sparkle only installs newer versions.`);
    return `${tag} is new${github.newest ? ` and newer than ${github.newest}` : ""}`;
  });

  group("signing", (refuse) => {
    const { signing } = facts;
    if (!facts.rehearsal && signing.publicKeyOverridden) refuse(`Unset LOCALBOX_RELEASE_PUBLIC_KEY: a real release carries the pinned ${PINNED_PUBLIC_KEY}; another key is for rehearsals only.`);
    if (!facts.rehearsal && !signing.installationPinMatches) refuse(`Make the key printed in skills/localbox/references/installation.md (step 3) the same as ${PINNED_PUBLIC_KEY}: first installs trust the printed one.`);
    if (signing.missing.length === Object.keys(SIGNING_FILES).length) { refuse(`There is no release signing folder at ${signing.dir}: ${BACKUP}.`); return ""; }
    for (const file of signing.missing) refuse(`${signing.dir} has no ${SIGNING_FILES[file].name} (${SIGNING_FILES[file].what}): ${BACKUP}.`);
    if (signing.keyError) refuse(`${SIGNING_FILES.privateKey.name} cannot be read as an Ed25519 key (${signing.keyError}): ${BACKUP}.`);
    else if (signing.keyMatches === false) refuse(facts.rehearsal && signing.publicKeyOverridden
      ? `The rehearsal's ${SIGNING_FILES.privateKey.name} is not the key LOCALBOX_RELEASE_PUBLIC_KEY names: point both at the same scratch key pair.`
      : `${SIGNING_FILES.privateKey.name} is not the key installers trust (${PINNED_PUBLIC_KEY}): ${BACKUP}; a release signed by any other key could never be installed or update anyone.`);
    if (signing.publicJsonKeyMatches === false) refuse(`public.json's releasePublicKey is not the public half of ${SIGNING_FILES.privateKey.name}: the folder is mixed up; ${BACKUP}.`);
    if (signing.identityError) refuse(`${SIGNING_FILES.p12.name} does not open with ${SIGNING_FILES.password.name} (${signing.identityError}): ${BACKUP}.`);
    else if (signing.identity && signing.publicJson) {
      if (!signing.publicJson.sha1) refuse(`public.json has no sha1 for the signing identity: ${BACKUP}.`);
      else if (signing.identity.sha1 !== signing.publicJson.sha1.toLowerCase()) refuse(`The signing identity (certificate sha1 ${signing.identity.sha1}) is not the one public.json pins (${signing.publicJson.sha1}): ${BACKUP}.`);
      if (signing.publicJson.certificateSha256 && signing.identity.sha256 !== signing.publicJson.certificateSha256.toLowerCase()) refuse(`The signing identity's certificate SHA-256 is not the one public.json pins: ${BACKUP}.`);
    }
    return `${signing.dir}: the key matches ${facts.signing.publicKeyOverridden ? "the rehearsal's public key" : PINNED_PUBLIC_KEY}, the identity "${signing.identity?.name ?? "?"}" matches public.json`;
  });

  group("tools", (refuse) => {
    const { tools } = facts;
    if (!tools.fullXcode) refuse("Install full Xcode and select it (sudo xcode-select -s /Applications/Xcode.app): Sparkle and the app's tests need more than the Command Line Tools.");
    if (!tools.zstd) refuse("Install zstd (brew install zstd): it compresses the linux image.");
    if (tools.bun !== BUN_VERSION) refuse(`Install Bun ${BUN_VERSION} (curl -fsSL https://bun.sh/install | bash -s bun-v${BUN_VERSION}): the guest agent builds only with the pinned Bun, and this Mac has ${tools.bun ?? "none"}.`);
    return `full Xcode, zstd, Bun ${BUN_VERSION}`;
  });

  group("sparkle", (refuse) => {
    if (facts.sparkle.problem) refuse(`${facts.sparkle.problem}.`);
    return "the patched Sparkle matches its receipt and the pin";
  });

  group("image", (refuse, note) => {
    const { image } = facts;
    if (!image.dir) { refuse(`Set LOCALBOX_IMAGE to the built-in linux image's directory; build it with ${IMAGE_BUILD}.`); return ""; }
    if (image.missing.length) refuse(`LOCALBOX_IMAGE (${image.dir}) has no ${image.missing.join(", ")}: rebuild it with ${IMAGE_BUILD}.`);
    else if (image.manifest?.image_id !== "linux" || image.manifest.os !== "linux") refuse(`LOCALBOX_IMAGE (${image.dir}) holds image "${image.manifest?.image_id}" (${image.manifest?.os}), not the linux image: point it at the directory ${IMAGE_BUILD} wrote.`);
    if (!image.digest || !/^sha256:[0-9a-f]{64}$/i.test(image.digest)) {
      if (facts.rehearsal) note("rehearsal: no IMAGE_DIGEST, so release.json records sha256:000…");
      else refuse("Set IMAGE_DIGEST to the digest in dist/vm-image/full/manifest.json, which npm run image:build writes: release.json records which image build shipped.");
    }
    return `${image.dir} (${gib(image.allocatedBytes ?? 0)} on disk)`;
  });

  group("disk", (refuse) => {
    const needed = neededBytes(facts.image.allocatedBytes ?? 0);
    if (facts.disk.freeBytes < needed) refuse(`Free at least ${gib(needed)} on ${facts.disk.volume} (${gib(facts.disk.freeBytes)} free): the build compresses the image and the smoke expands it again.`);
    return `${gib(facts.disk.freeBytes)} free`;
  });

  return { refusals, notes, passed };
}

/** Reads every fact `judge` needs for `groups`; it changes nothing (a `git fetch` of origin/main aside). */
export function gatherFacts(config: ReleaseConfig, groups: Group[]): Facts {
  const { root } = config;
  const git = (...args: string[]) => capture("git", args, { cwd: root });
  const wants = (name: Group) => groups.includes(name);
  const tag = tagOf(config.version);

  let gitFacts: Facts["git"] = { branch: "", commit: "", dirty: [], pushed: "unknown" };
  if (wants("git")) {
    const fetched = git("fetch", "--quiet", "origin", "main");
    const commit = git("rev-parse", "HEAD").stdout.trim();
    gitFacts = {
      branch: git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim().replace(/^HEAD$/, ""), commit,
      dirty: git("status", "--porcelain").stdout.split("\n").filter(Boolean).map((line) => line.slice(3)),
      pushed: fetched.code !== 0 ? "unknown" : git("merge-base", "--is-ancestor", commit, "origin/main").code === 0,
      ...(fetched.code !== 0 ? { fetchError: fetched.stderr.trim().split("\n").at(-1) } : {}),
    };
  }

  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { version?: string; packages?: Record<string, { version?: string }> };
  const lockVersions = [lock.version, lock.packages?.[""]?.version].filter((version): version is string => !!version);

  const ghInstalled = capture("gh", ["--version"]).code === 0;
  let github: Facts["github"] = { authenticated: false, tagExists: false, release: "none" };
  if (wants("github") && ghInstalled) {
    const authenticated = capture("gh", ["auth", "status"]).code === 0;
    const listed = authenticated ? capture("gh", ["release", "list", "--repo", REPOSITORY, "--limit", "200", "--json", "tagName,isDraft"]) : undefined;
    const releases = listed?.code === 0 ? JSON.parse(listed.stdout) as Array<{ tagName: string; isDraft: boolean }> : [];
    const mine = releases.find((release) => release.tagName === tag);
    github = {
      authenticated, ...(listed && listed.code !== 0 ? { error: listed.stderr.trim().split("\n").at(-1) } : {}),
      tagExists: authenticated && git("ls-remote", "--tags", "origin", `refs/tags/${tag}`).stdout.trim() !== "",
      release: !mine ? "none" : mine.isDraft ? "draft" : "published",
      newest: newestVersion(releases.filter((release) => !release.isDraft).map((release) => release.tagName)),
    };
  }

  const file = (name: keyof typeof SIGNING_FILES) => signingFile(config, name);
  const signing: Facts["signing"] = {
    dir: config.signingDir, missing: (Object.keys(SIGNING_FILES) as Array<keyof typeof SIGNING_FILES>).filter((name) => !existsSync(file(name))),
    publicKeyOverridden: config.publicKeyOverridden,
    installationPinMatches: pinnedKey(installationSteps(root)) === readFileSync(join(root, PINNED_PUBLIC_KEY), "utf8"),
  };
  if (wants("signing")) {
    if (!signing.missing.includes("privateKey")) {
      try {
        const derived = createPublicKey(createPrivateKey(readFileSync(file("privateKey"))));
        const pem = derived.export({ type: "spki", format: "pem" }).toString();
        signing.keyMatches = pem === readFileSync(config.publicKey, "utf8");
        if (!signing.missing.includes("publicJson")) {
          signing.publicJson = JSON.parse(readFileSync(file("publicJson"), "utf8"));
          const recorded = signing.publicJson?.releasePublicKey?.trim();
          // public.json may record the key as PEM, as base64 SPKI DER, or as Sparkle's raw 32 bytes.
          if (recorded) signing.publicJsonKeyMatches = [pem.trim(), derived.export({ type: "spki", format: "der" }).toString("base64"), sparklePublicKey(derived)].includes(recorded);
        }
      } catch (error) { signing.keyError = (error as Error).message; }
    }
    if (!signing.missing.includes("p12") && !signing.missing.includes("password")) {
      try { signing.identity = certificateOf({ p12: file("p12"), passwordFile: file("password") }); } catch (error) { signing.identityError = (error as Error).message.split("\n")[0]; }
    }
  }

  const developer = capture("xcode-select", ["-p"]).stdout.trim();
  const tools = {
    fullXcode: !!developer && !developer.includes("CommandLineTools") && capture("xcodebuild", ["-version"]).code === 0,
    zstd: capture("zstd", ["--version"]).code === 0, bun: bunVersion(), gh: ghInstalled,
  };

  const image: Facts["image"] = { dir: config.image, missing: [], digest: config.imageDigest };
  if (config.image) {
    image.missing = Object.values(IMAGE_FILES).filter((name) => !existsSync(join(config.image!, name)));
    try { image.manifest = JSON.parse(readFileSync(join(config.image, IMAGE_FILES.manifest), "utf8")); } catch { /* reported as missing or wrong */ }
    // Allocated, not apparent, size: the disk is mostly holes.
    try { image.allocatedBytes = statSync(join(config.image, IMAGE_FILES.disk)).blocks * 512; } catch { /* missing */ }
  }

  let volume = dirname(config.out);
  while (!existsSync(volume)) volume = dirname(volume);
  const fs = statfsSync(volume);

  return {
    version: config.version, packageVersion: config.packageVersion, rehearsal: config.rehearsal,
    platform: { os: process.platform, arch: process.arch }, git: gitFacts, lockVersions, github, signing, tools,
    sparkle: { problem: wants("sparkle") ? frameworkProblem(config.sparkle) : null }, image, disk: { freeBytes: fs.bavail * fs.bsize, volume },
  };
}

/** Gathers and judges `groups`, prints the outcome, and throws when anything is refused. */
export function validate(config: ReleaseConfig, groups: Group[] = ALL_GROUPS): Judgement {
  const judgement = judge(gatherFacts(config, groups), groups);
  for (const line of judgement.passed) console.log(`  ok  ${line}`);
  for (const line of judgement.notes) console.log(`  note  ${line}`);
  if (judgement.refusals.length) {
    console.log(`\nRefused, ${judgement.refusals.length} thing${judgement.refusals.length === 1 ? "" : "s"} to fix:`);
    for (const line of judgement.refusals) console.log(`  - ${line}`);
    throw new RefusedError(judgement.refusals.length);
  }
  return judgement;
}

export class RefusedError extends Error {
  constructor(count: number) { super(`validation refused (${count})`); }
}
