// Spike 04, throwaway: the fault scenarios against a small sparse fixture image. Everything lives in one temp dir.
//
//   node_modules/.bin/tsx specs/menu-bar-app/spikes/04/run-fixture.ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, signManifest, type ReleaseManifest } from "../../../../scripts/release.js";
import { startFaultServer, type FaultServer, type Faults } from "./fault-server.js";
import { listing, out, packRelease, runFetcher, sampleDisk, scratchKeys } from "./harness.js";

const root = await mkdtemp(join(tmpdir(), "spike04-fixture-"));
out(`scratch ${root}`);
let failed = false;
try {
  // A 64 MiB disk: 6 MiB of random data (so it does not compress and splits into parts), the rest holes.
  const built = join(root, "built"); await mkdir(join(built, "boot"), { recursive: true });
  const disk = await open(join(built, "disk.img"), "w"); await disk.truncate(64 * 1024 * 1024);
  await disk.write(randomBytes(6 * 1024 * 1024), 0, 6 * 1024 * 1024, 1024 * 1024); await disk.write(Buffer.from("tail"), 0, 4, 64 * 1024 * 1024 - 4); await disk.close();
  await writeFile(join(built, "boot/efi-vars"), "variable store");
  await writeFile(join(built, "image.json"), JSON.stringify({ image_id: "linux", os: "linux", size_bytes: 8192, agent_version: "spike" }));

  const keys = await scratchKeys(root); const other = await scratchKeys(root, "other");
  const release = join(root, "release"); await mkdir(release);
  const manifest = await packRelease(built, release, "0.0.4", keys.privateKey, { level: 1, partBytes: 2 * 1024 * 1024 });
  const image = manifest.image!; const parts = image.parts;
  const sizeOf = (name: string) => manifest.artifacts.find((a) => a.name === name)!.size;
  const wantedBytes = [...parts, image.bootStore, image.manifest].reduce((sum, name) => sum + sizeOf(name), 0);
  out(`fixture: disk ${image.size} bytes, ${parts.length} parts ${JSON.stringify(parts.map(sizeOf))}, image artifacts ${wantedBytes} bytes, signed with a scratch key in ${root}`);
  assert.ok(parts.length >= 3);

  const requestsOf = (server: FaultServer, from = 0) => server.requests.slice(from).map((r) => `${r.url} range=${r.range ?? "-"} -> ${r.status} sent=${r.sent}${r.dropped ? " DROPPED" : ""}`);
  const show = (title: string, rows: string[]) => { out(`  ${title}:`); for (const row of rows) out(`    ${row}`); if (rows.length === 0) out("    (none)"); };
  const scenario = async (name: string, faults: Faults, body: (ctx: { server: FaultServer; images: string; args: Record<string, string | number> }) => Promise<void>, serveDir = release) => {
    out(`\n=== ${name}`);
    const images = join(root, "images", name.replace(/\W+/g, "-")); await mkdir(images, { recursive: true });
    const server = await startFaultServer(serveDir, faults);
    try { await body({ server, images, args: { base: server.url, "public-key": keys.publicPath, images } }); out(`  PASS ${name}`); }
    catch (error) { failed = true; out(`  FAIL ${name}: ${(error as Error).stack}`); }
    finally { await server.close(); }
  };
  const assertInstalled = async (images: string) => {
    show("images directory after", await listing(images));
    assert.deepEqual(await readdir(images), ["linux"], "only images/linux remains: the staging directory is gone");
    assert.equal(await sha256(join(images, "linux/disk.img")), image.sha256);
    const s = await stat(join(images, "linux/disk.img"));
    assert.equal(s.size, image.size); assert.ok(s.blocks * 512 < image.size / 4, "the installed disk keeps its holes");
    assert.equal(await readFile(join(images, "linux/boot/efi-vars"), "utf8"), "variable store");
  };

  // 1. Outcome 1: cut at 40% of the second part, the process ends, a second process resumes.
  await scenario("resume across a quit", { drop: { name: parts[1]!, fraction: 0.4 } }, async ({ server, images, args }) => {
    const first = await runFetcher({ ...args, retries: 0 });
    assert.equal(first.code, 2, "the cut run exits 2 (interrupted, resumable)");
    show("requests, run 1", requestsOf(server));
    show("images directory between runs", await listing(images));
    assert.ok(!(await readdir(images)).includes("linux"));
    const cut = Math.floor(sizeOf(parts[1]!) * 0.4);
    // The server resets the socket, so bytes it wrote last may never arrive: the partial holds what did.
    const kept = (await stat(join(images, ".linux.fetch/0.0.4", `${parts[1]}.partial`))).size;
    out(`  server cut at ${cut}; the partial holds ${kept} (${cut - kept} bytes were lost in flight to the reset)`);
    assert.ok(kept > 0 && kept <= cut, "the partial holds the bytes that arrived before the cut");
    const mark = server.requests.length;
    const sampler = sampleDisk(images, join(images, ".linux.fetch"), 20);
    const second = await runFetcher({ ...args, retries: 0 });
    const peak = await sampler.stop();
    assert.equal(second.code, 0);
    show("requests, run 2", requestsOf(server, mark));
    const run2 = server.requests.slice(mark);
    assert.ok(!run2.some((r) => r.url === `/${parts[0]}`), "the finished first part is not requested again");
    const resumed = run2.find((r) => r.url === `/${parts[1]}`)!;
    assert.equal(resumed.range, `bytes=${kept}-`, "the resume asks from exactly what is on disk"); assert.equal(resumed.status, 206); assert.equal(resumed.sent, sizeOf(parts[1]!) - kept);
    assert.equal(run2.filter((r) => r.url !== "/release.json").length, parts.length - 1 + 2, "one request per unfinished artifact");
    const served = server.requests.filter((r) => r.url !== "/release.json").reduce((sum, r) => sum + r.sent, 0);
    out(`  bytes served for image artifacts over both runs: ${served}; image artifacts total: ${wantedBytes}`);
    assert.equal(served, wantedBytes + (cut - kept), "the only bytes sent twice are the ones the reset lost");
    out(`  disk peak during run 2 (${peak.samples} samples): staging ${peak.staging}, images outside staging ${peak.images}; parts ${wantedBytes} + expanded allocation ${(await stat(join(images, "linux/disk.img"))).blocks * 512}`);
    await assertInstalled(images);
  });

  // 1b. The same cut, retried inside one process.
  await scenario("resume inside one run", { drop: { name: parts[1]!, fraction: 0.4 } }, async ({ server, images, args }) => {
    const run = await runFetcher({ ...args, retries: 3 }, false);
    assert.equal(run.code, 0); show("requests", requestsOf(server));
    const [cutRequest, resume] = server.requests.filter((r) => r.url === `/${parts[1]}`);
    const from = Number(/^bytes=(\d+)-$/.exec(resume!.range ?? "")![1]);
    assert.ok(cutRequest!.dropped && from > 0 && from <= cutRequest!.sent); assert.equal(resume!.status, 206); assert.equal(resume!.sent, sizeOf(parts[1]!) - from);
    assert.equal(server.requests.length, 1 + parts.length + 1 + 2, "every other artifact is requested once");
    await assertInstalled(images);
  });

  // 2. Outcome 2: each fault fails closed, with images/linux absent and, seeded, untouched.
  const failsClosed = async (name: string, faults: Faults, expected: RegExp, requestsAllowed: (server: FaultServer) => void, serveDir = release, publicKey = keys.publicPath) => {
    for (const seeded of [false, true]) {
      await scenario(`${name}${seeded ? ", an older image installed" : ", no image installed"}`, faults, async ({ server, images, args }) => {
        if (seeded) { await mkdir(join(images, "linux/boot"), { recursive: true }); await writeFile(join(images, "linux/disk.img"), "older disk"); await writeFile(join(images, "linux/image.json"), "{\"older\":true}"); await writeFile(join(images, "linux/boot/efi-vars"), "older vars"); }
        const before = await listing(join(images, "linux")); const beforeDigest = seeded ? await sha256(join(images, "linux/disk.img")) : undefined;
        const run = await runFetcher({ ...args, "public-key": publicKey, retries: 3 });
        show("requests", requestsOf(server)); show("images directory after", await listing(images));
        assert.equal(run.code, 1, "exit 1: failed closed, not resumable");
        const last = run.lines.at(-1)!.line; assert.equal(last.phase, "failed"); assert.match(String(last.error), expected);
        assert.ok(!run.lines.some((l) => l.line.phase === "expanding" || l.line.phase === "installing" || l.line.phase === "ready"));
        assert.deepEqual(await listing(join(images, "linux")), before, "images/linux is as it was");
        if (seeded) assert.equal(await sha256(join(images, "linux/disk.img")), beforeDigest); else assert.ok(!(await readdir(images)).includes("linux"), "images/linux was not created");
        assert.ok(!(await readdir(images)).some((n) => n.startsWith(".linux.installing") || n.startsWith(".linux.replaced")));
        requestsAllowed(server);
      }, serveDir);
    }
  };
  const victim = parts[1]!;
  await failsClosed("truncated part", { truncate: { name: victim, bytes: Math.floor(sizeOf(victim) / 2) } }, /the server has \d+ bytes, the manifest \d+/, () => undefined);
  await failsClosed("one flipped byte", { flip: { name: victim, offset: Math.floor(sizeOf(victim) / 3) } }, /checksum mismatch/, () => undefined);
  const noParts = (server: FaultServer) => assert.deepEqual(server.requests.map((r) => r.url), ["/release.json"], "nothing but release.json was requested");
  await failsClosed("manifest signed by another key", {}, /signature verification failed/, noParts, release, other.publicPath);
  // The right key's signature over a manifest whose part digest was then changed.
  const tampered = join(root, "tampered"); await mkdir(tampered);
  const edited = JSON.parse(await readFile(join(release, "release.json"), "utf8")) as ReleaseManifest;
  edited.artifacts.find((a) => a.name === victim)!.sha256 = "0".repeat(64);
  await writeFile(join(tampered, "release.json"), JSON.stringify(edited));
  await failsClosed("manifest edited after signing", {}, /signature verification failed/, noParts, tampered);
  const unsigned = join(root, "unsigned"); await mkdir(unsigned);
  await writeFile(join(unsigned, "release.json"), JSON.stringify({ ...edited, signature: undefined }));
  await failsClosed("manifest with no signature", {}, /signature is missing/, noParts, unsigned);
  void signManifest;

  // 2b. After a tampered part fails, a clean server finishes the job and re-downloads only that part.
  await scenario("recovery after a flipped byte", { flip: { name: victim, offset: 7 } }, async ({ server, images, args }) => {
    assert.equal((await runFetcher(args, false)).code, 1);
    show("staging after the failure", await listing(join(images, ".linux.fetch")));
    assert.ok(!(await readdir(join(images, ".linux.fetch/0.0.4"))).some((n) => n.startsWith(victim)), "the bad part is discarded, not kept as a partial");
    server.faults = {}; const mark = server.requests.length;
    assert.equal((await runFetcher(args, false)).code, 0);
    show("requests, clean run", requestsOf(server, mark));
    assert.ok(!server.requests.slice(mark).some((r) => r.url === `/${parts[0]}`), "the good first part is kept");
    await assertInstalled(images);
  });
} finally {
  await rm(root, { recursive: true, force: true });
  out(`\nscratch removed: ${root}`);
}
out(failed ? "\nRESULT: FAIL" : "\nRESULT: all fixture scenarios passed");
process.exit(failed ? 1 : 0);
