import {
  ContractError,
  failure,
  PROTOCOL_VERSION,
  type ErrorCode,
  type Json,
  type OperationId,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "../../contract/src/index.js";
import { FakeDispatcher, type DispatchOptions } from "../../runtime/src/index.js";
import { createConnection, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { machinePaths } from "../../config/src/machine-paths.js";

export type TransportKind = "local" | "remote";

export interface ClientRequestOptions {
  vmId?: string;
  deadlineMs?: number;
  mutationId?: string | null;
  requestId?: string;
  signal?: AbortSignal;
}

export interface ClientTransport {
  readonly kind: TransportKind;
  dispatch(request: RequestEnvelope, options?: DispatchOptions): Promise<ResponseEnvelope>;
}

export interface RelayHttpTransportOptions {
  /** API origin, e.g. https://localbox.sh; requests go to `${apiOrigin}/api/v1/ops`. */
  apiOrigin: string;
  /** The target machine (name or id). Remote calls always name one; there is no implicit routing. */
  machine: string;
  accessToken?: string;
  accessTokenProvider?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * Runs a request on another machine of the account through the agent API. The server waits up to 50 s per call
 * and hands back a continuation for longer requests; this transport resumes it until the request's deadline.
 * It never replays a mutation on its own.
 */
export class RelayHttpTransport implements ClientTransport {
  readonly kind = "remote" as const;
  private readonly endpoint: string;
  private readonly machine: string;
  private readonly accessTokenProvider?: () => Promise<string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private readonly accessToken?: string;
  constructor(options: RelayHttpTransportOptions) {
    this.endpoint = `${options.apiOrigin.replace(/\/$/, "")}/api/v1/ops`;
    this.machine = options.machine;
    this.accessToken = options.accessToken;
    this.accessTokenProvider = options.accessTokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async dispatch(request: RequestEnvelope, options: DispatchOptions = {}): Promise<ResponseEnvelope> {
    const token = this.accessTokenProvider ? await this.accessTokenProvider() : this.accessToken;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    let body: Record<string, unknown> = { operation: request.operation, input: request.input, machine: this.machine, vm_id: request.vm_id, request_id: request.request_id, mutation_id: request.mutation_id, deadline_ms: request.deadline_ms };
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: options.signal });
      } catch (error) {
        throw new TransportError("operation_uncertain", error instanceof Error ? error.message : "relay request failed", true);
      }
      if (response.status === 401 || response.status === 403) return failure(request, { code: "unauthorized", message: "this machine was removed or is signed out; run localbox login", retryable: false });
      if (response.status === 202) {
        const pending = await response.json() as { request_id: string; deadline_at: number };
        body = { continue: pending.request_id, deadline_at: pending.deadline_at };
        continue;
      }
      if (!response.ok) return failure(request, { code: response.status === 429 ? "rate_limited" : "internal", message: await response.text(), retryable: response.status >= 500 || response.status === 429 });
      const result = await response.json() as { response?: ResponseEnvelope };
      if (result.response) return result.response;
      return failure(request, { code: "internal", message: "the agent API returned no response", retryable: false });
    }
  }
}

export interface LocalIPCTransportOptions {
  socketPath?: string;
  token?: string;
  tokenFile?: string;
  maxFrameBytes?: number;
  timeoutMs?: number;
}

/** Authenticated one-request Unix-socket transport used by the installed CLI. */
export class LocalIPCTransport implements ClientTransport {
  readonly kind = "local" as const;
  private readonly socketPath: string;
  private readonly token?: string;
  private readonly tokenFile: string;
  private readonly maxFrameBytes: number;
  private readonly timeoutMs: number;

