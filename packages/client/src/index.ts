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
  return fixtureTransport(env.AGENT_COMPUTER_TRANSPORT === "remote" ? "remote" : "local", dispatcher);
}

export { ContractError };
