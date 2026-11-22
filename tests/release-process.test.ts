import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appcast, signAppcast, sparkleSignature } from "../scripts/appcast.js";
import { makeManifest, signManifest, writeRelease } from "../scripts/release.js";
import { downloadUrl, verifyReleaseFiles } from "../scripts/release/build.js";
import { parseFlags, ZIP } from "../scripts/release/config.js";
import { assetList, assetMismatches, confirmCommand, draftCommands } from "../scripts/release/publish.js";
import { ALL_GROUPS, BUILD_GROUPS, PUBLISH_GROUPS, judge, neededBytes, type Facts } from "../scripts/release/validate.js";
import { compareVersions, isPrerelease, newestVersion, parseVersion } from "../scripts/release/version.js";

test("release versions order as SemVer and Sparkle order them: a suffix is older than its plain version", () => {
  const ascending = ["0.1.1", "0.1.2-alpha", "0.1.2-alpha.1", "0.1.2-alpha.beta", "0.1.2-beta.2", "0.1.2-beta.11", "0.1.2-rc.1", "0.1.2", "0.2.0", "0.10.0", "1.0.0"];
  for (let index = 1; index < ascending.length; index++) {
    assert.ok(compareVersions(ascending[index - 1], ascending[index]) < 0, `${ascending[index - 1]} < ${ascending[index]}`);
    assert.ok(compareVersions(ascending[index], ascending[index - 1]) > 0, `${ascending[index]} > ${ascending[index - 1]}`);
  }
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  for (const bad of ["1.2", "v1.2.3", "01.2.3", "1.2.3-", "1.2.3 ", "1.2.3+build"]) assert.equal(parseVersion(bad), undefined, bad);
  assert.equal(isPrerelease("1.2.0-rc.1"), true);
  assert.equal(isPrerelease("1.2.0"), false);
  assert.equal(newestVersion(["v0.1.0", "v0.10.0", "v0.9.9", "nightly", "v0.11.0-rc.1"]), "0.11.0-rc.1");
  assert.equal(newestVersion([]), undefined);
});

test("--version is for rehearsals only, so a real release always carries package.json's version", () => {
  assert.throws(() => parseFlags(["build", "--version", "9.9.9"]), /rehearsals only/);
  assert.deepEqual(parseFlags(["publish", "--confirm"]), { stage: "publish", confirm: true, rehearsal: false, dryRun: false, help: false });
  assert.equal(parseFlags(["build", "--rehearsal", "--version", "0.2.0-rc.0"]).version, "0.2.0-rc.0");
  assert.throws(() => parseFlags(["build", "--bogus"]), /unknown argument/);
});

const GiB = 1024 ** 3;
/** Facts for a release that is ready in every way; each test breaks one thing. */
function ready(): Facts {
  return {
    version: "0.2.0", packageVersion: "0.2.0", rehearsal: false,
    platform: { os: "darwin", arch: "arm64" },
    git: { branch: "main", commit: "a".repeat(40), dirty: [], pushed: true },
    lockVersions: ["0.2.0", "0.2.0"],
    github: { authenticated: true, tagExists: false, release: "none", newest: "0.1.1" },
    signing: { dir: "/checkout/.release-signing", missing: [], keyMatches: true, publicKeyOverridden: false, installationPinMatches: true,
      identity: { sha1: "1".repeat(40), sha256: "2".repeat(64), name: "Localbox Release" }, publicJson: { sha1: "1".repeat(40), certificateSha256: "2".repeat(64) } },
    tools: { fullXcode: true, zstd: true, bun: "1.4.4", gh: true },
    sparkle: { problem: null },
    image: { dir: "/images/linux", missing: [], manifest: { image_id: "linux", os: "linux" }, digest: `sha256:${"3".repeat(64)}`, allocatedBytes: 8 * GiB },
    disk: { freeBytes: 100 * GiB, volume: "/checkout/dist" },
  };
}
const refusals = (change: (facts: Facts) => void, groups = ALL_GROUPS) => { const facts = ready(); change(facts); return judge(facts, groups).refusals; };

test("validate passes a release that has everything, one line per group", () => {
  const judgement = judge(ready(), ALL_GROUPS);
  assert.deepEqual(judgement.refusals, []);
  assert.deepEqual(judgement.passed.map((line) => line.split(":")[0]), ALL_GROUPS);
});

