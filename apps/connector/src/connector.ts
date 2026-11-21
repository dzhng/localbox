import { isDeepStrictEqual } from "node:util";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { ContractError, failure, OUTPUT_CAP_BYTES, PROTOCOL_VERSION, type CapacityReport, type Json, type RequestEnvelope, type ResponseEnvelope } from "../../../packages/contract/src/index.js";
import { contractError } from "../../relay/src/ops.js";
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
  /** This machine's id; its catalog pushes name it, so the daemon deletes only sandboxes this machine's catalog listed. */
  machineId: string;
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
/** A finished host operation, as the daemon's `host.operations` hands it over to be reported. `subject` is the image. */
export interface OperationOutcome {
  key: string; kind?: string; subject: string; state: "succeeded" | "failed";
  result?: { size_bytes?: number; min_macos?: string; ipsw_version?: string; bytes?: number; duration_ms?: number; path?: "local_network" | "internet" } | null; error?: { code: string; message: string; next_step?: string } | null;
}
/** One of this machine's copies as `images:copiesForMachine` lists it: what its daemon's side needs, key included. */
export interface CopyRendezvous { copy_id: string; operation_id: string; image_id: string; role: "sender" | "receiver"; key: string; size_bytes: number | null; state: string; candidates: Json[] | null; peer_candidates: Json[] | null; error: Json }
/** Where this Mac's side of a copy can be reached, as its daemon hands it over to publish; `generation` acknowledges it. */
interface CandidateOffer { copy_id: string; candidates: Json[]; generation: number }

export const relay = {
  pendingForMachine: makeFunctionReference<"query">("relay:pendingForMachine"),
  claim: makeFunctionReference<"mutation">("relay:claim"),
  complete: makeFunctionReference<"mutation">("relay:complete"),
  reportCapacity: makeFunctionReference<"mutation">("relay:reportCapacity"),
  forMachine: makeFunctionReference<"query">("sandboxes:forMachine"),
  reportState: makeFunctionReference<"mutation">("sandboxes:reportState"),
  removeIdle: makeFunctionReference<"mutation">("sandboxes:removeIdle"),
  setHolder: makeFunctionReference<"mutation">("images:setHolder"),
  imagesForMachine: makeFunctionReference<"query">("images:forMachine"),
  copiesForMachine: makeFunctionReference<"query">("images:copiesForMachine"),
  offerCandidates: makeFunctionReference<"mutation">("images:offerCandidates"),
  endCopy: makeFunctionReference<"mutation">("images:endCopy"),
  endCreate: makeFunctionReference<"mutation">("sandboxes:endCreate"),
};

