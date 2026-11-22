import { createHash, randomBytes, type KeyObject } from "node:crypto";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { makeManifest, signManifest, writeRelease, type ReleaseManifest } from "../../release.js";

/**
 * A release folder whose only artifacts are a small built-in image, signed with `privateKey` (a scratch key): a disk
 * of `diskBytes` with `dataBytes` of random data (so it does not compress) and holes after it, compressed with Node's
 * zstd and split into `parts` parts named as `packImage` names them. Tests and probes serve it with `startFaultServer`.
 * The default disk is 32 MiB because APFS allocates a file of 16 MiB or less whole, holes and all.
 */
export async function imageRelease(dir: string, version: string, privateKey: KeyObject, options: { diskBytes?: number; dataBytes?: number; parts?: number } = {}): Promise<ReleaseManifest> {
  const diskBytes = options.diskBytes ?? 32 * 1024 * 1024, dataBytes = options.dataBytes ?? 2 * 1024 * 1024, count = options.parts ?? 3;
  await mkdir(dir, { recursive: true });
  const disk = Buffer.alloc(diskBytes);
  randomBytes(dataBytes).copy(disk, 1024 * 1024);
  disk.write("tail", diskBytes - 4);
  const compressed = zstdCompressSync(disk);
  const prefix = `localbox-linux-${version}`, partBytes = Math.ceil(compressed.length / count);
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = `${prefix}.disk.img.zst.${String(index).padStart(3, "0")}`;
    await writeFile(join(dir, name), compressed.subarray(index * partBytes, (index + 1) * partBytes)); parts.push(name);
  }
  await writeFile(join(dir, `${prefix}.efi-vars`), `variable store ${version}`);
  await writeFile(join(dir, `${prefix}.image.json`), JSON.stringify({ image_id: "linux", os: "linux", size_bytes: diskBytes, agent_version: version }));
  const image = { sha256: createHash("sha256").update(disk).digest("hex"), size: diskBytes, parts, bootStore: `${prefix}.efi-vars`, manifest: `${prefix}.image.json` };
  const manifest = signManifest(await makeManifest(dir, version, `sha256:${image.sha256}`, undefined, image), privateKey, "scratch");
  await writeRelease(dir, manifest);
  return manifest;
}

export interface Faults {
  /** Destroy the connection once the answer for `name` has reached `fraction` of the file. One shot. */
  drop?: { name: string; fraction: number };
  /** Serve `name` as if it were only `bytes` long (an honest, short asset). */
  truncate?: { name: string; bytes: number };
  /** Flip one bit of the byte at `offset` of `name`. */
  flip?: { name: string; offset: number };
  /** Stop sending `name` at `fraction` of it until `release()`. One shot. */
  hold?: { name: string; fraction: number };
}
export interface RequestRecord { name: string; range: string | null; status: number; sent: number; dropped: boolean }
export interface FaultServer {
  url: string; requests: RequestRecord[]; faults: Faults;
  /** Resolves once a held answer has stopped at its byte. */
  held: Promise<void>;
  release(): void;
  close(): Promise<void>;
}

/** A static server over one folder, with `Range`, as GitHub's release downloads answer, and the faults above (spike 04). */
export async function startFaultServer(dir: string, faults: Faults = {}): Promise<FaultServer> {
  const requests: RequestRecord[] = [];
  let reachedHold!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => { reachedHold = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const state: FaultServer = { url: "", requests, faults, held, release: () => release(), close: async () => undefined };
  const server: Server = createServer(async (request, response) => {
    const name = basename(new URL(request.url ?? "/", "http://x").pathname);
    const range = request.headers.range ?? null;
    const record: RequestRecord = { name, range, status: 0, sent: 0, dropped: false };
    requests.push(record);
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (!info?.isFile()) { record.status = 404; response.writeHead(404).end(); return; }
    const f = state.faults;
    const size = f.truncate?.name === name ? Math.min(f.truncate.bytes, info.size) : info.size;
    let start = 0, end = size - 1, status = 200;
    const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    if (match) {
      start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), size - 1);
      if (start >= size) { record.status = 416; response.writeHead(416, { "content-range": `bytes */${size}` }).end(); return; }
      status = 206;
    }
    record.status = status;
    response.writeHead(status, { "content-type": "application/octet-stream", "accept-ranges": "bytes", "content-length": end - start + 1, ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
    if (size === 0) { response.end(); return; }
    const dropAt = f.drop?.name === name ? Math.floor(size * f.drop.fraction) : undefined;
    let holdAt = f.hold?.name === name ? Math.floor(size * f.hold.fraction) : undefined;
    const file = await open(join(dir, name), "r");
    try {
      for (let position = start; position <= end;) {
        let stopAt = end + 1;
        if (dropAt !== undefined && dropAt >= position) stopAt = Math.min(stopAt, dropAt);
        if (holdAt !== undefined && holdAt >= position) stopAt = Math.min(stopAt, holdAt);
        const length = Math.min(64 * 1024, stopAt - position);
        if (length > 0) {
          const chunk = Buffer.alloc(length);
          await file.read(chunk, 0, length, position);
          if (f.flip?.name === name && f.flip.offset >= position && f.flip.offset < position + length) chunk[f.flip.offset - position] ^= 0x01;
          if (!response.write(chunk)) await new Promise((resolve) => response.once("drain", resolve));
          position += length; record.sent += length;
          continue;
        }
        if (position === dropAt) {
          record.dropped = true; state.faults = { ...state.faults, drop: undefined };
          // Flush what precedes the cut, then kill the connection without ending the answer.
          await new Promise<void>((resolve) => response.write(Buffer.alloc(0), () => resolve()));
          response.socket?.destroy(); return;
        }
        if (position === holdAt) {
          state.faults = { ...state.faults, hold: undefined }; holdAt = undefined;
          reachedHold();
          await Promise.race([released, new Promise((resolve) => response.once("close", resolve))]);
          if (response.destroyed) return;
        }
      }
      response.end();
    } catch { response.destroy(); } finally { await file.close(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => { release(); server.closeAllConnections(); server.close(() => resolve()); });
  return state;
}
