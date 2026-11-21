import { spawn } from "node:child_process";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
/** Far above any agent build; a bigger header is a mistake, not a binary. */
const MAX_AGENT_BYTES = 512 * 1024 * 1024;

/** How this agent replaces itself with the host's build. */
export interface AgentUpdateOptions {
  /** The running agent's own executable, which an update replaces in place. */
  binary: string;
  /** Running Localbox jobs: an update waits while any runs (P5), since their tracking lives only in this process. */
  runningJobs: () => number;
  /** Ends this process once `updated` is on the wire; systemd (`Restart=always`) or launchd (`KeepAlive`) starts the new binary. */
  exit: () => void;
  /** Runs after the swap, before `updated` is answered: where darwin re-grants the new binary its TCC rows (P6). */
  afterSwap?: (binary: string) => Promise<void>;
}

export interface GuestControlOptions {
  commands: FreezeCommands;
  /** Unset when the agent runs from source (the process fixture): there is no binary of its own to replace. */
  update?: AgentUpdateOptions;
  maxFrameBytes?: number;
}

/** A binary arriving in chunks, written beside the one it replaces so the final rename stays on one filesystem. */
interface IncomingAgent { version: string; sha256: string; size: number; temp: string; file: FileHandle; hash: Hash; received: number; connection: symbol }

/**
 * The guest end of the control lane: freeze and thaw, apart from the request lane so they never queue behind a guest
 * request (the request lane has no timeout) and never write to the disk they freeze. One per agent: the frozen state
 * outlives the connection that asked for it, and a freeze always thaws itself after its timeout, so a host that dies
 * mid-clone never leaves the guest frozen. Nothing on the freeze path writes to disk or logs. It also replaces the
 * agent with the host's build (`agent.update`): chunks to a temp file beside the binary, a sha256 check, a rename over
 * the binary, an `updated` answer, then exit for the supervisor to start the new one.
 */
export class GuestControl {
  private readonly commands: FreezeCommands;
  private readonly update: AgentUpdateOptions | undefined;
  private readonly maxFrameBytes: number;
  private incoming: IncomingAgent | undefined;
  /** Control frames from every connection run one at a time, so a freeze and a thaw never interleave. */
  private chain: Promise<unknown> = Promise.resolve();
  private selfThaw: NodeJS.Timeout | undefined;
  private frozenValue = false;

  constructor(options: GuestControlOptions) {
    this.commands = options.commands;
    this.update = options.update;
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024;
    // A transfer cut off by a crash or a restart left its temp file; nothing can resume it.
    if (this.update) {
      const directory = dirname(this.update.binary), prefix = updatePrefix(this.update.binary);
      try { for (const name of readdirSync(directory)) if (name.startsWith(prefix)) rmSync(join(directory, name), { force: true }); } catch { /* the directory is the binary's own; unreadable means nothing to sweep */ }
    }
  }

  get frozen(): boolean { return this.frozenValue; }