  constructor(options: LocalIPCTransportOptions = {}) {
    const paths = machinePaths();
    this.socketPath = options.socketPath ?? paths.socket;
    this.token = options.token ?? process.env.LOCALBOX_IPC_TOKEN;
    this.tokenFile = options.tokenFile ?? paths.ipcToken;
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1) throw new TypeError("maxFrameBytes must be a positive integer");
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new TypeError("timeoutMs must be a positive integer");
  }

  async dispatch(request: RequestEnvelope, options: DispatchOptions = {}): Promise<ResponseEnvelope> {
    let token: string;
    try {
      token = this.token ?? (await readFile(this.tokenFile, "utf8")).trim();
    } catch {
      return failure(request, { code: "unauthorized", message: "local IPC token is unavailable", retryable: false });
    }
    if (!token) return failure(request, { code: "unauthorized", message: "local IPC token is empty", retryable: false });
    const body = Buffer.from(JSON.stringify({ token, envelope: Buffer.from(JSON.stringify(request)).toString("base64") }));
    if (body.byteLength > this.maxFrameBytes) return failure(request, { code: "resource_exhausted", message: "local IPC request exceeds the frame limit", retryable: false });
    try {
      const response = await readIPCFrame(this.socketPath, body, this.maxFrameBytes, this.timeoutMs, options.signal);
      if (response.error) return failure(request, localIPCError(response.error));
      if (!response.envelope) return failure(request, { code: "guest_unreachable", message: "local HostDaemon returned no envelope", retryable: true });
      return JSON.parse(Buffer.from(response.envelope, "base64").toString("utf8")) as ResponseEnvelope;
    } catch (error) {
      return failure(request, { code: "guest_unreachable", message: error instanceof Error ? error.message : "local IPC request failed", retryable: true });
    }
  }
}

interface LocalIPCWireResponse { envelope?: string; error?: string }

function localIPCError(code: string): { code: ErrorCode; message: string; retryable: boolean } {
  if (code === "unauthorized") return { code: "unauthorized", message: "local IPC authentication failed", retryable: false };
  if (code === "malformed") return { code: "internal", message: "HostDaemon rejected the local IPC frame", retryable: false };
  if (code === "frame_too_large") return { code: "resource_exhausted", message: "HostDaemon rejected an oversized local IPC frame", retryable: false };
  return { code: "guest_unreachable", message: "HostDaemon is unavailable", retryable: true };
}

async function readIPCFrame(socketPath: string, body: Buffer, maxFrameBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<LocalIPCWireResponse> {
  if (signal?.aborted) throw new Error("local IPC request cancelled");
  return await new Promise<LocalIPCWireResponse>((resolve, reject) => {
    let settled = false;
    let wrote = false;
    let expected: number | undefined;
    let received = Buffer.alloc(0);
    let socket: Socket | undefined;
    const timer = setTimeout(() => finish(new Error("local IPC request timed out")), timeoutMs);
    const abort = () => finish(new Error("local IPC request cancelled"));
    const finish = (error?: Error, value?: LocalIPCWireResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket?.destroy();
      error ? reject(error) : resolve(value!);
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket = createConnection(socketPath);
    socket.on("error", (error) => finish(error));
    socket.on("close", () => { if (!settled) finish(new Error(wrote ? "local IPC connection closed before a response" : "HostDaemon socket is unavailable")); });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (expected === undefined && received.length >= 4) {
        expected = received.readUInt32BE(0);
        if (expected < 1 || expected > maxFrameBytes) return finish(new Error("local IPC response exceeds the frame limit"));
      }
      if (expected !== undefined && received.length >= expected + 4) {
        try { finish(undefined, JSON.parse(received.subarray(4, expected + 4).toString("utf8")) as LocalIPCWireResponse); }
        catch { finish(new Error("HostDaemon returned malformed local IPC JSON")); }
      }
    });
    socket.on("connect", () => {
      const frame = Buffer.allocUnsafe(4 + body.length);
      frame.writeUInt32BE(body.length, 0);
      body.copy(frame, 4);
      socket!.write(frame, () => { wrote = true; });
    });
  });
}

/** A deterministic transport used by the Mac-side and hosted fixture adapters. */
export class FixtureTransport implements ClientTransport {
  readonly dispatcher: FakeDispatcher;
  readonly kind: TransportKind;
  private dropNext = false;
  private authError = false;

  constructor(kind: TransportKind, dispatcher = new FakeDispatcher()) {
    this.kind = kind;
    this.dispatcher = dispatcher;
  }

