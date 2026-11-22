// Spike 04, throwaway: a static HTTP server over one directory, with Range support and injectable faults.
import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AddressInfo } from "node:net";

export interface Faults {
  /** Destroy the socket once the response for `name` has reached `fraction` of the file. One shot. */
  drop?: { name: string; fraction: number };
  /** Serve `name` as if the file were only `bytes` long (an honest, short asset). */
  truncate?: { name: string; bytes: number };
  /** Flip one bit of the byte at absolute `offset` of `name`. */
  flip?: { name: string; offset: number };
}
export interface RequestRecord { url: string; range: string | null; status: number; sent: number; dropped: boolean }
export interface FaultServer { url: string; requests: RequestRecord[]; faults: Faults; close(): Promise<void> }

export async function startFaultServer(dir: string, faults: Faults = {}): Promise<FaultServer> {
  const requests: RequestRecord[] = [];
  const state: FaultServer = { url: "", requests, faults, close: async () => undefined };
  const server: Server = createServer(async (request, response) => {
    const name = basename(new URL(request.url ?? "/", "http://x").pathname);
    const range = request.headers.range ?? null;
    const record: RequestRecord = { url: `/${name}`, range, status: 0, sent: 0, dropped: false };
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
    let position = start;
    const stream = createReadStream(join(dir, name), { start, end, highWaterMark: 64 * 1024 });
    stream.on("data", (raw) => {
      let chunk = raw as Buffer;
      if (f.flip?.name === name && f.flip.offset >= position && f.flip.offset < position + chunk.length) { chunk = Buffer.from(chunk); chunk[f.flip.offset - position] ^= 0x01; }
      if (dropAt !== undefined && position + chunk.length >= dropAt && position <= dropAt) {
        const keep = chunk.subarray(0, dropAt - position);
        record.sent += keep.length; record.dropped = true; state.faults = { ...state.faults, drop: undefined };
        stream.destroy();
        // Flush what precedes the cut, then kill the connection without ending the response.
        response.write(keep, () => response.socket?.destroy());
        return;
      }
      position += chunk.length; record.sent += chunk.length;
      if (!response.write(chunk)) { stream.pause(); response.once("drain", () => stream.resume()); }
    });
    stream.on("end", () => response.end());
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return state;
}
