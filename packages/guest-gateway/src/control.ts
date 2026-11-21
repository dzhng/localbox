import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { decodeGuestFrames, encodeGuestFrame, type ControlFrame } from "./protocol.js";

/** How the guest quiesces its root filesystem for a disk clone. */
export interface FreezeCommands {
  /** Flushes dirty pages, so the clone holds everything written before the freeze. */
  sync(): Promise<void>;
  /** Blocks new writes to `/` until `thaw`. */
  freeze(): Promise<void>;
  thaw(): Promise<void>;
}

/** Linux owns its root filesystem: `sync`, then `fsfreeze` on `/`. */
export const linuxFreezeCommands: FreezeCommands = {
  sync: () => run("sync", []),
  freeze: () => run("fsfreeze", ["-f", "/"]),
  thaw: () => run("fsfreeze", ["-u", "/"]),
};

/** darwin has no `fsfreeze`, and a fixture guest shares the host's filesystem: `sync` only. */
export const syncOnlyCommands: FreezeCommands = {
  sync: () => run("sync", []),
  freeze: async () => undefined,
  thaw: async () => undefined,
};

export const DEFAULT_SELF_THAW_MS = 10_000;
export const MAX_SELF_THAW_MS = 30_000;

export interface GuestControlOptions {
  commands: FreezeCommands;
  maxFrameBytes?: number;
}

/**
 * The guest end of the control lane: freeze and thaw, apart from the request lane so they never queue behind a guest
 * request (the request lane has no timeout) and never write to the disk they freeze. One per agent: the frozen state
 * outlives the connection that asked for it, and a freeze always thaws itself after its timeout, so a host that dies
 * mid-clone never leaves the guest frozen. Nothing here writes to disk or logs.
 */
export class GuestControl {
  private readonly commands: FreezeCommands;
  private readonly maxFrameBytes: number;
  /** Control frames from every connection run one at a time, so a freeze and a thaw never interleave. */
  private chain: Promise<unknown> = Promise.resolve();
  private selfThaw: NodeJS.Timeout | undefined;
  private frozenValue = false;

  constructor(options: GuestControlOptions) {
    this.commands = options.commands;
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024;
  }

  get frozen(): boolean { return this.frozenValue; }

  /** Serves one control connection until it closes; answers each frame in order. */
  serve(input: Readable, output: Writable): Promise<void> {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let pending = Promise.resolve();
    const answer = (frame: ControlFrame) => new Promise<void>((resolve) => { if (output.writableEnded || output.destroyed) { resolve(); return; } output.write(encodeGuestFrame(frame), () => resolve()); });
    return new Promise<void>((resolve) => {
      input.on("data", (chunk: Buffer | string) => {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        let frames: ControlFrame[];
        try {
          if (buffer.byteLength >= 4 && buffer.readUInt32BE(0) > this.maxFrameBytes) throw new Error("control frame exceeds the frame limit");
          const decoded = decodeGuestFrames<ControlFrame>(buffer); frames = decoded.frames; buffer = Buffer.from(decoded.remainder);
        } catch (error) {
          // A malformed stream has no frame boundary left to resynchronize on, so the connection ends.
          pending = pending.then(() => answer({ kind: "control_error", message: messageOf(error) })).then(() => { output.end(); });
          input.removeAllListeners("data");
          return;
        }
        for (const frame of frames) pending = pending.then(async () => answer(await this.handle(frame)));
      });
      input.once("end", () => { void pending.then(() => resolve()); });
      input.once("close", () => { void pending.then(() => resolve()); });
      input.once("error", () => resolve());
    });
  }

  /** One control frame, after any frame already running; never throws: a failure is a `control_error` answer. */
  handle(frame: ControlFrame): Promise<ControlFrame> {
    const next = this.chain.then(() => this.dispatch(frame)).catch((error): ControlFrame => ({ kind: "control_error", message: messageOf(error) }));
    this.chain = next;
    return next;
  }

  private async dispatch(frame: ControlFrame): Promise<ControlFrame> {
    switch (frame.kind) {
      case "freeze": {
        const timeoutMs = frame.timeout_ms ?? DEFAULT_SELF_THAW_MS;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SELF_THAW_MS) throw new Error(`freeze timeout_ms must be an integer from 1 to ${MAX_SELF_THAW_MS}`);
        if (!this.frozenValue) {
          await this.commands.sync();
          await this.commands.freeze();
          this.frozenValue = true;
        }
        // A repeated freeze extends the hold: the timer always runs from the latest freeze.
        clearTimeout(this.selfThaw);
        this.selfThaw = setTimeout(() => { void this.handle({ kind: "thaw" }); }, timeoutMs);
        return { kind: "frozen", timeout_ms: timeoutMs };
      }
      case "thaw":
        clearTimeout(this.selfThaw); this.selfThaw = undefined;
        if (this.frozenValue) { await this.commands.thaw(); this.frozenValue = false; }
        return { kind: "thawed" };
      default:
        throw new Error(`unknown control frame kind: ${(frame as { kind: string }).kind}`);
    }
  }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Runs a command with no shell and no inherited output (journald may write to the disk being frozen). */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`)));
  });
}