  /** Inject a lost response. The client reports this as operation_uncertain. */
  dropNextResponse(): void { this.dropNext = true; }
  /** Inject an expired remote credential for deterministic recovery tests. */
  setUnauthorized(value = true): void { this.authError = value; }

  async dispatch(request: RequestEnvelope, options: DispatchOptions = {}): Promise<ResponseEnvelope> {
    if (this.kind === "remote" && this.authError) {
      return failure(request, { code: "unauthorized", message: "remote authentication expired", retryable: false });
    }
    const response = await this.dispatcher.dispatch(request, options);
    if (this.dropNext) {
      this.dropNext = false;
      throw new TransportError("operation_uncertain", "response was lost after dispatch", true);
    }
    return response;
  }
}

export class LocalFixtureTransport extends FixtureTransport {
  constructor(dispatcher?: FakeDispatcher) { super("local", dispatcher); }
}

export class RemoteFixtureTransport extends FixtureTransport {
  constructor(dispatcher?: FakeDispatcher) { super("remote", dispatcher); }
}

export class TransportError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly retryable: boolean) {
    super(message);
    this.name = "TransportError";
  }
}

export interface AgentClientOptions {
  transport: ClientTransport;
  vmId?: string;
  requestIds?: () => string;
}

export class AgentClient {
  readonly transport: ClientTransport;
  readonly vmId: string;
  private readonly nextRequestId: () => string;
  private sequence = 0;

  constructor(options: AgentClientOptions) {
    this.transport = options.transport;
    this.vmId = options.vmId ?? "vm_01";
    this.nextRequestId = options.requestIds ?? (() => `cli-${++this.sequence}`);
  }

  async invoke<T extends Json = Json>(operation: OperationId, input: Json = {}, options: ClientRequestOptions = {}): Promise<ResponseEnvelope<T>> {
    const request: RequestEnvelope = {
      protocol_version: PROTOCOL_VERSION,
      request_id: options.requestId ?? this.nextRequestId(),
      operation,
      vm_id: options.vmId ?? this.vmId,
      deadline_ms: options.deadlineMs ?? 30_000,
      mutation_id: options.mutationId ?? null,
      input,
    };
    try {
      return await this.transport.dispatch(request, { signal: options.signal }) as ResponseEnvelope<T>;
    } catch (error) {
      const transportError = error instanceof TransportError
        ? error
        : new TransportError("internal", error instanceof Error ? error.message : "transport failed", false);
      return failure(request, {
        code: transportError.code,
        message: transportError.message,
        retryable: transportError.retryable,
      }) as ResponseEnvelope<T>;
    }
  }

  async status(options: ClientRequestOptions = {}): Promise<ResponseEnvelope> {
    const [info, vm, relay, egress] = await Promise.all([
      this.invoke("system.info", {}, options),
      this.invoke("vm.status", {}, options),
      this.invoke("relay.status", {}, options),
      this.invoke("network.egress", {}, options),
    ]);
    const firstError = [info, vm, relay, egress].find((result) => !result.ok);
    if (firstError && !firstError.ok) return firstError;
    return {
      ...(info as Extract<typeof info, { ok: true }>),
      operation: "system.info",
      result: {
        system: (info as Extract<typeof info, { ok: true }>).result,
        vm: (vm as Extract<typeof vm, { ok: true }>).result,
        relay: (relay as Extract<typeof relay, { ok: true }>).result,
        egress: (egress as Extract<typeof egress, { ok: true }>).result,
      },
    };
  }
}

export function fixtureTransport(kind: TransportKind, dispatcher?: FakeDispatcher): FixtureTransport {
  return kind === "remote" ? new RemoteFixtureTransport(dispatcher) : new LocalFixtureTransport(dispatcher);
}

export function transportFromEnvironment(env: NodeJS.ProcessEnv = process.env, dispatcher?: FakeDispatcher): FixtureTransport {
  return fixtureTransport(env.LOCALBOX_TRANSPORT === "remote" ? "remote" : "local", dispatcher);
}

export { ContractError };
