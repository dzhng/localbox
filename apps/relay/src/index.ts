import { randomBytes } from "node:crypto";
import type { RequestEnvelope, ResponseEnvelope } from "../../../packages/contract/src/index.js";

export interface RelayFrame {
  kind: "request" | "response" | "heartbeat" | "heartbeat_ack" | "revoke";
  channel_id: string;
  epoch: number;
  sequence: number;
  vm_id: string;
  request_id?: string;
  mutation_id?: string | null;
  deadline_ms?: number;
  payload?: unknown;
}
export interface ChannelGrant { channel_id: string; vm_id: string; epoch: number; token: string; }
export interface RelayLimits { maxFrameBytes?: number; maxQueue?: number; maxFramesPerSecond?: number; }
interface ChannelState { grant: ChannelGrant; revoked: boolean; nextSequence: number; queue: RelayFrame[]; timestamps: number[]; handler?: (frame: RelayFrame) => Promise<RelayFrame | void>; }

/** In-memory relay model used by local/fault tests. It routes payloads only. */
export class RelayServer {
  private readonly channels = new Map<string, ChannelState>();
  private readonly maxFrameBytes: number;
  private readonly maxQueue: number;
  private readonly maxFramesPerSecond: number;
  constructor(limits: RelayLimits = {}) { this.maxFrameBytes = limits.maxFrameBytes ?? 1024 * 1024; this.maxQueue = limits.maxQueue ?? 128; this.maxFramesPerSecond = limits.maxFramesPerSecond ?? 60; }
  issueGrant(vmId: string, channelId = `channel_${randomBytes(8).toString("hex")}`): ChannelGrant { const grant = { channel_id: channelId, vm_id: vmId, epoch: 1, token: randomBytes(24).toString("base64url") }; this.channels.set(channelId, { grant, revoked: false, nextSequence: 1, queue: [], timestamps: [] }); return grant; }
  rotate(grant: ChannelGrant): ChannelGrant { const state = this.authorize(grant); state.grant = { ...grant, epoch: grant.epoch + 1, token: randomBytes(24).toString("base64url") }; state.revoked = false; state.queue = []; return state.grant; }
  revoke(grant: ChannelGrant): void { const state = this.authorize(grant); state.revoked = true; state.queue = []; }
  attach(grant: ChannelGrant, handler: (frame: RelayFrame) => Promise<RelayFrame | void>): void { const state = this.authorize(grant); state.handler = handler; }
  detach(grant: ChannelGrant): void { const state = this.authorize(grant); state.handler = undefined; }
  async route(grant: ChannelGrant, frame: Omit<RelayFrame, "channel_id" | "epoch" | "sequence">): Promise<RelayFrame | void> {
    const state = this.authorize(grant); if (state.revoked) throw new RelayError("revoked channel");
    const now = Date.now(); state.timestamps = state.timestamps.filter((t) => now - t < 1000); if (state.timestamps.length >= this.maxFramesPerSecond) throw new RelayError("rate limit exceeded"); state.timestamps.push(now);
    const full: RelayFrame = { ...frame, channel_id: grant.channel_id, epoch: grant.epoch, sequence: state.nextSequence++ };
    if (full.deadline_ms !== undefined && full.deadline_ms <= 0) throw new RelayError("frame deadline exceeded");
    if (Buffer.byteLength(JSON.stringify(full)) > this.maxFrameBytes) throw new RelayError("frame exceeds size limit");
    if (state.queue.length >= this.maxQueue) throw new RelayError("channel queue exhausted");
    state.queue.push(full);
    try { return await state.handler?.(full); } finally { state.queue.shift(); }
  }
  drain(grant: ChannelGrant): RelayFrame[] { return [...this.authorize(grant).queue]; }
  status(grant: ChannelGrant): { connected: boolean; channel_id: string; epoch: number; queue_depth: number; revoked: boolean } { const state = this.authorize(grant); return { connected: Boolean(state.handler) && !state.revoked, channel_id: grant.channel_id, epoch: state.grant.epoch, queue_depth: state.queue.length, revoked: state.revoked }; }
  private authorize(grant: ChannelGrant): ChannelState { const state = this.channels.get(grant.channel_id); if (!state || state.grant.token !== grant.token || state.grant.epoch !== grant.epoch || state.grant.vm_id !== grant.vm_id) throw new RelayError("invalid or stale channel grant"); return state; }
}

