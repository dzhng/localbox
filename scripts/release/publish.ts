import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readReceipt } from "./build.js";
import { FEED_URL, REPOSITORY, type Asset, type ReleaseConfig } from "./config.js";
import { capture, commandLine, step } from "./process.js";
import { isPrerelease, tagOf } from "./version.js";

/**
 * `publish`: GitHub Releases, in two deliberate steps. Without `--confirm` it creates (or reuses) a DRAFT release of the
 * tag at the build's commit, uploads every file of the build, downloads each asset back and compares its SHA-256, then
 * stops: a draft is invisible to installs and updates. `--confirm` makes the draft public (a prerelease for a suffixed
 * version), which creates the tag at that commit, and then checks what installs and updates now see: the tag, the
 * update feed's redirect and `releases/latest/download/release.json`. `--dry-run` prints the plan and touches nothing.
 */

interface GitHubRelease { id: number; tag_name: string; draft: boolean; prerelease: boolean; target_commitish: string; html_url: string; assets: Array<{ id: number; name: string; size: number; state: string }> }

/** The GitHub calls `publish` makes for the draft, as argv; `--dry-run` prints exactly these. */
export function draftCommands(version: string, commit: string, out: string, assets: Asset[], draftExists: boolean): string[][] {
  const tag = tagOf(version);
  const create = ["gh", "release", "create", tag, "--repo", REPOSITORY, "--draft", "--target", commit, "--title", `Localbox ${version}`, "--generate-notes", ...(isPrerelease(version) ? ["--prerelease"] : [])];
  return [...(draftExists ? [] : [create]), ["gh", "release", "upload", tag, "--repo", REPOSITORY, "--clobber", ...assets.map((asset) => join(out, asset.name))]];
}

/**
 * The call `--confirm` makes to turn draft `releaseId` public: the tag is created at `commit`, and a prerelease never
 * becomes latest. Booleans go as typed fields (`-F`), strings as raw ones (`-f`: `make_latest` is the string "true").
 */
export function confirmCommand(releaseId: number | string, version: string, commit: string): string[] {
  const fields: Record<string, string | boolean> = { tag_name: tagOf(version), target_commitish: commit, draft: false, prerelease: isPrerelease(version), make_latest: isPrerelease(version) ? "false" : "true" };
  return ["gh", "api", "--method", "PATCH", `repos/${REPOSITORY}/releases/${releaseId}`, ...Object.entries(fields).flatMap(([key, value]) => [typeof value === "boolean" ? "-F" : "-f", `${key}=${value}`]), "--silent"];
}

/** Assets uploaded but not matching the build, by name: missing, extra, or a different size. */
export function assetMismatches(local: Asset[], remote: Array<{ name: string; size: number; state?: string }>): string[] {
  const problems: string[] = [];
  for (const asset of local) {
    const found = remote.find((candidate) => candidate.name === asset.name);
    if (!found) problems.push(`${asset.name} is not uploaded`);
    else if (found.size !== asset.size || (found.state && found.state !== "uploaded")) problems.push(`${asset.name} is ${found.size} bytes (${found.state ?? "?"}), not ${asset.size}`);
  }
  for (const extra of remote.filter((candidate) => !local.some((asset) => asset.name === candidate.name))) problems.push(`${extra.name} is on the release but not in the build`);
  return problems;
}

