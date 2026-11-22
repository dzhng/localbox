import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { ensureBuiltinImage, releaseBase, type EnsureOptions, type ImageProgress } from "../apps/cli/src/builtin-image.js";
import { makeManifest, sha256, signManifest, writeRelease, type ReleaseManifest } from "../scripts/release.js";
import { imageRelease, startFaultServer, type FaultServer, type Faults } from "../scripts/proof/lib/image-release.js";

// `localbox app image ensure` against a local release folder served with spike 04's faults. Keys are scratch pairs.
const VERSION = "0.11.0";
const keys = generateKeyPairSync("ed25519"), other = generateKeyPairSync("ed25519");
const pem = (key: typeof keys.publicKey) => key.export({ type: "spki", format: "pem" }).toString();
let root: string, release: string, manifest: ReleaseManifest;
const servers: FaultServer[] = [];

before(async () => {
  root = await mkdtemp(join(tmpdir(), "localbox-builtin-image-"));
  release = join(root, "release");
  manifest = await imageRelease(release, VERSION, keys.privateKey, { parts: 3 });
});
after(async () => { for (const server of servers) await server.close(); await rm(root, { recursive: true, force: true }); });

const image = () => manifest.image!;
const parts = () => image().parts;
const sizeOf = (name: string) => manifest.artifacts.find((entry) => entry.name === name)!.size;

/** A machine root of its own: images, downloads and the progress file, as `machinePaths()` names them. */
async function machine(name: string) {
  const dir = join(root, "machines", name);
  await mkdir(join(dir, "images"), { recursive: true });
  return { images: join(dir, "images"), downloads: join(dir, "downloads"), progressFile: join(dir, "builtin-image.json") };
}

async function serve(faults: Faults = {}, dir = release) {
  const server = await startFaultServer(dir, faults); servers.push(server); return server;
}

/** One `ensure` run; every line it printed, and whether the images directory ever held a temporary of the image. */
async function ensure(paths: Awaited<ReturnType<typeof machine>>, base: string, options: Partial<EnsureOptions> = {}) {
  const lines: ImageProgress[] = []; let sawTemporary = false;
  const outcome = await ensureBuiltinImage({
    version: VERSION, base, publicKeyPem: pem(keys.publicKey), ...paths, retries: 0, ...options,
    emit: (line) => { lines.push(line); if (readdirSync(paths.images).some((entry) => entry.startsWith(".linux."))) sawTemporary = true; },
  });
  return { ...outcome, lines, sawTemporary };
}

async function assertInstalled(paths: Awaited<ReturnType<typeof machine>>) {
  assert.deepEqual(await readdir(paths.images), ["linux"]);
  assert.equal(await sha256(join(paths.images, "linux/disk.img")), image().sha256);
  const allocated = (await stat(join(paths.images, "linux/disk.img"))).blocks * 512;
  assert.ok(allocated < image().size / 2, `the installed disk keeps its holes (${allocated} of ${image().size} bytes allocated)`);
  assert.equal(await readFile(join(paths.images, "linux/boot/efi-vars"), "utf8"), `variable store ${VERSION}`);
  assert.ok(!existsSync(join(paths.downloads, `linux-${VERSION}`)), "the staging directory is gone");
  const recorded = JSON.parse(await readFile(paths.progressFile, "utf8")) as ImageProgress;
  assert.equal(recorded.phase, "ready"); assert.equal(recorded.image_sha256, image().sha256);
}

/** An older image already installed, so "untouched" can be checked byte for byte. */
async function seedOlder(paths: Awaited<ReturnType<typeof machine>>) {
  await mkdir(join(paths.images, "linux/boot"), { recursive: true });
  for (const [file, text] of [["disk.img", "older disk"], ["image.json", "{\"older\":true}"], ["boot/efi-vars", "older vars"]]) await writeFile(join(paths.images, "linux", file), text);
}
const listing = async (dir: string) => Promise.all(((await readdir(dir, { recursive: true })) as string[]).sort().map(async (name) => `${name}:${(await stat(join(dir, name))).isFile() ? await sha256(join(dir, name)) : "dir"}`));

