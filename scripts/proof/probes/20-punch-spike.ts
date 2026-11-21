import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";

export const id = "20";
export const tiers = ["s", "l", "x"];

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
/** An image-shaped source: 8 GiB logical, 2 GiB of random data in 16 extents, the rest holes. */
const SOURCE = { size: 8 * GiB, extents: 16, extentBytes: 128 * MiB, stride: 512 * MiB };
const THROUGHPUT_ROUNDS = 3;
/** The transfer against the transport layer's own ceiling on the same path, and faster than a gigabit link. On one Mac
 * the LAN address routes through loopback, so iperf3 measures the kernel, not a wire; it is recorded, not gated. */
const THROUGHPUT_GATE = 0.7;
const MIN_GBPS = 1;

type Event = Record<string, any> & { event: string };

/** Slice 20's go/no-go: candidate exchange, punching (local first), and a chunked, resumable, authenticated
 * transfer between two `localbox-punchlab` processes, which run slice 37's ImageTransfer library. Tier s runs
 * over loopback, tier l over this Mac's LAN address with STUN and the iperf3 comparison, tier x needs a second
 * Mac on another network. */
export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "x") {
    const check = await ctx.check("punch and transfer between this Mac and a second Mac on another network", () => {
      throw new Error("blocked: no second Mac on another network; run `localbox-punchlab offer --send <file> --offer offer.json --answer answer.json` here, paste offer.json to the other Mac, run `localbox-punchlab answer offer.json --receive <dir> --answer answer.json` there, paste answer.json back (see slices/20-punch-spike.md)");
    });
    recordEvidence(ctx, "x", [check], {});
    return [check];
  }
  const work = join(ctx.root, ".localbox/proof/punch");
  mkdirSync(work, { recursive: true });
  const checks: Check[] = [];
  const measured: Record<string, unknown> = {};
  let bin = "";
  checks.push(await ctx.check("localbox-punchlab builds (release)", async () => {
    const build = await ctx.exec("swift", ["build", "-c", "release", "--package-path", "apps/macos/HostDaemon", "--product", "localbox-punchlab"]);
    assert.equal(build.code, 0, build.stderr.slice(-1500));
    bin = join((await ctx.exec("swift", ["build", "-c", "release", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim(), "localbox-punchlab");
  }));
  if (!bin) return checks;
  const source = await ensureSource(work);
  measured.source = { size: source.size, allocated: source.allocated, sha256: source.sha256 };
  const lab = new Lab(bin, work);

  if (ctx.tier === "s") {
    const loopback = ["--candidate", "127.0.0.1", "--no-stun"];
    checks.push(await ctx.check("an 8 GiB sparse file crosses loopback: sha256 matches, holes stay holes", async () => {
      const run = await lab.transfer({ source: source.path, flags: loopback });
      measured.loopback = run.receiver;
      await assertSameFile(source, run.output);
    }));
    checks.push(await ctx.check("receiver killed at 40% resumes from its bitmap and finishes intact", async () => {
      const run = await lab.transfer({ source: source.path, flags: loopback, killAt: 0.4 });
      measured.resume = { killedAt: run.killedAt, bitmapBytes: run.bitmapBytes, after: run.receiver };
      assert.ok((run.killedAt ?? 0) >= 0.4, `killed at ${run.killedAt}`);
      assert.ok(run.bitmapBytes > 0, "no resume bitmap beside the temp directory after the kill");
      const after = run.receiver;
      assert.ok(after.resumed_chunks > 0, `nothing resumed: ${JSON.stringify(after)}`);
      assert.ok(after.resumed_bytes >= 0.3 * after.data_bytes, `resumed only ${after.resumed_bytes} of ${after.data_bytes} bytes`);
      assert.equal(after.resumed_bytes + after.received_bytes, after.data_bytes);
      assert.equal(after.resume_rejected_chunks, 0);
      await assertSameFile(source, run.output);
    }));
    const small = await ensureSmallSource(work);
    checks.push(await ctx.check("a tampered datagram and a corrupted chunk are rejected and fetched again", async () => {
      const run = await lab.transfer({ source: small.path, flags: loopback, senderFlags: ["--tamper-datagram", "500", "--corrupt-chunk", "3"] });
      measured.tamper = run.receiver;
      assert.ok(run.receiver.rejected_datagrams >= 1, `AEAD rejected nothing: ${JSON.stringify(run.receiver)}`);
      assert.ok(run.receiver.rejected_chunks >= 1, `chunk sha256 rejected nothing: ${JSON.stringify(run.receiver)}`);
      await assertSameFile(small, run.output);
    }));
    checks.push(await ctx.check("a receiver with the wrong key gets no reply and the sender authenticates nothing", async () => {
      const run = await lab.transfer({ source: small.path, flags: loopback, senderFlags: ["--idle", "5"], receiverFlags: ["--key", randomBytes(32).toString("base64"), "--punch-timeout", "3"] });
      measured.wrongKey = { receiver: run.receiver, sender: run.sender };
      assert.equal(run.receiver.event, "error");
      assert.match(run.receiver.message, /no authenticated reply/);
      assert.equal(run.sender.finished, false);
      assert.ok(run.sender.rejected_datagrams >= 1);
    }));
  }

  if (ctx.tier === "l") {
    const lan = await lanAddress(ctx);
    measured.lanAddress = lan;
    checks.push(await ctx.check("Cloudflare STUN reflects this Mac's public address", async () => {
      const result = await ctx.exec(bin, ["stun"]);
      const report = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
      measured.stun = report;
      if (!report.reflexive) throw new Error(`blocked: no STUN response from stun.cloudflare.com:3478 (offline?): ${result.stdout}`);
    }));
    checks.push(await ctx.check("over the LAN address with a reflexive candidate offered, the local candidate wins", async () => {
      if (!lan) throw new Error("blocked: this Mac has no IPv4 LAN address on en0 or en1");
      const run = await lab.transfer({ source: source.path, flags: ["--candidate", lan] });
      measured.lan = { offer: run.offer, receiver: run.receiver };
      assert.ok(run.offer.candidates.some((c: Event) => c.kind === "reflexive"), `offer had no reflexive candidate: ${JSON.stringify(run.offer)}`);
      assert.equal(run.receiver.path_kind, "local", JSON.stringify(run.receiver));
      await assertSameFile(source, run.output);
    }));
    checks.push(await ctx.check(`LAN throughput is at least ${THROUGHPUT_GATE * 100}% of bare Network.framework datagrams on the same path, and at least ${MIN_GBPS} Gbps`, async () => {
      if (!lan) throw new Error("blocked: this Mac has no IPv4 LAN address on en0 or en1");
      if ((await ctx.exec("sh", ["-c", "command -v iperf3"])).code !== 0) throw new Error("blocked: iperf3 is not installed (brew install iperf3)");
      // Interleaved rounds and medians: the Mac is shared, so a single run measures its neighbours.
      const rounds: { iperfUdpGbps: number; iperfTcpGbps: number; punchGbps: number; lostFragments: number }[] = [];
      for (let round = 0; round < THROUGHPUT_ROUNDS; round++) {
        const iperfUdpGbps = await iperf(ctx, lan, ["-u", "-b", "0", "-l", "1400"]);
        const iperfTcpGbps = await iperf(ctx, lan, []);
        const run = await lab.transfer({ source: source.path, flags: ["--candidate", lan, "--no-stun"], keepOutput: false });
        rounds.push({ iperfUdpGbps, iperfTcpGbps, punchGbps: run.receiver.throughput_gbps, lostFragments: run.receiver.lost_fragments });
      }
      // Bare datagrams over the same Network.framework socket layer, no protocol: the ceiling the transport
      // itself sets on this path, swept because an open-loop blast past capacity collapses.
      const networkFramework = await blastCeiling(ctx, lab.bin, lan);
      const summary = {
        rounds,
        networkFramework,
        medianPunchGbps: median(rounds.map((r) => r.punchGbps)),
        medianIperfUdpGbps: median(rounds.map((r) => r.iperfUdpGbps)),
        medianIperfTcpGbps: median(rounds.map((r) => r.iperfTcpGbps)),
        ratioToUdp: 0,
        ratioToTcp: 0,
        ratioToNetworkFramework: 0,
        note: "this Mac's LAN address routes through lo0, so both baselines measure kernel speed, not a wire; punchlab counts file data bytes, iperf3 UDP counts 1400-byte datagram payloads",
      };
      summary.ratioToUdp = summary.medianPunchGbps / summary.medianIperfUdpGbps;
      summary.ratioToTcp = summary.medianPunchGbps / summary.medianIperfTcpGbps;
      summary.ratioToNetworkFramework = summary.medianPunchGbps / networkFramework.bestGbps;
      measured.throughput = summary;
      assert.ok(summary.ratioToNetworkFramework >= THROUGHPUT_GATE && summary.medianPunchGbps >= MIN_GBPS,
        `punchlab ${summary.medianPunchGbps.toFixed(2)} Gbps is ${(summary.ratioToNetworkFramework * 100).toFixed(0)}% of bare Network.framework datagrams; ${(summary.ratioToUdp * 100).toFixed(0)}% of iperf3 UDP ${summary.medianIperfUdpGbps.toFixed(2)} Gbps (TCP ${summary.medianIperfTcpGbps.toFixed(1)} Gbps; bare Network.framework datagrams ${networkFramework.bestGbps.toFixed(2)} Gbps)`);
    }));
  }
  recordEvidence(ctx, ctx.tier, checks, measured);
  // Each run directory holds a received copy of the source (2 GiB allocated); the source itself is kept.
  if (!ctx.keep) lab.removeRuns();
  return checks;
}

interface Source { path: string; size: number; allocated: number; sha256: string }

/** Built once and reused: writing 2 GiB of random data takes longer than the transfer. */
async function ensureSource(work: string): Promise<Source> {
  return ensureFile(join(work, "source-8g.img"), SOURCE.size, Array.from({ length: SOURCE.extents }, (_, i) => [i * SOURCE.stride, SOURCE.extentBytes]));
}

async function ensureSmallSource(work: string): Promise<Source> {
  return ensureFile(join(work, "source-small.img"), 256 * MiB, [[0, 16 * MiB], [100 * MiB, 16 * MiB]]);
}

async function ensureFile(path: string, size: number, extents: number[][]): Promise<Source> {
  const marker = `${path}.json`;
  if (existsSync(path) && existsSync(marker)) {
    const cached = JSON.parse(readFileSync(marker, "utf8")) as Source;
    if (cached.size === size && statSync(path).size === size) return cached;
  }
  rmSync(path, { force: true });
  const fd = openSync(path, "w");
  try {
    ftruncateSync(fd, size);
    for (const [offset, length] of extents) {
      for (let at = 0; at < length; at += 16 * MiB) writeSync(fd, randomBytes(Math.min(16 * MiB, length - at)), 0, Math.min(16 * MiB, length - at), offset + at);
    }
  } finally { closeSync(fd); }
  const source = { path, size, allocated: statSync(path).blocks * 512, sha256: await sha256(path) };
  writeFileSync(marker, JSON.stringify(source));
  return source;
}

async function assertSameFile(source: Source, output: string) {
  assert.equal(await sha256(output), source.sha256, "sha256 differs");
  const allocated = statSync(output).blocks * 512;
  assert.ok(allocated <= source.allocated * 1.1 + MiB, `holes not preserved: ${allocated} bytes allocated vs ${source.allocated} in the source`);
}

function sha256(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path, { highWaterMark: 4 * MiB }).on("data", (chunk) => hash.update(chunk)).on("error", fail).on("end", () => done(hash.digest("hex")));
  });
}

