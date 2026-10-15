import { isDeepStrictEqual } from "node:util";
import { makeFunctionReference } from "convex/server";
import { failure, OUTPUT_CAP_BYTES, PROTOCOL_VERSION, type CapacityReport, type Json, type RequestEnvelope, type ResponseEnvelope } from "../../../packages/contract/src/index.js";
import { RevokedError } from "./token.js";

export type ConnectorState = "connecting" | "connected" | "revoked" | "stopped";
export interface ConnectorStatus { state: ConnectorState; lastError?: string }

/** The subset of `ConvexClient` from "convex/browser" the connector uses. */
export interface ConvexLike {
  setAuth(fetchToken: (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>, onChange?: (authenticated: boolean) => void): void;
  onUpdate(query: any, args: any, callback: (result: any) => unknown, onError?: (error: Error) => unknown): () => void;
  mutation(fn: any, args: any): Promise<any>;
  close(): Promise<void>;
}

export interface PendingRow {
  requestId: string; operation: string; sandboxId?: string; mutationId?: string;
  status?: string; payload: RequestEnvelope; claimDeadlineAt: number;
}

export interface ConnectorDeps {
  convex: ConvexLike;
  daemon: { dispatch(request: RequestEnvelope): Promise<ResponseEnvelope> };
  hostWatch(since: number): Promise<HostChange>;
  /** Machine JWT for Convex; throws `RevokedError` when the machine was removed. */
  fetchToken(forceRefresh: boolean): Promise<string>;
  log(line: string): void;
  sleep?: (ms: number) => Promise<void>;
}

/** One `host.watch` answer: the daemon's state version, host capacity, each sandbox's runtime state, and the sandboxes its idle policy deleted. */
export interface HostChange { version: number; capacity?: CapacityReport; sandboxes?: SandboxState[]; deleted?: IdleDeletion[] }
export interface IdleDeletion { sandbox_id: string; name: string; reason: string }
export interface SandboxState { sandbox_id: string; state: string; cpus?: number; memory_bytes?: number }

export const relay = {
  pendingForMachine: makeFunctionReference<"query">("relay:pendingForMachine"),
  claim: makeFunctionReference<"mutation">("relay:claim"),
  complete: makeFunctionReference<"mutation">("relay:complete"),
  reportCapacity: makeFunctionReference<"mutation">("relay:reportCapacity"),
  forMachine: makeFunctionReference<"query">("sandboxes:forMachine"),
  reportState: makeFunctionReference<"mutation">("sandboxes:reportState"),
  removeIdle: makeFunctionReference<"mutation">("sandboxes:removeIdle"),
};

const TOKEN_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
const WATCH_RETRY_MAX_MS = 30_000;
const REPORT_HEARTBEAT_MS = 60_000;
const RECENT_LIMIT = 512;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Claims this machine's relay rows from Convex and runs them on the local
 * HostDaemon. Convex is only called in response to a subscription update, a
 * capacity change or a token refresh, so an idle machine makes no calls.
 */
export class Connector {
  private status: ConnectorStatus = { state: "connecting" };
  private readonly inFlight = new Set<string>();
  private readonly recent = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  private unsubscribe?: () => void;
  private unsubscribeMirror?: () => void;
  private mirrorSeq = 0;
  private lastReportAt = 0;
  private reportSeq = 0;
  private settle!: { resolve(state: ConnectorState): void; reject(error: Error): void };
  /** Resolves with "revoked" or "stopped" when the connector ends; rejects on a fatal error. */
  readonly finished = new Promise<ConnectorState>((resolve, reject) => { this.settle = { resolve, reject }; });