test("a Mac with no image gets it: downloading, expanding, installing, ready, with the progress file at each step", async () => {
  const paths = await machine("fresh"), server = await serve();
  const run = await ensure(paths, server.url);
  assert.equal(run.state, "ready", JSON.stringify(run.line));
  const phases = run.lines.map((line) => line.phase).filter((phase, index, all) => phase !== all[index - 1]);
  assert.deepEqual(phases, ["downloading", "expanding", "installing", "ready"]);
  const downloaded = run.lines.filter((line) => line.phase === "downloading");
  assert.ok(downloaded.every((line, index) => index === 0 || line.done_bytes >= downloaded[index - 1].done_bytes), "bytes only climb");
  assert.equal(downloaded.at(-1)!.done_bytes, downloaded.at(-1)!.total_bytes);
  assert.ok(!run.sawTemporary, "the image never sat in the images directory under a name the daemon's sweep deletes");
  await assertInstalled(paths);
});

test("a cut connection ends failed with the partial kept; the next run asks only for the missing bytes", async () => {
  const paths = await machine("resume"), server = await serve({ drop: { name: parts()[1], fraction: 0.4 } });
  const first = await ensure(paths, server.url);
  assert.equal(first.state, "failed"); assert.match(first.line.error!, /connection was lost/);
  assert.ok(!existsSync(join(paths.images, "linux")));
  const kept = (await stat(join(paths.downloads, `linux-${VERSION}`, `${parts()[1]}.partial`))).size;
  assert.ok(kept > 0 && kept <= Math.floor(sizeOf(parts()[1]) * 0.4), `the partial holds what arrived before the cut (${kept})`);
  const mark = server.requests.length;
  const second = await ensure(paths, server.url);
  assert.equal(second.state, "ready", JSON.stringify(second.line));
  const asked = server.requests.slice(mark);
  assert.ok(!asked.some((request) => request.name === parts()[0]), "the finished first part is not asked for again");
  const resumed = asked.find((request) => request.name === parts()[1])!;
  assert.deepEqual([resumed.range, resumed.status, resumed.sent], [`bytes=${kept}-`, 206, sizeOf(parts()[1]) - kept]);
  await assertInstalled(paths);
});

test("a cut inside one run is resumed by that run", async () => {
  const paths = await machine("resume-in-run"), server = await serve({ drop: { name: parts()[2], fraction: 0.5 } });
  assert.equal((await ensure(paths, server.url, { retries: 2 })).state, "ready");
  assert.equal(server.requests.filter((request) => request.name === parts()[2]).length, 2);
  await assertInstalled(paths);
});

for (const [name, faults, expected, onlyManifest, publicKey] of [
  ["a truncated part", { truncate: { name: "PART1", bytes: 1000 } }, /the server has 1000 bytes, the manifest \d+/, false, keys.publicKey],
  ["a flipped byte", { flip: { name: "PART1", offset: 777 } }, /checksum mismatch: localbox-linux-0\.11\.0\.disk\.img\.zst\.001/, false, keys.publicKey],
  ["a manifest signed by another key", {}, /signature verification failed/, true, other.publicKey],
] as const) {
  test(`${name} ends failed and leaves images/linux as it was`, async () => {
    for (const seeded of [false, true]) {
      const paths = await machine(`${name}-${seeded}`.replace(/\W+/g, "-"));
      if (seeded) await seedOlder(paths);
      const before = seeded ? await listing(join(paths.images, "linux")) : undefined;
      const named = JSON.parse(JSON.stringify(faults).replaceAll("PART1", parts()[1])) as Faults;
      const server = await serve(named);
      const run = await ensure(paths, server.url, { retries: 2, publicKeyPem: pem(publicKey) });
      assert.equal(run.state, "failed"); assert.match(run.line.error!, expected);
      assert.ok(!run.lines.some((line) => ["expanding", "installing", "ready"].includes(line.phase)));
      assert.equal(JSON.parse(await readFile(paths.progressFile, "utf8")).phase, "failed", "the progress file says so");
      if (seeded) assert.deepEqual(await listing(join(paths.images, "linux")), before); else assert.deepEqual(await readdir(paths.images), []);
      if (onlyManifest) assert.deepEqual(server.requests.map((request) => request.name), ["release.json"], "nothing is fetched on an unverified manifest's word");
      else assert.ok(!existsSync(join(paths.downloads, `linux-${VERSION}`, `${parts()[1]}.partial`)), "the bad part is not kept to be resumed");
    }
  });
}

