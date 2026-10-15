import {
  catalogById, ContractError, failure, operationCatalog, type Json, type OperationId,
  PROTOCOL_VERSION, RELEASE_ID, success, validateRequest, type RequestEnvelope, type ResponseEnvelope,
} from "../../contract/src/index.js";

export class FixtureClock {
  private timestamp: number;
  constructor(startMs = 1_700_000_000_000) { this.timestamp = startMs; }
  now(): number { return this.timestamp; }
  advance(ms: number): number { if (!Number.isFinite(ms) || ms < 0) throw new RangeError("fixture clock only advances by non-negative milliseconds"); this.timestamp += ms; return this.timestamp; }
  sleep(ms: number): Promise<void> { this.advance(ms); return Promise.resolve(); }
}

export interface DispatchContext {
  readonly request: RequestEnvelope;
  readonly operation: OperationId;
  readonly clock: FixtureClock;
  readonly release_id: typeof RELEASE_ID;
  readonly signal?: AbortSignal;
  cancelled(): boolean;
  assertActive(): void;
}
export type Handler = (input: Json, context: DispatchContext) => Json | Promise<Json>;
export type HandlerRegistry = Partial<Record<OperationId, Handler>>;
/** The one sandbox the in-process fixture runtime pretends to have. */
export const FIXTURE_SANDBOX_ID = "sandbox_fixture";

function defaultResult(request: RequestEnvelope, clock: FixtureClock): Json {
  switch (request.operation) {
    case "system.info": return { protocol_version: PROTOCOL_VERSION, release_id: RELEASE_ID, sandbox_id: request.sandbox_id, runtime: "fake", clock_ms: clock.now() };
    case "sandbox.list": return { sandboxes: [{ sandbox_id: FIXTURE_SANDBOX_ID, name: "fixture", state: "running" }] };
    case "sandbox.status": return { sandbox_id: request.sandbox_id, name: "fixture", state: "running", clock_ms: clock.now() };
    case "network.egress": return { connected: true, address: "198.51.100.42", source: "fixture" };
    case "relay.status": return { connected: true, relay_id: "relay_fixture" };
    case "job.status": return { job_id: (request.input as { job_id: string }).job_id, status: "completed" };
    case "job.wait": return { job_id: (request.input as { job_id: string }).job_id, status: "completed" };
    case "job.output": return { job_id: (request.input as { job_id: string }).job_id, output: "" };
    case "fs.read": return { path: (request.input as { path: string }).path, content: "" };
    case "fs.list": return { path: (request.input as { path: string }).path, entries: [] };
    case "fs.stat": return { path: (request.input as { path: string }).path, exists: false };
    case "browser.list_tabs": return { tabs: [] };
    case "browser.screenshot": return { mime_type: "image/png", data: "fixture-screenshot" };
    case "desktop.screenshot": return { mime_type: "image/png", data: "fixture-screenshot" };
    default: return { ok: true, operation: request.operation, sandbox_id: request.sandbox_id, fixture: true, clock_ms: clock.now() };
  }
}

