// Spike 04, throwaway: does `Range` survive GitHub's redirect from `releases/download/...` to its asset host?
// Fetches a window from the middle of one release asset with Node's `fetch`, cuts it at 40%, resumes, and compares
// the stitched bytes with the same window fetched in one piece by curl. Never downloads the whole asset.
//
//   node_modules/.bin/tsx specs/menu-bar-app/spikes/04/run-github-range.ts <asset url> <asset size> [window MiB]
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const [url, sizeText, windowText] = process.argv.slice(2);
const size = Number(sizeText), window = Number(windowText ?? 48) * 2 ** 20;
const from = Math.floor(size / 2), to = from + window - 1;
const headers = { "user-agent": "range-probe" };
const out = (line: string) => process.stdout.write(`${line}\n`);
const place = (location: string | null) => { if (!location) return "(none)"; const u = new URL(location); return `${u.host}${u.pathname.replace(/[0-9a-f-]{20,}/g, "<id>")} (query of ${u.search.length} chars omitted)`; };

out(`asset ${url}, ${size} bytes; window bytes ${from}-${to} (${window} bytes)`);
const hop = await fetch(url!, { headers: { ...headers, range: `bytes=${from}-${to}` }, redirect: "manual" });
out(`hop 1 (no follow): HTTP ${hop.status}, location ${place(hop.headers.get("location"))}`);
await hop.body?.cancel();

/** Read `bytes=start-to` through the redirect, stopping after `limit` bytes when given. */
async function range(start: number, limit?: number): Promise<Buffer> {
  const control = new AbortController();
  const began = Date.now();
  const response = await fetch(url!, { headers: { ...headers, range: `bytes=${start}-${to}` }, signal: control.signal });
  out(`  GET range=bytes=${start}-${to} -> HTTP ${response.status}; redirected=${response.redirected}; final host ${new URL(response.url).host}; content-range ${response.headers.get("content-range")}; content-length ${response.headers.get("content-length")}; accept-ranges ${response.headers.get("accept-ranges")}`);
  assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), `bytes ${start}-${to}/${size}`);
  const chunks: Buffer[] = []; let got = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk)); got += chunk.length;
      if (limit !== undefined && got >= limit) { control.abort(); break; }
    }
  } catch (error) { if (!control.signal.aborted) throw error; }
  const seconds = (Date.now() - began) / 1000;
  out(`  ${limit === undefined ? "read to the end" : "CUT by the client"}: ${got} bytes in ${seconds.toFixed(2)} s (${(got / 2 ** 20 / seconds).toFixed(1)} MiB/s)`);
  return Buffer.concat(chunks);
}

out("run 1, cut at 40% of the window:");
const head = await range(from, Math.floor(window * 0.4));
out("run 2, resumed from the byte after the last one kept:");
const tail = await range(from + head.length);
const stitched = Buffer.concat([head, tail]);
assert.equal(stitched.length, window);
const digest = createHash("sha256").update(stitched).digest("hex");
out(`stitched ${stitched.length} bytes, sha256 ${digest}`);

const dir = await mkdtemp(join(tmpdir(), "spike04-github-"));
try {
  const file = join(dir, "window.bin");
  const { stdout } = await promisify(execFile)("curl", ["-sL", "-A", "range-probe", "-r", `${from}-${to}`, "-o", file, "-w", "%{http_code} redirects=%{num_redirects} bytes=%{size_download} seconds=%{time_total}", url!]);
  const control = createHash("sha256").update(await readFile(file)).digest("hex");
  out(`control, curl -L -r ${from}-${to} in one piece: ${stdout}; sha256 ${control}`);
  assert.equal(digest, control);
  out("PASS: the cut-and-resumed window is byte-identical to the one-piece window");
} finally { await rm(dir, { recursive: true, force: true }); out(`scratch removed: ${dir}`); }