test("an image already current is not downloaded again: the same release asks nothing, an update with the same image only its manifest", async () => {
  const paths = await machine("current");
  const server = await serve();
  assert.equal((await ensure(paths, server.url)).state, "ready");
  const mark = server.requests.length;
  const again = await ensure(paths, server.url);
  assert.equal(again.state, "ready");
  assert.equal(server.requests.length, mark, "this release installed it, so nothing is asked (a relaunch, or a Mac offline)");

  // The next release ships the same image artifacts under a new manifest.
  const next = join(root, "release-next");
  await cp(release, next, { recursive: true });
  await rm(join(next, "release.json")); await rm(join(next, "SHA256SUMS"));
  await writeRelease(next, signManifest(await makeManifest(next, "0.12.0", manifest.imageDigest, undefined, manifest.image), keys.privateKey, "scratch"));
  const updated = await serve({}, next);
  const run = await ensure(paths, updated.url, { version: "0.12.0" });
  assert.equal(run.state, "ready", JSON.stringify(run.line));
  assert.deepEqual(updated.requests.map((request) => request.name), ["release.json"], "no part was asked for");
  assert.equal(JSON.parse(await readFile(paths.progressFile, "utf8")).version, "0.12.0");

  // A Mac whose image someone replaced is not "current", whatever the record says.
  await writeFile(join(paths.images, "linux/image.json"), "{}");
  assert.equal((await ensure(paths, server.url)).state, "ready");
  assert.ok(server.requests.slice(mark).some((request) => request.name === parts()[0]), "it was downloaded again");
  await assertInstalled(paths);
});

test("a second ensure while one runs answers at once with the running one's progress, and does nothing", async () => {
  const paths = await machine("concurrent"), server = await serve({ hold: { name: parts()[1], fraction: 0.5 } });
  const first = ensure(paths, server.url);
  await server.held;
  // The first run reports at most every 250 ms; let it say how far it got.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const requests = server.requests.length;
  const second = await ensure(paths, server.url);
  assert.equal(second.state, "running");
  assert.equal(second.line.phase, "downloading"); assert.ok(second.line.done_bytes > 0, JSON.stringify(second.line));
  assert.equal(server.requests.length, requests, "the second run asked for nothing");
  server.release();
  assert.equal((await first).state, "ready");
  await assertInstalled(paths);
});

test("a stale lock (its process is gone) is taken over, and a file: release folder works as a web one does", async () => {
  const paths = await machine("stale");
  await mkdir(join(paths.downloads, `linux-${VERSION}`), { recursive: true });
  await writeFile(join(paths.downloads, `linux-${VERSION}`, "lock"), "999999 deadbeef\n");
  // A staging directory a past release left is removed.
  await mkdir(join(paths.downloads, "linux-0.9.0"), { recursive: true }); await writeFile(join(paths.downloads, "linux-0.9.0/part"), "old");
  const run = await ensure(paths, pathToFileURL(release).href);
  assert.equal(run.state, "ready", JSON.stringify(run.line));
  assert.deepEqual(await readdir(paths.downloads), []);
  await assertInstalled(paths);
});

test("the release folder is this version's on GitHub unless the repository or the whole folder is overridden", () => {
  assert.equal(releaseBase("0.11.0", {}), "https://github.com/dzhng/localbox/releases/download/v0.11.0");
  assert.equal(releaseBase("0.11.0", { LOCALBOX_RELEASE_REPOSITORY: "someone/fork" }), "https://github.com/someone/fork/releases/download/v0.11.0");
  assert.equal(releaseBase("0.11.0", { LOCALBOX_RELEASE_URL: "http://127.0.0.1:8080/" }), "http://127.0.0.1:8080");
});