export interface DispatchOptions { signal?: AbortSignal; }
export class FakeDispatcher {
  readonly clock: FixtureClock;
  readonly handlers: Map<OperationId, Handler>;
  private readonly mutationResults = new Map<string, ResponseEnvelope>();
  /** A mutation replayed while its first run is still going (a restarted connector) waits for that run. */
  private readonly mutationsInFlight = new Map<string, Promise<ResponseEnvelope>>();
  constructor(options: { clock?: FixtureClock; handlers?: HandlerRegistry } = {}) {
    this.clock = options.clock ?? new FixtureClock();
    this.handlers = new Map(operationCatalog.map((entry) => [entry.id, (_input: Json, context: DispatchContext) => defaultResult(context.request, context.clock)]));
    for (const [id, handler] of Object.entries(options.handlers ?? {})) if (handler) this.handlers.set(id as OperationId, handler);
  }
  register(operation: OperationId, handler: Handler): void { if (!catalogById.has(operation)) throw new ContractError("invalid_input", `unknown operation: ${operation}`); this.handlers.set(operation, handler); }
  async dispatch(request: RequestEnvelope, options: DispatchOptions = {}): Promise<ResponseEnvelope> {
    try { validateRequest(request); } catch (error) {
      if (error instanceof ContractError) {
        const candidate = request as Partial<RequestEnvelope>;
        if (typeof candidate.request_id === "string" && typeof candidate.operation === "string") return failure(candidate as RequestEnvelope, error);
      }
      throw error;
    }
    const entry = catalogById.get(request.operation as OperationId)!;
    const key = request.mutation_id ? `${request.sandbox_id}:${request.operation}:${request.mutation_id}` : undefined;
    if (key && this.mutationResults.has(key)) return this.mutationResults.get(key)!;
    if (key && this.mutationsInFlight.has(key)) return await this.mutationsInFlight.get(key)!;
    if (!key) return await this.run(request, entry, key, options);
    const running = this.run(request, entry, key, options);
    this.mutationsInFlight.set(key, running);
    try { return await running; } finally { this.mutationsInFlight.delete(key); }
  }
  private async run(request: RequestEnvelope, entry: NonNullable<ReturnType<typeof catalogById.get>>, key: string | undefined, options: DispatchOptions): Promise<ResponseEnvelope> {
    const started = this.clock.now();
    const signal = options.signal;
    const context: DispatchContext = {
      request, operation: request.operation as OperationId, clock: this.clock, release_id: RELEASE_ID, signal,
      cancelled: () => signal?.aborted === true,
      assertActive: () => {
        if (signal?.aborted) throw new ContractError("operation_cancelled", "operation cancelled", undefined, false);
        if (this.clock.now() - started > request.deadline_ms) throw new ContractError("operation_timeout", "operation deadline exceeded", { elapsed_ms: this.clock.now() - started, deadline_ms: request.deadline_ms }, true);
      }
    };
    try {
      context.assertActive();
      const handler = this.handlers.get(request.operation as OperationId)!;
      const result = await handler(request.input, context);
      context.assertActive();
      const response = success(request, result);
      if (key) this.mutationResults.set(key, response);
      return response;
    } catch (error) {
      const contractError = error instanceof ContractError ? error : new ContractError("internal", error instanceof Error ? error.message : "handler failed", undefined, false);
      const response = failure(request, contractError);
      if (key && contractError.code === "operation_uncertain") this.mutationResults.set(key, response);
      return response;
    }
  }
  async invokeAll(sandboxId = FIXTURE_SANDBOX_ID): Promise<ResponseEnvelope[]> {
    const responses: ResponseEnvelope[] = [];
    for (const entry of operationCatalog) {
      const input = sampleInput(entry.id);
      const request: RequestEnvelope = { protocol_version: PROTOCOL_VERSION, request_id: `parity-${entry.id.replaceAll(".", "-")}`, operation: entry.id, sandbox_id: entry.sandbox_scoped ? sandboxId : null, deadline_ms: 30_000, mutation_id: entry.idempotency === "required" ? `mutation-${entry.id.replaceAll(".", "-")}` : null, input };
      responses.push(await this.dispatch(request));
    }
    return responses;
  }
}

export function sampleInput(operation: OperationId): Json {
  if (operation === "account.rename") return { name: "account-name" };
  if (operation === "machine.rename") return { machine_id: "machine_fixture", name: "machine-name" };
  if (operation === "machine.remove") return { machine_id: "machine_fixture" };
  if (operation === "sandbox.rename") return { name: "sandbox-name" };
  if (["shell.exec"].includes(operation)) return { command: "true" };
  if (["job.status", "job.wait", "job.cancel", "job.output"].includes(operation)) return { job_id: "job_fixture" };
  if (["fs.list", "fs.stat", "fs.read"].includes(operation)) return { path: "/tmp/fixture" };
  if (operation === "fs.write") return { path: "/tmp/fixture", content: "fixture" };
  if (operation === "fs.mkdir") return { path: "/tmp/fixture" };
  if (operation === "fs.remove") return { path: "/tmp/fixture" };
  if (operation === "browser.open") return { url: "https://example.test" };
  if (["browser.navigate"].includes(operation)) return { tab_id: "tab_fixture", url: "https://example.test" };
  if (["browser.focus", "browser.close", "browser.screenshot"].includes(operation)) return { tab_id: "tab_fixture" };
  if (operation === "browser.click") return { tab_id: "tab_fixture", x: 1, y: 1 };
  if (operation === "browser.type") return { tab_id: "tab_fixture", text: "fixture" };
  if (operation === "browser.key") return { tab_id: "tab_fixture", key: "ENTER" };
  if (operation === "desktop.click") return { x: 1, y: 1 };
  if (operation === "desktop.move") return { x: 1, y: 1 };
  if (operation === "desktop.scroll") return { x: 1, y: 1, delta_y: 1 };
  if (operation === "desktop.key") return { key: "ENTER" };
  if (operation === "desktop.type") return { text: "fixture" };
  return {};
}