export async function publish(config: ReleaseConfig, options: { confirm: boolean; dryRun: boolean }): Promise<{ done: string[]; next: string }> {
  const receipt = await readReceipt(config);
  const tag = tagOf(receipt.version), assets = receipt.assets;
  const done = [`${config.out} holds the ${assets.length} files the build stage verified`];

  if (options.dryRun) {
    console.log(`  ok  ${done[0]}`);
    const total = assets.reduce((sum, asset) => sum + asset.size, 0);
    console.log(`\nwould publish ${tag} from ${receipt.commit.slice(0, 7)} (${receipt.rehearsal ? "a rehearsal build, which never publishes" : "a release build"}): ${assets.length} assets, ${(total / 1024 ** 2).toFixed(1)} MiB`);
    for (const asset of assets) console.log(`  ${asset.sha256}  ${String(asset.size).padStart(12)}  ${asset.name}`);
    console.log("\nwould run:");
    for (const command of draftCommands(receipt.version, receipt.commit, config.out, assets, false)) console.log(`  ${commandLine(command)}`);
    console.log(`  (then download each asset back and compare its SHA-256, and stop at the draft)\nand on publish --confirm:\n  ${commandLine(confirmCommand("DRAFT_ID", receipt.version, receipt.commit))}`);
    return { done: ["printed the plan; GitHub was not called"], next: receipt.rehearsal ? "nothing: a rehearsal ends here" : "npm run release -- publish" };
  }
  if (receipt.rehearsal || config.rehearsal) throw new Error("A rehearsal never publishes: run publish --dry-run to see the plan, or build without --rehearsal on main");
  const head = capture("git", ["rev-parse", "HEAD"], { cwd: config.root }).stdout.trim();
  if (head !== receipt.commit) throw new Error(`HEAD (${head.slice(0, 7)}) is not the commit ${config.out} was built from (${receipt.commit.slice(0, 7)}): check that commit out, or build again`);

  let release = findRelease(tag);
  if (!options.confirm) {
    if (release && !release.draft) throw new Error(`${tag} is already published; a published release is never re-uploaded. Bump the version for a new one`);
    if (release && release.target_commitish !== receipt.commit) throw new Error(`the draft ${tag} targets ${release.target_commitish}, not ${receipt.commit}: delete it (gh release delete ${tag} --repo ${REPOSITORY}) and publish again`);
    for (const command of draftCommands(receipt.version, receipt.commit, config.out, assets, !!release)) await step(command[0], command.slice(1));
    release = findRelease(tag);
    if (!release?.draft) throw new Error(`the draft ${tag} did not appear on ${REPOSITORY}`);
    const mismatches = assetMismatches(assets, release.assets);
    if (mismatches.length) throw new Error(`the draft's assets do not match the build: ${mismatches.join("; ")}`);
    for (const asset of release.assets) {
      const local = assets.find((candidate) => candidate.name === asset.name)!;
      const remote = await downloadedSha256(asset.id);
      if (remote !== local.sha256) throw new Error(`${asset.name} downloaded back as ${remote}, not ${local.sha256}: run publish again to re-upload it`);
      console.log(`  ok  ${asset.name} downloads back with its SHA-256`);
    }
    done.push(`draft ${tag} holds all ${assets.length} assets, each downloaded back with its SHA-256: ${release.html_url}`);
    return { done, next: `review the draft, then make it public: npm run release -- publish --confirm` };
  }

  if (!release) throw new Error(`there is no draft ${tag}: run npm run release -- publish first`);
  if (release.draft) {
    if (release.target_commitish !== receipt.commit) throw new Error(`the draft ${tag} targets ${release.target_commitish}, not the build's ${receipt.commit}`);
    const mismatches = assetMismatches(assets, release.assets);
    if (mismatches.length) throw new Error(`the draft's assets do not match the build: ${mismatches.join("; ")}; run npm run release -- publish again`);
    await step("gh", confirmCommand(release.id, receipt.version, receipt.commit).slice(1));
    done.push(`${tag} is public${isPrerelease(receipt.version) ? " as a prerelease (latest stays where it was)" : ""}`);
  } else done.push(`${tag} was already public`);

  const remoteTag = capture("git", ["ls-remote", "origin", `refs/tags/${tag}`], { cwd: config.root }).stdout.split(/\s/)[0];
  if (remoteTag !== receipt.commit) throw new Error(`origin's tag ${tag} names ${remoteTag || "nothing"}, not ${receipt.commit}`);
  done.push(`tag ${tag} names ${receipt.commit.slice(0, 7)}`);
  if (!isPrerelease(receipt.version)) {
    const local = (name: string) => readFileSync(join(config.out, name));
    await until(`${FEED_URL} to serve ${tag}'s appcast.xml`, async () => equalBytes(await fetchBytes(FEED_URL), local("appcast.xml")));
    done.push(`${FEED_URL} serves ${tag}'s feed`);
    const latest = `https://github.com/${REPOSITORY}/releases/latest/download/release.json`;
    await until(`${latest} to be ${tag}'s manifest`, async () => equalBytes(await fetchBytes(latest), local("release.json")));
    done.push(`releases/latest/download/release.json is ${tag}'s manifest: new installs get ${receipt.version}`);
  }
  capture("git", ["fetch", "--quiet", "--tags", "origin"], { cwd: config.root });
  return { done, next: "installed apps offer the update at their next hourly check; watch the issue tracker" };
}

/** The release named `tag`, drafts included (only the API's list shows drafts). */
function findRelease(tag: string): GitHubRelease | undefined {
  const fields = ".[] | {id, tag_name, draft, prerelease, target_commitish, html_url, assets: [.assets[] | {id, name, size, state}]}";
  const listed = capture("gh", ["api", "--paginate", `repos/${REPOSITORY}/releases?per_page=100`, "--jq", fields]);
  if (listed.code !== 0) throw new Error(`could not list ${REPOSITORY}'s releases: ${listed.stderr.trim()}`);
  const releases = listed.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as GitHubRelease);
  return releases.find((release) => release.tag_name === tag);
}

/** An asset's SHA-256 as GitHub serves it, streamed (an image part is up to 2 GiB). */
function downloadedSha256(assetId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const child = spawn("gh", ["api", "-H", "Accept: application/octet-stream", `repos/${REPOSITORY}/releases/assets/${assetId}`], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", (chunk) => hash.update(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(hash.digest("hex")) : reject(new Error(`downloading asset ${assetId} failed: ${stderr.trim()}`)));
  });
}

async function fetchBytes(url: string): Promise<Buffer | undefined> {
  try {
    const response = await fetch(url, { redirect: "follow", cache: "no-store" });
    return response.ok ? Buffer.from(await response.arrayBuffer()) : undefined;
  } catch { return undefined; }
}

const equalBytes = (a: Buffer | undefined, b: Buffer) => !!a && a.equals(b);

/** GitHub's `latest` and its CDN take a little while to move; up to five minutes. */
async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  for (const deadline = Date.now() + 5 * 60_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 10_000))) if (await check()) return;
  throw new Error(`timed out waiting for ${what}: the release is public, so check it by hand (and see DEVELOPMENT.md, "Withdrawing a release")`);
}
