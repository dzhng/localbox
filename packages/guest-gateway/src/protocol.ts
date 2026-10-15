import { createHash } from "node:crypto";
import type { Json, RequestEnvelope, ResponseEnvelope } from "../../contract/src/index.js";

export type GuestFrame =
  | { kind: "request"; request: RequestEnvelope; channel_epoch: number }
  | { kind: "response"; response: ResponseEnvelope; channel_epoch: number }
  | { kind: "ready"; channel_epoch: number; inventory_digest: string; readiness_marker: string }
  | { kind: "cancel"; request_id: string; channel_epoch: number };

export function encodeGuestFrame(frame: GuestFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([prefix, body]);
}

export function decodeGuestFrames(buffer: Buffer): { frames: GuestFrame[]; remainder: Buffer } {
  const frames: GuestFrame[] = [];
  let offset = 0;
  while (buffer.byteLength - offset >= 4) {
    const length = buffer.readUInt32BE(offset);
    if (length > 8 * 1024 * 1024) throw new Error("guest frame exceeds 8 MiB");
    if (buffer.byteLength - offset - 4 < length) break;
    const raw = buffer.subarray(offset + 4, offset + 4 + length).toString("utf8");
    const parsed = JSON.parse(raw) as GuestFrame;
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { kind?: unknown }).kind !== "string") throw new Error("invalid guest frame");
    frames.push(parsed);
    offset += 4 + length;
  }
  return { frames, remainder: buffer.subarray(offset) };
}

export function inventoryDigest(names: readonly string[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify([...names].sort())).digest("hex")}`;
}

export type GuestJson = Json;