const TOKEN_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
const WATCH_RETRY_MAX_MS = 30_000;
const REPORT_HEARTBEAT_MS = 60_000;
const OUTCOMES_TIMEOUT_MS = 25_000;
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
  private unsubscribeImageMirror?: () => void;
  private unsubscribeCopies?: () => void;
  /** This machine's copies as the subscription last listed them, so a restarted daemon can be handed them again. */
  private copies: CopyRendezvous[] = [];
  private copySeq = 0;
  private mirrorSeq = 0;
  /** Mirror pushes go to the daemon one at a time, in the order Convex sent them, so an older list never lands last. */
  private mirrorQueue: Promise<void> = Promise.resolve();
  private lastReportAt = 0;
  private reportSeq = 0;
  private outcomesSeq = 0;
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
    // A missing result is a failed read, not an empty catalog: mirroring it would delete every sandbox this Mac listed.
    this.unsubscribeMirror = this.deps.convex.onUpdate(relay.forMachine, {}, (rows: Json[] | null | undefined) => { if (!Array.isArray(rows)) return; this.mirrorQueue = this.mirrorQueue.then(() => this.mirror(rows)); },
      (error) => { if (!this.ended) { this.deps.log(`sandbox mirror subscription error: ${message(error)}`); this.recheckIdentity(error); } });
    // Image files follow the catalog the same way: an image deleted while this Mac was offline goes when it reconnects.
    this.unsubscribeImageMirror = this.deps.convex.onUpdate(relay.imagesForMachine, {}, (rows: Array<{ image_id: string }> | null | undefined) => { if (!Array.isArray(rows)) return; this.mirrorQueue = this.mirrorQueue.then(() => this.mirrorImages(rows.map((row) => row.image_id))); },
      (error) => { if (!this.ended) { this.deps.log(`image mirror subscription error: ${message(error)}`); this.recheckIdentity(error); } });
    // A copy's rendezvous (its key, the peer's candidates, its state) reaches the daemon whenever the row changes.
    this.unsubscribeCopies = this.deps.convex.onUpdate(relay.copiesForMachine, {}, (rows: CopyRendezvous[] | null | undefined) => { if (!Array.isArray(rows)) return; this.copies = rows; this.mirrorQueue = this.mirrorQueue.then(() => this.pushCopies()); },
      (error) => { if (!this.ended) { this.deps.log(`copy subscription error: ${message(error)}`); this.recheckIdentity(error); } });
    void this.watch();
    void this.reportOutcomes();
    void this.exchangeCandidates();
  }

  async stop(): Promise<void> { await this.end("stopped"); }

  private get ended(): boolean { return this.status.state === "revoked" || this.status.state === "stopped"; }

  private async end(state: "revoked" | "stopped", error?: Error): Promise<void> {
    if (this.ended) return;
    this.setState(state, error?.message);
    this.unsubscribe?.(); this.unsubscribeMirror?.(); this.unsubscribeImageMirror?.(); this.unsubscribeCopies?.();
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
   * Convex checks revocation on every call, so a removed machine's subscriptions fail with an `unauthorized`
   * ConvexError while its JWT is still valid (production Convex redacts any other error's message, so only the code counts). The token route is the authority: a forced refresh it refuses ends the connector as revoked.
   */
  private recheckIdentity(error: unknown): void {
    if (error instanceof ConvexError && error.data?.code === "unauthorized") void this.token(true);
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
      // A result Convex refuses (too large, over the daily result bytes) is replaced by a small failure naming why,
      // so the row completes instead of staying claimed and running again on the next delivery.
      try { await this.deps.convex.mutation(relay.complete, { requestId: id, response }); }
      catch (error) {
        const refused = contractError(error);
        if (refused.code !== "resource_exhausted" && refused.code !== "rate_limited") throw refused;
        const dropped = new ContractError(refused.code, `the operation ran, but its result was dropped: ${refused.message}`, refused.details, refused.retryable);
        await this.deps.convex.mutation(relay.complete, { requestId: id, response: failure(row.payload, dropped) });
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

  /**
   * Pushes the catalog's list of this machine's sandboxes. It comes from a subscription that succeeded while this
   * machine is signed in (a revoked machine's subscription errors instead), so it is authoritative (`source:
   * "catalog"`): the daemon deletes a sandbox this machine's catalog listed and no longer does, such as one deleted
   * while this Mac was off.
   */
  private async mirror(rows: Json[]): Promise<void> {
    if (this.ended) return;
    try {
      const response = await this.deps.daemon.dispatch(hostRequest("sandbox.mirror", { source: "catalog", machine_id: this.deps.machineId, sandboxes: rows }, `sandbox-mirror-${++this.mirrorSeq}`));
      if (!response.ok) { this.deps.log(`sandbox mirror refused: ${response.error.code}: ${response.error.message}`); return; }
      for (const deleted of (response.result as { deleted?: Array<{ sandbox_id: string; detail: string }> }).deleted ?? []) this.deps.log(`sandbox ${deleted.sandbox_id} is no longer in the catalog: ${deleted.detail}`);
    } catch (error) { this.deps.log(`sandbox mirror failed: ${message(error)}`); }
  }

  /** Pushes the image ids the catalog lists on this machine; the daemon removes the files of any its catalog listed before and no longer does. */
  private async mirrorImages(images: string[]): Promise<void> {
    if (this.ended) return;
    try {
      const response = await this.deps.daemon.dispatch(hostRequest("image.mirror", { machine_id: this.deps.machineId, images }, `image-mirror-${++this.mirrorSeq}`));
      if (!response.ok) { this.deps.log(`image mirror refused: ${response.error.code}: ${response.error.message}`); return; }
      for (const deleted of (response.result as { deleted?: Array<{ image: string; detail: string }> }).deleted ?? []) this.deps.log(deleted.detail);
    } catch (error) { this.deps.log(`image mirror failed: ${message(error)}`); }
  }

  /** Hands the daemon this machine's copies as Convex last listed them. */
  private async pushCopies(): Promise<void> {
    if (this.ended) return;
    try {
      const response = await this.deps.daemon.dispatch(hostRequest("image.copy_rendezvous", { copies: this.copies as unknown as Json }, `copy-rendezvous-${++this.copySeq}`));
      if (!response.ok) this.deps.log(`copy rendezvous refused: ${response.error.code}: ${response.error.message}`);
    } catch (error) { this.deps.log(`copy rendezvous failed: ${message(error)}`); }
  }

  /**
   * The other half of a copy's rendezvous: a long poll on the daemon (the local socket, never Convex) for where this
   * Mac's side of a copy can be reached, published to the copy's row and acknowledged on the next poll. The daemon also
   * names copies whose work has no rendezvous yet (it restarted), and gets the last listing again.
   */
  private async exchangeCandidates(): Promise<void> {
    let published: Array<{ copy_id: string; generation: number }> = []; let backoff = 1_000;
    while (!this.ended) {
      try {
        const response = await this.deps.daemon.dispatch(hostRequest("image.copy_outbox", { published, timeout_ms: OUTCOMES_TIMEOUT_MS }, `copy-outbox-${++this.copySeq}`, OUTCOMES_TIMEOUT_MS + 10_000));
        if (this.ended) return;
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
        published = [];
        const { offers = [], missing = [] } = response.result as { offers?: CandidateOffer[]; missing?: string[] };
        for (const offer of offers) {
          try { await this.deps.convex.mutation(relay.offerCandidates, { copyId: offer.copy_id, candidates: offer.candidates }); }
          catch (error) { if (contractError(error).code !== "image_not_found") throw error; this.deps.log(`copy ${offer.copy_id} is no longer on the account; its candidates have nowhere to go`); }
          published.push({ copy_id: offer.copy_id, generation: offer.generation });
        }
        if (this.copies.some((row) => missing.includes(row.operation_id))) this.mirrorQueue = this.mirrorQueue.then(() => this.pushCopies());
        backoff = 1_000;
      } catch (error) {
        if (this.ended) return;
        this.deps.log(`copy candidates failed: ${message(error)}`);
        await this.sleep(backoff); backoff = Math.min(backoff * 2, WATCH_RETRY_MAX_MS);
      }
    }
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
          catch (error) { if (contractError(error).code !== "sandbox_not_found") throw error; }
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

  /**
   * Long work on this Mac (an image build, capture or copy, a sandbox create waiting for its image's copy) runs in the
   * daemon's operation journal; when one finishes, its image's holder row here becomes `ready` (with the image's size)
   * or `failed` (with why), a copy's row hears how this side ended, and a waiting sandbox is created or failed. The daemon hands over
   * each outcome until a later poll says it was reported, so an outcome lands once the account is reachable, across
   * restarts of either process. An image the account deleted meanwhile has nothing left to report.
   */
  private async reportOutcomes(): Promise<void> {
    let reported: string[] = []; let backoff = 1_000;
    while (!this.ended) {
      try {
        const response = await this.deps.daemon.dispatch(hostRequest("host.operations", { reported, timeout_ms: OUTCOMES_TIMEOUT_MS }, `host-operations-${++this.outcomesSeq}`, OUTCOMES_TIMEOUT_MS + 10_000));
        if (this.ended) return;
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
        reported = [];
        for (const outcome of (response.result as { operations?: OperationOutcome[] }).operations ?? []) { await this.reportOutcome(outcome); reported.push(outcome.key); }
        backoff = 1_000;
      } catch (error) {
        if (this.ended) return;
        this.deps.log(`operation reports failed: ${message(error)}`);
        await this.sleep(backoff); backoff = Math.min(backoff * 2, WATCH_RETRY_MAX_MS);
      }
    }
  }

  private async reportOutcome(outcome: OperationOutcome): Promise<void> {
    if (outcome.kind === "image.copy") return await this.reportCopy(outcome);
    if (outcome.kind === "sandbox.create_after_copy") return await this.reportCreate(outcome);
    const { size_bytes: size, min_macos: minMacOS, ipsw_version: ipswVersion } = outcome.result ?? {};
    const args = outcome.state === "succeeded"
      ? { imageId: outcome.subject, operationId: outcome.key, state: "ready", ...(typeof size === "number" ? { sizeBytes: size } : {}), ...(typeof minMacOS === "string" ? { minMacOS } : {}), ...(typeof ipswVersion === "string" ? { ipswVersion } : {}) }
      : { imageId: outcome.subject, operationId: outcome.key, state: "failed", error: { code: outcome.error?.code ?? "internal", message: outcome.error?.message ?? "the operation failed", nextStep: outcome.error?.next_step ?? "try it again; if it fails the same way, check this Mac's disk space and logs" } };
    try { await this.deps.convex.mutation(relay.setHolder, args); this.deps.log(`image ${outcome.subject}: operation ${outcome.key} ${args.state}`); }
    catch (error) {
      if (contractError(error).code !== "image_not_found") throw error;
      this.deps.log(`image ${outcome.subject} is no longer on the account; operation ${outcome.key} has nothing to report`);
    }
  }

  /** How this Mac's side of a copy ended; Convex decides what that means for the copy and the target's holding. */
  private async reportCopy(outcome: OperationOutcome): Promise<void> {
    const done = outcome.result;
    const args = outcome.state === "succeeded"
      ? { operationId: outcome.key, state: "succeeded", ...(typeof done?.size_bytes === "number" ? { sizeBytes: done.size_bytes } : {}), ...(typeof done?.bytes === "number" && typeof done.duration_ms === "number" && done.path ? { result: { bytes: done.bytes, durationMs: done.duration_ms, path: done.path } } : {}) }
      : { operationId: outcome.key, state: "failed", error: { code: outcome.error?.code ?? "internal", message: outcome.error?.message ?? "the copy failed", nextStep: outcome.error?.next_step ?? "copy it again; if it fails the same way, check both Macs' logs" } };
    const reported = await this.deps.convex.mutation(relay.endCopy, args) as { reported?: boolean } | null;
    this.deps.log(reported?.reported === false ? `copy ${outcome.key} is no longer on the account; nothing to report` : `image ${outcome.subject}: copy ${outcome.key} ${outcome.state}`);
  }

  /** How a sandbox create that waited for its image's copy ended; its catalog row stops reading `copying`. */
  private async reportCreate(outcome: OperationOutcome): Promise<void> {
    const args = outcome.state === "succeeded"
      ? { operationId: outcome.key, state: "succeeded" }
      : { operationId: outcome.key, state: "failed", error: { code: outcome.error?.code ?? "internal", message: outcome.error?.message ?? "the create failed", nextStep: outcome.error?.next_step ?? "delete the sandbox and create it again" } };
    const reported = await this.deps.convex.mutation(relay.endCreate, args) as { reported?: boolean; sandbox_id?: string } | null;
    this.deps.log(reported?.reported === false ? `sandbox create ${outcome.key} is no longer on the account; nothing to report` : `sandbox ${reported?.sandbox_id ?? outcome.key}: create after copy ${outcome.state}`);
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