  constructor(private readonly deps: ConnectorDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  state(): ConnectorStatus { return { ...this.status }; }

  start(): void {
    void this.report();
    this.deps.convex.setAuth((args) => this.token(args.forceRefreshToken), (authenticated) => {
      if (this.ended) return;
      this.setState(authenticated ? "connected" : "connecting", authenticated ? undefined : "Convex rejected the machine token");
    });
    this.unsubscribe = this.deps.convex.onUpdate(relay.pendingForMachine, {}, (rows: PendingRow[]) => { for (const row of rows ?? []) void this.run(row); },
      (error) => { if (!this.ended) { this.setState(this.status.state, `subscription error: ${message(error)}`); this.recheckIdentity(error); } });
    // The daemon's identity mirror follows the catalog, so a rename or delete made while this Mac was offline lands on reconnect.
    this.unsubscribeMirror = this.deps.convex.onUpdate(relay.forMachine, {}, (rows: Json[]) => void this.mirror(rows ?? []),
      (error) => { if (!this.ended) { this.deps.log(`sandbox mirror subscription error: ${message(error)}`); this.recheckIdentity(error); } });
    void this.watch();
  }

  async stop(): Promise<void> { await this.end("stopped"); }

  private get ended(): boolean { return this.status.state === "revoked" || this.status.state === "stopped"; }

  private async end(state: "revoked" | "stopped", error?: Error): Promise<void> {
    if (this.ended) return;
    this.setState(state, error?.message);
    this.unsubscribe?.(); this.unsubscribeMirror?.();
    try { await this.deps.convex.close(); } catch (closeError) { this.deps.log(`close failed: ${message(closeError)}`); }
    if (error && !(error instanceof RevokedError)) this.settle.reject(error); else this.settle.resolve(state);
  }

  private async token(forceRefresh: boolean): Promise<string | null> {
    for (let attempt = 0; !this.ended; attempt++) {
      try { return await this.deps.fetchToken(forceRefresh); }
      catch (error) {
        if (this.ended) return null;
        if (error instanceof RevokedError) { this.deps.log(`machine credential revoked: ${error.message}; stopping`); void this.end("revoked", error); return null; }
        this.status.lastError = message(error);
        if (attempt >= TOKEN_RETRY_DELAYS_MS.length) { void this.end("stopped", error instanceof Error ? error : new Error(message(error))); return null; }
        this.deps.log(`machine token fetch failed: ${message(error)}; retrying`);
        await this.sleep(TOKEN_RETRY_DELAYS_MS[attempt]);
      }
    }
    return null;
  }

  /**
   * Convex checks revocation on every call, so a removed machine's subscriptions fail with a Forbidden error while
   * its JWT is still valid. The token route is the authority: a forced refresh it refuses ends the connector as revoked.
   */
  private recheckIdentity(error: unknown): void {
    if (/Forbidden: machine/.test(message(error))) void this.token(true);
  }

  private async run(row: PendingRow): Promise<void> {
    const id = row.requestId;
    if (this.ended || this.inFlight.has(id) || this.recent.has(id)) return;
    this.inFlight.add(id);
    try {
      const claim = await this.deps.convex.mutation(relay.claim, { requestId: id }) as { claimed: boolean; status?: string };
      if (!claim?.claimed) { this.remember(id); return; }
      let response: ResponseEnvelope;
      try { response = await this.deps.daemon.dispatch(row.payload); }
      catch (error) { response = failure(row.payload, { code: "guest_unreachable", message: `HostDaemon dispatch failed: ${message(error)}`, retryable: true }); }
      const bytes = Buffer.byteLength(JSON.stringify(response));
      if (bytes > OUTPUT_CAP_BYTES) response = tooLarge(row.payload, bytes);
      try { await this.deps.convex.mutation(relay.complete, { requestId: id, response }); }
      catch (error) {
        if (!message(error).includes("response_too_large")) throw error;
        await this.deps.convex.mutation(relay.complete, { requestId: id, response: tooLarge(row.payload, bytes) });
      }
      this.remember(id);
    } catch (error) {
      this.deps.log(`request ${id} failed: ${message(error)}`);
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** Rows stay in the subscription until Convex sees `complete`; this stops a re-delivery from claiming again. */
  private remember(id: string): void {
    this.recent.add(id);
    if (this.recent.size > RECENT_LIMIT) this.recent.delete(this.recent.values().next().value!);
  }

  private async mirror(rows: Json[]): Promise<void> {
    try {
      const response = await this.deps.daemon.dispatch(hostRequest("sandbox.mirror", { sandboxes: rows }, `sandbox-mirror-${++this.mirrorSeq}`));
      if (!response.ok) this.deps.log(`sandbox mirror refused: ${response.error.code}: ${response.error.message}`);
    } catch (error) { this.deps.log(`sandbox mirror failed: ${message(error)}`); }
  }

  private async watch(): Promise<void> {
    let since = 0; let capacity: CapacityReport | undefined; let backoff = 1_000;
    const states = new Map<string, SandboxState>(); const removed = new Set<string>();
    while (!this.ended) {
      try {
        const change = await this.deps.hostWatch(since);
        if (this.ended) return;
        // The daemon moves `revision` only when what its sandboxes reserve changes. A restarted daemon counts
        // revisions from the start again, so the whole report is compared as well.
        const report = change.capacity;
        if (report && (!capacity || report.revision !== capacity.revision || !isDeepStrictEqual(report, capacity))) {
          await this.deps.convex.mutation(relay.reportCapacity, { capacity: report });
          capacity = report;
        }
        const changed = (change.sandboxes ?? []).filter((sandbox) => !isDeepStrictEqual(states.get(sandbox.sandbox_id), sandbox));
        if (changed.length) {
          await this.deps.convex.mutation(relay.reportState, { states: changed.map((sandbox) => ({ sandboxId: sandbox.sandbox_id, state: sandbox.state, ...(sandbox.cpus ? { cpus: sandbox.cpus } : {}), ...(sandbox.memory_bytes ? { memoryBytes: sandbox.memory_bytes } : {}) })) });
          for (const sandbox of changed) states.set(sandbox.sandbox_id, sandbox);
        }
        // The daemon deleted these after their delete-after idle time; their catalog rows go too.
        for (const gone of (change.deleted ?? []).filter((item) => !removed.has(item.sandbox_id))) {
          try { await this.deps.convex.mutation(relay.removeIdle, { sandboxId: gone.sandbox_id, reason: gone.reason }); }
          catch (error) { if (!message(error).includes("sandbox_not_found")) throw error; }
          removed.add(gone.sandbox_id); states.delete(gone.sandbox_id);
          this.deps.log(`removed ${gone.name} (${gone.sandbox_id}) from the catalog: ${gone.reason}`);
        }
        since = change.version; backoff = 1_000;
        if (Date.now() - this.lastReportAt >= REPORT_HEARTBEAT_MS) void this.report();
      } catch (error) {
        if (this.ended) return;
        this.deps.log(`host watch failed: ${message(error)}`);
        await this.sleep(backoff); backoff = Math.min(backoff * 2, WATCH_RETRY_MAX_MS);
      }
    }
  }

  private setState(state: ConnectorState, lastError = state === "connected" ? undefined : this.status.lastError): void {
    const changed = state !== this.status.state || lastError !== this.status.lastError;
    this.status = lastError === undefined ? { state } : { state, lastError };
    if (changed) { this.deps.log(`state ${state}${lastError ? `: ${lastError}` : ""}`); void this.report(); }
  }

  /** Tell the daemon our state so `relay.status` answers from it; the daemon treats a report older than 120 s as not running. */
  private async report(): Promise<void> {
    this.lastReportAt = Date.now();
    const input: Record<string, Json> = { state: this.status.state, ...(this.status.lastError ? { detail: this.status.lastError } : {}) };
    try { await this.deps.daemon.dispatch(hostRequest("connector.report", input, `connector-report-${++this.reportSeq}`)); }
    catch (error) { this.deps.log(`state report failed: ${message(error)}`); }
  }
}

function tooLarge(request: RequestEnvelope, bytes: number): ResponseEnvelope {
  return failure(request, { code: "resource_exhausted", message: `response is ${bytes} bytes, over the ${OUTPUT_CAP_BYTES}-byte relay cap`, retryable: false });
}

/** Host-internal socket operations are machine-level, so they name no sandbox. */
export function hostRequest(operation: string, input: Json, requestId: string, deadlineMs = 30_000): RequestEnvelope {
  return { protocol_version: PROTOCOL_VERSION, request_id: requestId, operation, sandbox_id: null, deadline_ms: deadlineMs, mutation_id: null, input };
}
