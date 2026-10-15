import { promises as fs } from "node:fs";
import { hostname as systemHostname } from "node:os";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  ContractError,
  failure,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "../../contract/src/index.js";
import { GuestGateway } from "./index.js";
import {
  decodeGuestFrames,
  encodeGuestFrame,
  inventoryDigest,
  type GuestFrame,
} from "./protocol.js";

/** Configuration for the process that runs inside the Linux VM. */
export interface GuestServiceOptions {
  /** Framed input (virtio-serial in production; stdin is useful for probes). */
  input: Readable;
  /** Framed output (virtio-serial in production; stdout is useful for probes). */
  output: Writable;
  gateway: GuestGateway;
  channelEpoch: number;
  /** Called when a newer host hello supplies the guest wall clock. */
  setClock?: (wallClockMs: number) => void;
  /** Called when a newer host hello supplies the guest hostname. */
  setHostname?: (hostname: string) => void;
  inventoryNames?: readonly string[];
  readinessMarker?: string;
  maxPending?: number;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
  /** Protocol errors are reported out of band because they have no request identity. */
  onProtocolError?: (error: Error) => void;
}

/**
 * Guest-side framed protocol server.
 *
 * The service intentionally contains no operation handlers: GuestGateway is the
 * sole owner of dispatch, path confinement, deadlines, and mutation replay. This
 * class only authenticates the channel epoch, bounds work, and adapts streams to
 * the length-prefixed protocol used by HostDaemon. Which sandbox a request is
 * for is HostDaemon's decision; the guest serves whatever reaches its channel.
 */
export class GuestService {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly gateway: GuestGateway;
  private channelEpoch: number;
  private readonly setClock: (wallClockMs: number) => void;
  private readonly setHostname: (hostname: string) => void;
  private readonly inventoryNames: readonly string[];
  private readonly readinessMarker: string;
  private readonly maxPending: number;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly onProtocolError: (error: Error) => void;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pending = 0;
  private readonly aborts = new Map<string, AbortController>();
  private outputChain = Promise.resolve();
  private inputChain = Promise.resolve();
  private started = false;
  private stopped = false;
  private finishResolve!: () => void;
  readonly finished: Promise<void>;

  constructor(options: GuestServiceOptions) {
    if (!Number.isInteger(options.channelEpoch) || options.channelEpoch < 0) throw new TypeError("guest service channelEpoch must be a non-negative integer");
    this.input = options.input;
    this.output = options.output;
    this.gateway = options.gateway;
    this.channelEpoch = options.channelEpoch;
    this.setClock = options.setClock ?? (() => undefined);
    this.setHostname = options.setHostname ?? (() => undefined);
    this.inventoryNames = [...(options.inventoryNames ?? [])].sort();
    this.readinessMarker = options.readinessMarker ?? "/run/localbox/ready";
    this.maxPending = options.maxPending ?? 32;
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 16 * 1024 * 1024;
    if (!Number.isInteger(this.maxPending) || this.maxPending < 1) throw new TypeError("guest service maxPending must be positive");
    if (!Number.isInteger(this.maxFrameBytes) || this.maxFrameBytes < 1 || this.maxFrameBytes > 8 * 1024 * 1024) throw new TypeError("guest service maxFrameBytes must be between 1 byte and 8 MiB");
    if (!Number.isInteger(this.maxBufferedBytes) || this.maxBufferedBytes < 1) throw new TypeError("guest service maxBufferedBytes must be positive");
    this.onProtocolError = options.onProtocolError ?? (() => undefined);
    this.finished = new Promise<void>((resolve) => { this.finishResolve = resolve; });
  }

  /** Write the readiness marker and frame, then begin consuming requests. */
  async start(): Promise<this> {
    if (this.started) return this;
    this.started = true;
    await fs.mkdir(dirname(this.readinessMarker), { recursive: true });
    await fs.writeFile(this.readinessMarker, `${this.channelEpoch}\n${inventoryDigest(this.inventoryNames)}\n`, { mode: 0o644 });
    await this.write({ kind: "ready", channel_epoch: this.channelEpoch, inventory_digest: inventoryDigest(this.inventoryNames), readiness_marker: this.readinessMarker });
    this.input.on("data", (chunk: Buffer | string) => {
      this.inputChain = this.inputChain.then(() => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).catch((error) => this.protocolError(error));
    });
    this.input.once("end", () => {
      this.inputChain.finally(() => this.stop());
    });
    this.input.once("error", (error) => this.protocolError(error));
    return this;
  }