/** One punchlab process, its stdout parsed as JSON event lines. */
class Proc {
  readonly events: Event[] = [];
  readonly exited: Promise<number>;
  private waiters: { match: (event: Event) => boolean; done: (event: Event) => void }[] = [];
  readonly child: ChildProcess;

  constructor(bin: string, args: string[]) {
    this.child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let buffered = "";
    this.child.stdout!.on("data", (chunk) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        try { this.push(JSON.parse(line) as Event); } catch { /* not ours */ }
      }
    });
    this.child.stderr!.on("data", () => {});
    this.exited = new Promise((done) => this.child.on("close", (code) => { this.push({ event: "exit", code: code ?? -1 }); done(code ?? -1); }));
  }

  private push(event: Event) {
    this.events.push(event);
    this.waiters = this.waiters.filter((waiter) => { if (!waiter.match(event)) return true; waiter.done(event); return false; });
  }

  wait(match: (event: Event) => boolean, ms: number, what: string): Promise<Event> {
    const seen = this.events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`timed out after ${ms} ms waiting for ${what}; last events: ${JSON.stringify(this.events.slice(-3))}`)), ms);
      this.waiters.push({ match, done: (event) => { clearTimeout(timer); done(event); } });
    });
  }
}

interface TransferOptions { source: string; flags: string[]; senderFlags?: string[]; receiverFlags?: string[]; killAt?: number; keepOutput?: boolean }