export class RelayError extends Error { constructor(message: string) { super(message); this.name = "RelayError"; } }

export interface ChannelConnection { send(frame: RelayFrame): Promise<RelayFrame | void>; close(): Promise<void> | void; }
export interface ChannelSupervisorOptions { connect: () => Promise<ChannelConnection>; heartbeatMs?: number; minBackoffMs?: number; maxBackoffMs?: number; onState?: (state: SupervisorState) => void; }
export type SupervisorState = "disconnected" | "connecting" | "connected" | "stopping";

/** Maintains one outbound channel with heartbeat and bounded reconnect backoff. */
export class ChannelSupervisor {
  state: SupervisorState = "disconnected";
  private connection?: ChannelConnection; private stopped = true; private heartbeat?: ReturnType<typeof setInterval>; private reconnect?: ReturnType<typeof setTimeout>; private backoff: number;
  readonly heartbeatMs: number; readonly minBackoffMs: number; readonly maxBackoffMs: number;
  constructor(private readonly options: ChannelSupervisorOptions) { this.heartbeatMs = options.heartbeatMs ?? 15_000; this.minBackoffMs = options.minBackoffMs ?? 250; this.maxBackoffMs = options.maxBackoffMs ?? 30_000; this.backoff = this.minBackoffMs; }
  async start(): Promise<void> { if (!this.stopped) return; this.stopped = false; await this.connect(); }
  async stop(): Promise<void> { this.stopped = true; this.setState("stopping"); if (this.reconnect) clearTimeout(this.reconnect); if (this.heartbeat) clearInterval(this.heartbeat); await this.connection?.close(); this.connection = undefined; this.setState("disconnected"); }
  async send(frame: RelayFrame): Promise<RelayFrame | void> { if (!this.connection || this.state !== "connected") throw new RelayError("relay disconnected"); try { return await this.connection.send(frame); } catch (error) { await this.connectionLost(); throw error; } }
  private async connect(): Promise<void> { if (this.stopped) return; this.setState("connecting"); try { this.connection = await this.options.connect(); this.backoff = this.minBackoffMs; this.setState("connected"); this.heartbeat = setInterval(() => { void this.heartbeatTick(); }, this.heartbeatMs); this.heartbeat.unref?.(); } catch { this.connection = undefined; this.scheduleReconnect(); } }
  private async heartbeatTick(): Promise<void> { if (!this.connection || this.state !== "connected") return; try { await this.connection.send({ kind: "heartbeat", channel_id: "", epoch: 0, sequence: 0, vm_id: "" }); } catch { await this.connectionLost(); } }
  private async connectionLost(): Promise<void> { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = undefined; await this.connection?.close(); this.connection = undefined; this.setState("disconnected"); this.scheduleReconnect(); }
  private scheduleReconnect(): void { if (this.stopped || this.reconnect) return; const delay = this.backoff; this.backoff = Math.min(this.maxBackoffMs, this.backoff * 2); this.reconnect = setTimeout(() => { this.reconnect = undefined; void this.connect(); }, delay); this.reconnect.unref?.(); }
  private setState(state: SupervisorState): void { this.state = state; this.options.onState?.(state); }
}

export function requestFrame(request: RequestEnvelope, epoch: number, sequence = 0): RelayFrame { return { kind: "request", channel_id: "", epoch, sequence, vm_id: request.vm_id, request_id: request.request_id, mutation_id: request.mutation_id, deadline_ms: request.deadline_ms, payload: request }; }
export function responseFrame(response: ResponseEnvelope, epoch: number, sequence = 0): RelayFrame { return { kind: "response", channel_id: "", epoch, sequence, vm_id: response.vm_id, request_id: response.request_id, payload: response }; }

export * from "./oauth.js";
export * from "./http.js";
export * from "./poller.js";
export * from "./vercel.js";
