import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { ContractError, errorBody, type ErrorBody, type Json } from "../../../packages/contract/src/index.js";
import { DESKTOP_OPERATIONS } from "../../../packages/desktop/src/index.js";
import { encodeGuestFrame, readGuestFrames } from "../../../packages/guest-gateway/src/protocol.js";
import type { DispatchContext, HandlerRegistry } from "../../../packages/runtime/src/index.js";

/**
 * The darwin agent's two roles talk over one Unix socket: the root role listens, and the `--desktop` role, which
 * runs in the auto-login session where ScreenCaptureKit and CGEvent work, dials in and answers the desktop and browser
 * calls the root role forwards. The desktop role dials (not the reverse) so the socket stays root-owned; its newest
 * connection wins.
 */
type LinkFrame =
  | { kind: "call"; id: number; operation: string; input: Json; deadline_ms: number }
  | { kind: "result"; id: number; result: Json }
  | { kind: "error"; id: number; error: ErrorBody };

interface Waiter { resolve: (value: Json) => void; reject: (error: Error) => void }

export interface DesktopLinkOptions {
  path: string;
  /**
   * Who may connect besides root: the desktop user, through an ACL entry on the socket (owner root, mode 0600). macOS
   * gives the provisioned user only `staff`, which every account shares, so a group can't name it alone.
   */
  user: string;
  /** Applies the ACL; tests run unprivileged and skip it. */
  grantUser?: (path: string, user: string) => void;
}

/** The root role's end: listens, keeps the desktop role's connection and forwards each call over it. */
export class DesktopLink {
  private connection: { socket: Socket; pending: Map<number, Waiter> } | undefined;
  private nextId = 1;
  private server: Server | undefined;

  constructor(private readonly options: DesktopLinkOptions) {}

  async listen(): Promise<void> {
    const { path } = this.options;
    mkdirSync(dirname(path), { recursive: true }); rmSync(path, { force: true });
    const server = createServer((socket) => this.adopt(socket));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); }); });
    // Root's umask leaves the new socket 0755, which no one else can connect to (connecting needs write), until this.
    chmodSync(path, 0o600);
    (this.options.grantUser ?? grantSocketUser)(path, this.options.user);
    this.server = server;
  }

  close(): void { this.server?.close(); this.connection?.socket.destroy(); }

  /** Forwards one desktop or browser call; the answer, or the desktop role's error, comes back as the handler's. */
  call(operation: string, input: Json, context: Pick<DispatchContext, "request" | "signal">): Promise<Json> {
    const connection = this.connection;
    if (!connection) return Promise.reject(new ContractError("guest_unreachable", "the macOS desktop session is not connected yet (its agent starts at auto-login)", undefined, true));
    const id = this.nextId++, deadline = context.request.deadline_ms;
    return new Promise<Json>((resolve, reject) => {
      const done = () => { clearTimeout(timer); context.signal?.removeEventListener("abort", abort); connection.pending.delete(id); };
      const timer = setTimeout(() => { done(); reject(new ContractError("operation_timeout", `the desktop session did not answer ${operation} in time`, { deadline_ms: deadline }, true)); }, deadline);
      const abort = () => { done(); reject(new ContractError("operation_cancelled", `${operation} cancelled`)); };
      context.signal?.addEventListener("abort", abort, { once: true });
      connection.pending.set(id, { resolve: (value) => { done(); resolve(value); }, reject: (error) => { done(); reject(error); } });
      connection.socket.write(encodeGuestFrame({ kind: "call", id, operation, input, deadline_ms: deadline } satisfies LinkFrame));
    });
  }

  /** The root role's desktop and browser handlers: every one forwards. */
  handlers(): HandlerRegistry {
    return Object.fromEntries(DESKTOP_OPERATIONS.map((operation) => [operation, (input: Json, context: DispatchContext) => this.call(operation, input, context)]));
  }

  private adopt(socket: Socket): void {
    this.connection?.socket.destroy();
    const connection = { socket, pending: new Map<number, Waiter>() };
    this.connection = connection;
    readFrames(socket, (frame) => {
      if (frame.kind === "call") return;
      const waiter = connection.pending.get(frame.id);
      if (frame.kind === "result") waiter?.resolve(frame.result);
      else waiter?.reject(new ContractError(frame.error.code, frame.error.message, frame.error.details, frame.error.retryable));
    });
    const lost = () => {
      if (this.connection === connection) this.connection = undefined;
      for (const waiter of connection.pending.values()) waiter.reject(new ContractError("guest_unreachable", "the macOS desktop session disconnected", undefined, true));
      connection.pending.clear();
    };
    socket.once("close", lost);
    socket.on("error", () => socket.destroy());
  }
}

/**
 * The desktop role's end: dials the root role and answers its calls with `handlers`, redialling every second while the
 * root role is away. An agent update swaps the binary and restarts only the root role, so before every dial
 * `replaced()` is asked; when it says the binary changed, `exit` ends this process for launchd to start the new one.
 */
export function serveDesktopLink(path: string, handlers: HandlerRegistry, log: (message: string) => void, replaced: () => boolean = () => false, exit: () => void = () => process.exit(0)): void {
  let reported = false;
  const dial = () => {
    if (replaced()) { log("the agent binary was replaced; exiting for launchd to start the new one"); exit(); return; }
    const socket = createConnection(path);
    socket.once("connect", () => { reported = false; log(`connected to ${path}`); });
    readFrames(socket, (frame) => {
      if (frame.kind !== "call") return;
      void answer(frame).then((reply) => { if (!socket.destroyed) socket.write(encodeGuestFrame(reply)); });
    });
    socket.on("error", (error) => { if (!reported) { reported = true; log(`waiting for ${path}: ${error.message}`); } });
    socket.once("close", () => { setTimeout(dial, 1_000).unref?.(); });
  };
  const answer = async (frame: Extract<LinkFrame, { kind: "call" }>): Promise<LinkFrame> => {
    const handler = handlers[frame.operation as keyof HandlerRegistry];
    try {
      if (!handler) throw new ContractError("unsupported", `the desktop session does not answer ${frame.operation}`);
      const request = { operation: frame.operation, deadline_ms: frame.deadline_ms } as DispatchContext["request"];
      return { kind: "result", id: frame.id, result: await handler(frame.input, { request } as DispatchContext) };
    } catch (error) {
      const failure = error instanceof ContractError ? error : new ContractError("internal", error instanceof Error ? error.message : String(error));
      return { kind: "error", id: frame.id, error: errorBody(failure) };
    }
  };
  dial();
}

function readFrames(socket: Socket, onFrame: (frame: LinkFrame) => void): void {
  const read = readGuestFrames<LinkFrame>();
  socket.on("data", (chunk: Buffer) => {
    try { read(chunk).forEach(onFrame); }
    catch { socket.destroy(); }
  });
}

function grantSocketUser(path: string, user: string): void {
  const result = spawnSync("/bin/chmod", ["+a", `user:${user} allow read,write`, path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`could not let ${user} reach ${path}: ${result.stderr || result.error?.message}`);
}