class Lab {
  private runs = 0;
  constructor(readonly bin: string, private work: string) {}

  removeRuns() {
    for (let run = 1; run <= this.runs; run++) rmSync(join(this.work, `run-${run}`), { recursive: true, force: true });
  }

  /** One offer/answer exchange through files in a fresh directory, exactly as a user would paste them. */
  async transfer(options: TransferOptions) {
    const dir = join(this.work, `run-${++this.runs}`);
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const offer = join(dir, "offer.json"), answer = join(dir, "answer.json"), output = join(dir, "received");
    const senderFlags = options.senderFlags ?? [];
    const idle = senderFlags.includes("--idle") ? [] : ["--idle", "20"];
    const sender = new Proc(this.bin, ["offer", "--send", options.source, "--offer", offer, "--answer", answer, ...idle, ...options.flags, ...senderFlags]);
    const receiverArgs = ["answer", offer, "--receive", output, "--answer", answer, ...options.flags, ...(options.receiverFlags ?? [])];
    try {
      const offered = await sender.wait((e) => e.event === "offer" || e.event === "error" || e.event === "exit", 60_000, "the offer");
      if (offered.event !== "offer") throw new Error(`sender failed: ${JSON.stringify(offered)}`);
      let receiver = new Proc(this.bin, receiverArgs);
      let killedAt: number | undefined; let bitmapBytes = 0;
      if (options.killAt !== undefined) {
        const at = await receiver.wait((e) => (e.event === "progress" && e.fraction >= options.killAt!) || e.event === "done" || e.event === "exit", 120_000, `progress ${options.killAt}`);
        if (at.event !== "progress") throw new Error(`receiver finished before it could be killed: ${JSON.stringify(at)}`);
        receiver.child.kill("SIGKILL"); await receiver.exited;
        killedAt = at.fraction;
        bitmapBytes = existsSync(`${output}.resume`) ? statSync(`${output}.resume`).size : 0;
        receiver = new Proc(this.bin, receiverArgs);
      }
      const finished = await receiver.wait((e) => e.event === "done" || e.event === "error" || e.event === "exit", 180_000, "the receiver's report");
      const senderReport = await sender.wait((e) => e.event === "done" || e.event === "idle" || e.event === "error" || e.event === "exit", 30_000, "the sender's report");
      const result = { offer: offered, receiver: finished, sender: senderReport, killedAt, bitmapBytes, output: join(output, options.source.split("/").at(-1)!) };
      if (options.keepOutput === false) rmSync(dir, { recursive: true, force: true });
      return result;
    } finally {
      sender.child.kill("SIGKILL");
    }
  }
}

