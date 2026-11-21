import { createHash } from "node:crypto";
import type { Json, RequestEnvelope, ResponseEnvelope } from "../../contract/src/index.js";

export type GuestFrame =
  | { kind: "hello"; channel_epoch: number; wall_clock_ms: number; sandbox_id: string; hostname: string }
  | { kind: "request"; request: RequestEnvelope; channel_epoch: number }
  | { kind: "response"; response: ResponseEnvelope; channel_epoch: number }
  | { kind: "ready"; channel_epoch: number; inventory_digest: string; readiness_marker: string; agent_version: string; agent_os: string }
  | { kind: "cancel"; request_id: string; channel_epoch: number };

/**
 * Frames on the control lane (vsock port 1025): the host asks, the guest answers each in order. They carry no epoch
 * and no request envelope, so they never pass the request lane's serializer or its mutation journal.
 */
export type ControlFrame =
  | { kind: "freeze"; timeout_ms?: number }
  | { kind: "frozen"; timeout_ms: number }
  | { kind: "thaw" }
  | { kind: "thawed" }
  /** A new agent binary: this header, then `agent.chunk`s in order until `size` bytes arrived. */
  | { kind: "agent.update"; version: string; sha256: string; size: number }
  | { kind: "agent.receiving" }
  /** `data` is base64; chunks stay under the frame limit. */
  | { kind: "agent.chunk"; offset: number; data: string }
  | { kind: "agent.received"; bytes: number }
  /** The last chunk's answer: verified and swapped in; the agent exits once this is on the wire. */
  | { kind: "updated"; version: string }
  /** The agent runs jobs whose tracking would die with it, so the update waits. */
  | { kind: "deferred"; running_jobs: number }
  | { kind: "control_error"; message: string };

/** Length-prefixed JSON: the request lane, the control lane and the darwin desktop link all frame this way. */
export function encodeGuestFrame(frame: GuestFrame | ControlFrame): Buffer;
export function encodeGuestFrame<F extends { kind: string }>(frame: F): Buffer;
export function encodeGuestFrame(frame: { kind: string }): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([prefix, body]);
}

export function decodeGuestFrames<F extends { kind: string } = GuestFrame>(buffer: Buffer): { frames: F[]; remainder: Buffer } {
  const frames: F[] = [];
  let offset = 0;
  while (buffer.byteLength - offset >= 4) {
    const length = buffer.readUInt32BE(offset);
    if (length > 8 * 1024 * 1024) throw new Error("guest frame exceeds 8 MiB");
    if (buffer.byteLength - offset - 4 < length) break;
    const raw = buffer.subarray(offset + 4, offset + 4 + length).toString("utf8");
    const parsed = JSON.parse(raw) as F;
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