  /** Stop accepting work. In-flight handlers are cancelled and the output remains open for the host. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const controller of this.aborts.values()) controller.abort();
    this.aborts.clear();
    this.finishResolve();
  }

  private protocolError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.onProtocolError(normalized);
  }

  private async consume(chunk: Buffer): Promise<void> {
    if (this.stopped) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > this.maxBufferedBytes) throw new Error("guest input buffer exceeds configured limit");
    // Inspect complete and partial headers before JSON decoding. The framing
    // decoder has an 8 MiB protocol ceiling; this service may choose a lower
    // per-channel limit and must reject that frame before admitting it.
    let cursor = 0;
    while (this.buffer.byteLength - cursor >= 4) {
      const length = this.buffer.readUInt32BE(cursor);
      if (length > this.maxFrameBytes) throw new Error("guest frame exceeds configured limit");
      if (this.buffer.byteLength - cursor - 4 < length) break;
      cursor += 4 + length;
    }
    const decoded = decodeGuestFrames(this.buffer);
    this.buffer = Buffer.from(decoded.remainder);
    // Do not serialize frames: a cancel frame must be able to reach an active
    // request even when that request is waiting on a process or network call.
    // `pending` and `maxPending` bound the amount of work admitted below.
    for (const frame of decoded.frames) {
      this.handle(frame).catch((error) => this.protocolError(error));
    }
  }

  private async handle(frame: GuestFrame): Promise<void> {
    if (frame.kind === "hello") {
      if (!Number.isInteger(frame.channel_epoch) || frame.channel_epoch < this.channelEpoch) return;
      if (frame.channel_epoch > this.channelEpoch) {
        this.channelEpoch = frame.channel_epoch;
        this.setClock(frame.wall_clock_ms);
        if (frame.hostname) this.setHostname(frame.hostname);
        await fs.writeFile(this.readinessMarker, `${this.channelEpoch}\n${inventoryDigest(this.inventoryNames)}\n`, { mode: 0o644 });
      }
      return;
    }
    if (frame.kind === "cancel") {
      if (frame.channel_epoch !== this.channelEpoch) return;
      this.aborts.get(frame.request_id)?.abort();
      return;
    }
    if (frame.kind !== "request") {
      throw new Error(`guest received unexpected frame kind: ${frame.kind}`);
    }
    const request = frame.request;
    if (frame.channel_epoch !== this.channelEpoch) {
      await this.respond(request, failure(request, new ContractError("forbidden", "guest channel epoch is stale")));
      return;
    }
    if (this.pending >= this.maxPending) {
      await this.respond(request, failure(request, new ContractError("resource_exhausted", "guest request queue is full", undefined, true)));
      return;
    }
    this.pending += 1;
    const controller = new AbortController();
    this.aborts.set(request.request_id, controller);
    try {
      const response = await this.gateway.dispatch(request as RequestEnvelope, { signal: controller.signal });
      await this.respond(request, response);
    } finally {
      this.aborts.delete(request.request_id);
      this.pending -= 1;
    }
  }

  private async respond(request: RequestEnvelope, response: ResponseEnvelope): Promise<void> {
    let frame: GuestFrame = { kind: "response", response, channel_epoch: this.channelEpoch };
    if (encodeGuestFrame(frame).byteLength - 4 > this.maxFrameBytes) {
      frame = {
        kind: "response",
        channel_epoch: this.channelEpoch,
        response: failure(request, new ContractError("resource_exhausted", "guest response exceeds frame limit", undefined, false)),
      };
    }
    return this.write(frame);
  }

  private write(frame: GuestFrame): Promise<void> {
    const encoded = encodeGuestFrame(frame);
    if (encoded.byteLength - 4 > this.maxFrameBytes) throw new Error("guest frame exceeds configured limit");
    this.outputChain = this.outputChain.then(async () => {
      if (this.stopped && frame.kind !== "ready") return;
      if (!this.output.write(encoded)) await new Promise<void>((resolve) => this.output.once("drain", resolve));
    });
    return this.outputChain;
  }
}

/** Start a guest service and keep the process alive until its input closes. */
export async function runGuestService(options: GuestServiceOptions): Promise<GuestService> {
  const service = new GuestService(options);
  await service.start();
  await service.finished;
  return service;
}