async function lanAddress(ctx: ProofContext): Promise<string | undefined> {
  for (const iface of ["en0", "en1"]) {
    const result = await ctx.exec("ipconfig", ["getifaddr", iface]);
    if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return undefined;
}

async function iperf(ctx: ProofContext, address: string, flags: string[]): Promise<number> {
  const port = String(5300 + Math.floor(Math.random() * 500));
  const server = spawn("iperf3", ["-s", "-1", "-p", port], { stdio: "ignore" });
  try {
    await new Promise((done) => setTimeout(done, 400));
    const result = await ctx.exec("iperf3", ["-c", address, "-p", port, "-t", "3", "-J", ...flags]);
    const end = JSON.parse(result.stdout).end;
    if (flags.includes("-u")) return end.sum.bits_per_second * (1 - (end.sum.lost_percent ?? 0) / 100) / 1e9;
    return end.sum_received.bits_per_second / 1e9;
  } finally { server.kill(); }
}

async function blastCeiling(ctx: ProofContext, bin: string, address: string) {
  const sweep: { offeredPps: number; deliveredPps: number; gbps: number }[] = [];
  for (const rate of [150_000, 200_000, 250_000, 300_000]) {
    const sender = new Proc(bin, ["blast-send", "--rate", String(rate), "--seconds", "3"]);
    try {
      const listening = await sender.wait((e) => e.event === "listening" || e.event === "exit", 10_000, "the blast sender");
      const result = await ctx.exec(bin, ["blast-receive", "--to", address, "--port", String(listening.port), "--seconds", "4"]);
      const blast = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
      sweep.push({ offeredPps: rate, deliveredPps: blast.pps, gbps: blast.gbps });
    } finally { sender.child.kill("SIGKILL"); }
  }
  return { sweep, bestGbps: Math.max(...sweep.map((point) => point.gbps)) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** One evidence file for every tier, so `--tier s` then `--tier l` both land in it. */
function recordEvidence(ctx: ProofContext, tier: string, checks: Check[], measured: Record<string, unknown>) {
  const directory = join(ctx.root, "specs/sandbox-images/evidence"); mkdirSync(directory, { recursive: true });
  const path = join(directory, "20-punch.json");
  const evidence = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  evidence[tier] = { at: new Date().toISOString(), checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })), ...measured };
  // The evidence is committed: this network's public address (STUN's answer) never goes in it.
  const publicAddress = /\b(?!(?:10|127)\.)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?!100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
  writeFileSync(path, `${JSON.stringify(evidence, null, 2).replace(publicAddress, "<public>")}\n`);
}