  /** Serves one control connection until it closes; answers each frame in order. */
  serve(input: Readable, output: Writable): Promise<void> {
    const connection = Symbol("control connection");
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
        for (const frame of frames) {
          pending = pending.then(async () => {
            const reply = await this.handle(frame, connection);
            await answer(reply);
            if (reply.kind === "updated") this.update?.exit();
          });
        }
      });
      // A transfer the connection did not finish can never finish: its chunks went with it.
      const ended = () => {
        void pending.then(() => { this.chain = this.chain.then(() => this.abandon(connection)).catch(() => undefined); return this.chain; }).then(() => resolve());
      };
      input.once("end", ended);
      input.once("close", ended);
      input.once("error", ended);
    });
  }

  /** One control frame, after any frame already running; never throws: a failure is a `control_error` answer. */
  handle(frame: ControlFrame, connection: symbol = Symbol("control call")): Promise<ControlFrame> {
    const next = this.chain.then(() => this.dispatch(frame, connection)).catch((error): ControlFrame => ({ kind: "control_error", message: messageOf(error) }));
    this.chain = next;
    return next;
  }

  private async dispatch(frame: ControlFrame, connection: symbol): Promise<ControlFrame> {
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
      case "agent.update": return this.beginUpdate(frame, connection);
      case "agent.chunk": return this.receiveChunk(frame, connection);
      default:
        throw new Error(`unknown control frame kind: ${(frame as { kind: string }).kind}`);
    }
  }

  private async beginUpdate(frame: Extract<ControlFrame, { kind: "agent.update" }>, connection: symbol): Promise<ControlFrame> {
    const update = this.update;
    if (!update) throw new Error("this agent runs from source and has no binary of its own to replace");
    if (typeof frame.version !== "string" || !frame.version) throw new Error("agent.update needs a version");
    if (typeof frame.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(frame.sha256)) throw new Error("agent.update sha256 must be 64 lowercase hex characters");
    if (!Number.isSafeInteger(frame.size) || frame.size < 1 || frame.size > MAX_AGENT_BYTES) throw new Error(`agent.update size must be from 1 byte to ${MAX_AGENT_BYTES}`);
    if (this.frozenValue) throw new Error("the guest is frozen; thaw it before an update");
    const running = update.runningJobs();
    if (running > 0) return { kind: "deferred", running_jobs: running };
    await this.abandon();
    const temp = join(dirname(update.binary), `${updatePrefix(update.binary)}${randomUUID()}`);
    const file = await open(temp, "wx", 0o755);
    this.incoming = { version: frame.version, sha256: frame.sha256, size: frame.size, temp, file, hash: createHash("sha256"), received: 0, connection };
    return { kind: "agent.receiving" };
  }

  private async receiveChunk(frame: Extract<ControlFrame, { kind: "agent.chunk" }>, connection: symbol): Promise<ControlFrame> {
    const incoming = this.incoming;
    if (!incoming || incoming.connection !== connection) throw new Error("agent.chunk without an agent.update on this connection");
    if (frame.offset !== incoming.received) { await this.abandon(); throw new Error(`agent.chunk at offset ${frame.offset}, expected ${incoming.received}; the update was dropped`); }
    const data = Buffer.from(typeof frame.data === "string" ? frame.data : "", "base64");
    if (!data.byteLength || incoming.received + data.byteLength > incoming.size) { await this.abandon(); throw new Error(`agent.chunk overruns the announced ${incoming.size} bytes; the update was dropped`); }
    await incoming.file.write(data, 0, data.byteLength, incoming.received);
    incoming.hash.update(data); incoming.received += data.byteLength;
    if (incoming.received < incoming.size) return { kind: "agent.received", bytes: incoming.received };
    return this.swap(incoming);
  }

  /** Verifies the whole binary, then renames it over the running one: the path always holds a complete binary. */
  private async swap(incoming: IncomingAgent): Promise<ControlFrame> {
    const update = this.update!;
    this.incoming = undefined;
    try {
      await incoming.file.sync(); await incoming.file.close();
      const digest = incoming.hash.digest("hex");
      if (digest !== incoming.sha256) throw new Error(`the new agent's sha256 is ${digest}, not the announced ${incoming.sha256}; kept the running agent`);
      await rename(incoming.temp, update.binary);
    } catch (error) {
      await incoming.file.close().catch(() => undefined);
      await rm(incoming.temp, { force: true });
      throw error;
    }
    const directory = await open(dirname(update.binary), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    await update.afterSwap?.(update.binary);
    return { kind: "updated", version: incoming.version };
  }

  /** Drops a transfer in progress (all of them, or only `connection`'s) and its temp file. */
  private async abandon(connection?: symbol): Promise<void> {
    const incoming = this.incoming;
    if (!incoming || (connection && incoming.connection !== connection)) return;
    this.incoming = undefined;
    await incoming.file.close().catch(() => undefined);
    await rm(incoming.temp, { force: true });
  }
}

/** Temp files of an update sit beside the binary under this name prefix. */
function updatePrefix(binary: string): string { return `.${basename(binary)}.update-`; }

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