test("each missing thing is one refusal sentence that says what to do", () => {
  const cases: Array<[string, (facts: Facts) => void, RegExp]> = [
    ["another branch", (facts) => { facts.git.branch = "feature"; }, /^Check out main: .* on feature\.$/],
    ["a dirty tree", (facts) => { facts.git.dirty = ["a.ts", "b.ts"]; }, /^Commit or discard the 2 changed files .*a\.ts, b\.ts/],
    ["an unpushed commit", (facts) => { facts.git.pushed = false; }, /^Push aaaaaaa to origin\/main first/],
    ["an unreachable origin", (facts) => { facts.git.pushed = "unknown"; facts.git.fetchError = "offline"; }, /^Could not fetch origin\/main .*\(offline\)/],
    ["a malformed version", (facts) => { facts.version = facts.packageVersion = "0.2"; facts.lockVersions = ["0.2", "0.2"]; }, /npm version X\.Y\.Z --no-git-tag-version/],
    ["a stale lock", (facts) => { facts.lockVersions = ["0.1.1", "0.2.0"]; }, /^Sync package-lock\.json, which records version 0\.1\.1/],
    ["an existing tag", (facts) => { facts.github.tagExists = true; }, /^Bump the version: tag v0\.2\.0 already exists/],
    ["a published release", (facts) => { facts.github.release = "published"; }, /^Bump the version: v0\.2\.0 is already published/],
    ["an older version", (facts) => { facts.github.newest = "0.3.0"; }, /^Bump the version past the newest release, 0\.3\.0/],
    ["gh signed out", (facts) => { facts.github.authenticated = false; }, /^Sign the GitHub CLI in \(gh auth login\)/],
    ["no signing folder", (facts) => { facts.signing.missing = ["privateKey", "p12", "password", "publicJson"]; }, /^There is no release signing folder at .*the owner's offline backup/],
    ["a missing identity", (facts) => { facts.signing.missing = ["p12"]; }, /has no release-identity\.p12 .*the owner's offline backup/],
    ["another manifest key", (facts) => { facts.signing.keyMatches = false; }, /^release-private\.pem is not the key installers trust/],
    ["a rehearsal key in a real release", (facts) => { facts.signing.publicKeyOverridden = true; }, /^Unset LOCALBOX_RELEASE_PUBLIC_KEY/],
    ["another identity", (facts) => { facts.signing.identity!.sha1 = "9".repeat(40); }, /^The signing identity \(certificate sha1 9+\) is not the one public\.json pins/],
    ["a procedure printing another key", (facts) => { facts.signing.installationPinMatches = false; }, /installation\.md \(step 3\)/],
    ["the Command Line Tools only", (facts) => { facts.tools.fullXcode = false; }, /^Install full Xcode/],
    ["no zstd", (facts) => { facts.tools.zstd = false; }, /^Install zstd \(brew install zstd\)/],
    ["another Bun", (facts) => { facts.tools.bun = "1.2.0"; }, /^Install Bun 1\.4\.4 .*this Mac has 1\.2\.0/],
    ["no Sparkle build", (facts) => { facts.sparkle.problem = "There is no Sparkle framework at /x: run npm run sparkle:build"; }, /^There is no Sparkle framework at \/x: run npm run sparkle:build\.$/],
    ["no image", (facts) => { facts.image.dir = undefined; }, /^Set LOCALBOX_IMAGE .*npm run image:build -- --out DIR/],
    ["another image", (facts) => { facts.image.manifest = { image_id: "macos", os: "macos" }; }, /holds image "macos" \(macos\), not the linux image/],
    ["no image digest", (facts) => { facts.image.digest = undefined; }, /^Set IMAGE_DIGEST to the digest in dist\/vm-image\/full\/manifest\.json/],
    ["a full disk", (facts) => { facts.disk.freeBytes = 10 * GiB; }, /^Free at least 20\.0 GiB on \/checkout\/dist \(10\.0 GiB free\)/],
    ["an Intel Mac", (facts) => { facts.platform.arch = "x64"; }, /^Build releases on an Apple Silicon Mac/],
  ];
  for (const [name, change, sentence] of cases) {
    const found = refusals(change);
    assert.equal(found.length, 1, `${name}: ${JSON.stringify(found)}`);
    assert.match(found[0], sentence, name);
    assert.doesNotMatch(found[0], /Obsidian|\/Users\//, `${name} names no private path`);
  }
  assert.equal(neededBytes(8 * GiB), 20 * GiB);
});

test("a rehearsal waives only the git checks, and still refuses a key that is not its own", () => {
  const rehearsal = (change: (facts: Facts) => void) => { const facts = ready(); facts.rehearsal = true; change(facts); return judge(facts, ALL_GROUPS); };
  const elsewhere = rehearsal((facts) => { facts.git = { branch: "feature", commit: "b".repeat(40), dirty: ["x"], pushed: false }; facts.version = "0.2.0-rc.0"; facts.signing.publicKeyOverridden = true; facts.image.digest = undefined; });
  assert.deepEqual(elsewhere.refusals, []);
  assert.equal(elsewhere.notes.filter((note) => note.startsWith("rehearsal, not refused")).length, 3);
  assert.match(rehearsal((facts) => { facts.signing.publicKeyOverridden = true; facts.signing.keyMatches = false; }).refusals.join(), /not the key LOCALBOX_RELEASE_PUBLIC_KEY names/);
  assert.match(rehearsal((facts) => { facts.tools.zstd = false; }).refusals.join(), /Install zstd/);
});

test("each stage judges only the groups it depends on, and a draft of the version is reused, not refused", () => {
  // A build binds the release to a commit, so it judges the tree, but GitHub is publish's business.
  assert.deepEqual(refusals((facts) => { facts.github.authenticated = false; }, BUILD_GROUPS), []);
  assert.equal(refusals((facts) => { facts.git.dirty = ["x"]; }, BUILD_GROUPS).length, 1);
  assert.deepEqual(refusals((facts) => { facts.tools.zstd = false; facts.image.dir = undefined; }, PUBLISH_GROUPS), []);
  const draft = ready(); draft.github.release = "draft";
  const judgement = judge(draft, PUBLISH_GROUPS);
  assert.deepEqual(judgement.refusals, []);
  assert.match(judgement.notes.join(), /A draft release v0\.2\.0 exists/);
});

/** A built release folder as the build stage writes one, with stand-in bytes for the app and the image. */
async function builtRelease(version: string) {
  const dir = await mkdtemp(join(tmpdir(), "localbox-release-process-"));
  const keys = generateKeyPairSync("ed25519");
  const zip = Buffer.from("the app");
  await writeFile(join(dir, ZIP), zip);
  await writeFile(join(dir, "appcast.xml"), signAppcast(appcast({ version, url: downloadUrl(version, ZIP), length: zip.length, signature: sparkleSignature(zip, keys.privateKey), minimumSystemVersion: "14.0" }), keys.privateKey));
  for (const name of [`localbox-linux-${version}.disk.img.zst.000`, `localbox-linux-${version}.efi-vars`, `localbox-linux-${version}.image.json`]) await writeFile(join(dir, name), name);
  const image = { sha256: "4".repeat(64), size: 1, parts: [`localbox-linux-${version}.disk.img.zst.000`], bootStore: `localbox-linux-${version}.efi-vars`, manifest: `localbox-linux-${version}.image.json` };
  await writeRelease(dir, signManifest(await makeManifest(dir, version, `sha256:${"0".repeat(64)}`, "14.0", image), keys.privateKey, "release"));
  return { dir, keys, publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
}

test("the build's self-check accepts its own output and refuses a stray file, another version, a tampered feed or a feed for another tag", async () => {
  const { dir, publicKey } = await builtRelease("0.2.0");
  try {
    const { checked } = await verifyReleaseFiles(dir, { version: "0.2.0", publicKey });
    assert.equal(checked.length, 4);
    await assert.rejects(verifyReleaseFiles(dir, { version: "0.2.1", publicKey }), /names version 0\.2\.0, not 0\.2\.1/);
    await assert.rejects(verifyReleaseFiles(dir, { version: "0.2.0", publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() }), /signature verification failed/);
    await writeFile(join(dir, ".DS_Store"), "");
    await assert.rejects(verifyReleaseFiles(dir, { version: "0.2.0", publicKey }), /the release folder holds .*\.DS_Store/);
    await rm(join(dir, ".DS_Store"));
    const feed = await readFile(join(dir, "appcast.xml"), "utf8");
    await writeFile(join(dir, "appcast.xml"), feed.replace("download/v0.2.0/", "download/v0.1.0/"));
    await assert.rejects(verifyReleaseFiles(dir, { version: "0.2.0", publicKey }), /checksum mismatch: appcast\.xml/);
  } finally { await rm(dir, { recursive: true, force: true }); }
  // A feed signed for another tag, with the manifest re-signed over it, still fails on its URL.
  const other = await builtRelease("0.2.0");
  try {
    const zip = await readFile(join(other.dir, ZIP));
    await writeFile(join(other.dir, "appcast.xml"), signAppcast(appcast({ version: "0.2.0", url: downloadUrl("0.1.9", ZIP), length: zip.length, signature: sparkleSignature(zip, other.keys.privateKey), minimumSystemVersion: "14.0" }), other.keys.privateKey));
    const manifest = JSON.parse(await readFile(join(other.dir, "release.json"), "utf8"));
    await rm(join(other.dir, "release.json")); await rm(join(other.dir, "SHA256SUMS"));
    await writeRelease(other.dir, signManifest(await makeManifest(other.dir, "0.2.0", manifest.imageDigest, "14.0", manifest.image), other.keys.privateKey, "release"));
    await assert.rejects(verifyReleaseFiles(other.dir, { version: "0.2.0", publicKey: other.publicKey }), /appcast\.xml offers https:\/\/github\.com\/dzhng\/localbox\/releases\/download\/v0\.1\.9\//);
  } finally { await rm(other.dir, { recursive: true, force: true }); }
});

test("publish uploads every file of the build into a draft at the build's commit, and confirming creates the tag there", async () => {
  const { dir } = await builtRelease("0.2.0-rc.1");
  try {
    const assets = await assetList(dir);
    assert.deepEqual(assets.map((asset) => asset.name), [ZIP, "SHA256SUMS", "appcast.xml", "localbox-linux-0.2.0-rc.1.disk.img.zst.000", "localbox-linux-0.2.0-rc.1.efi-vars", "localbox-linux-0.2.0-rc.1.image.json", "release.json"].sort());
    const commit = "c".repeat(40);
    const [create, upload] = draftCommands("0.2.0-rc.1", commit, dir, assets, false);
    assert.deepEqual(create, ["gh", "release", "create", "v0.2.0-rc.1", "--repo", "dzhng/localbox", "--draft", "--target", commit, "--title", "Localbox 0.2.0-rc.1", "--generate-notes", "--prerelease"]);
    assert.deepEqual(upload.slice(0, 6), ["gh", "release", "upload", "v0.2.0-rc.1", "--repo", "dzhng/localbox"]);
    assert.deepEqual(upload.slice(7), assets.map((asset) => join(dir, asset.name)));
    assert.equal(draftCommands("0.2.0-rc.1", commit, dir, assets, true).length, 1, "an existing draft is uploaded into again");
    assert.deepEqual(confirmCommand(7, "0.2.0-rc.1", commit), ["gh", "api", "--method", "PATCH", "repos/dzhng/localbox/releases/7", "-f", "tag_name=v0.2.0-rc.1", "-f", `target_commitish=${commit}`, "-F", "draft=false", "-F", "prerelease=true", "-f", "make_latest=false", "--silent"]);
    assert.ok(confirmCommand(7, "0.2.0", commit).includes("make_latest=true"));
    assert.ok(confirmCommand(7, "0.2.0", commit).includes("prerelease=false"));
    const remote = assets.map(({ name, size }) => ({ name, size, state: "uploaded" }));
    assert.deepEqual(assetMismatches(assets, remote), []);
    assert.deepEqual(assetMismatches(assets, [...remote.slice(1), { name: "old.zip", size: 1, state: "uploaded" }, { ...remote[0], size: 1 }]), [`${ZIP} is 1 bytes (uploaded), not ${assets[0].size}`, "old.zip is on the release but not in the build"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
