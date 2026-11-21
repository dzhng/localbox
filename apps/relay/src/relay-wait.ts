import { catalogById, failure, requestFromInvocation, validateRequest, type OperationId, type RequestEnvelope, type ResponseEnvelope } from "../../../packages/contract/src/index.js";
import { contractError } from "../../../packages/contract/src/convex-errors.js";

/** The caller: one of the account's machines (machine credential) or a signed-in agent (OAuth token family). */
export interface Principal { accountId: string; machineId?: string; familyId?: string }

/** A relay row as `relay:result` reads it: its state, the request it carries, and the machine's answer once there is one. */
export interface RelayResult { accountId?: string; status: "queued" | "claimed" | "completed" | "abandoned"; request?: RequestEnvelope; response?: ResponseEnvelope }

/** Everything the agent API needs from Convex, injected so the waiting logic is testable without it. */
export interface OpsDeps {
  /** Account-catalog call made as the caller (its machine, or its agent token family). */
  accountCall(principal: Principal, kind: "mutation" | "query", name: string, args: Record<string, unknown>): Promise<any>;
  /** Service-identity mutation (`relay:enqueue`, `relay:abandonIfUnclaimed`). */
  serviceMutation(name: string, args: Record<string, unknown>): Promise<any>;
  /** Subscribe to `relay:result` (null: no such request); `onError` hears a failed subscription. Returns the unsubscribe function. */
  watchResult(requestId: string, onChange: (result: RelayResult | null) => void, onError: (error: Error) => void): () => void;
  /** Lazy offline window: a request still unclaimed after this long is abandoned. */
  claimWindowMs?: number;
  /** Longest a single HTTP call waits before handing back a continuation. */
  maxWaitMs?: number;
}

export interface OpsResponse { status: number; body: unknown }

/**
 * A relayed request as this call leaves it, by where its answer came from. `machine`: the machine answered, and the
 * relay's dedupe keeps that answer for the mutation id, so a replay gets it back. `relay`: the request never reached a
 * machine (a refused enqueue, a machine that never claimed it). `lost`: the machine took the request and the relay lost
 * its answer, so the work may still finish. `pending`: still running when this call's wait ended; the caller continues
 * with `{continue: request_id}`.
 */
export type Relayed = { request: RequestEnvelope } & ({ response: ResponseEnvelope; from: "machine" | "relay" | "lost" } | { pending: { request_id: string; deadline_at: number } });

export const answer = (response: ResponseEnvelope): OpsResponse => ({ status: 200, body: { response } });
export const toHttp = (relayed: Relayed): OpsResponse => "response" in relayed ? answer(relayed.response) : { status: 202, body: { status: "pending", ...relayed.pending } };
/** A failure after which nothing runs under the request's mutation id: whatever it reserved can go. */
export const refusal = (relayed: Relayed) => "response" in relayed && !relayed.response.ok && relayed.from !== "lost" ? relayed.response : undefined;
/** The answer, once there is one: undefined while the request is still running past this call's wait. */
export const responseOf = (relayed: Relayed): ResponseEnvelope | undefined => "response" in relayed ? relayed.response : undefined;

/**
 * Enqueues `request` for `machineId` and waits for its answer; a malformed envelope or a refused enqueue (machine
 * removed, daily limit) answers as a failure. A create carries the sandbox id it reserved although its operation takes
 * no sandbox, so that one field is checked as the catalog defines it.
 */
export async function relay(principal: Principal, machineId: string, request: RequestEnvelope, deps: OpsDeps): Promise<Relayed> {
  let queued: { requestId: string };
  try {
    validateRequest(catalogById.get(request.operation as OperationId)?.sandbox_scoped ? request : { ...request, sandbox_id: null });
    queued = await deps.serviceMutation("relay:enqueue", { accountId: principal.accountId, machineId, ...(request.sandbox_id ? { sandboxId: request.sandbox_id } : {}), requestId: request.request_id, operation: request.operation, ...(request.mutation_id ? { mutationId: request.mutation_id } : {}), payload: request });
  } catch (error) { return { request, from: "relay", response: failure(request, contractError(error)) }; }
  const relayed = await waitFor(principal, queued.requestId, Date.now() + request.deadline_ms, deps, request);
  if (!relayed) throw new Error(`request ${queued.requestId} left the relay while it was being waited on`);
  return relayed;
}

/**
 * Waits on a Convex subscription for the relay row's answer, for up to min(deadline, `maxWaitMs`). A row no connector
 * claims within the claim window is abandoned (`machine_offline`). Undefined: no such request on the caller's account.
 */
export async function waitFor(principal: Principal, requestId: string, deadlineAt: number, deps: OpsDeps, request?: RequestEnvelope): Promise<Relayed | undefined> {
  const claimWindowMs = deps.claimWindowMs ?? 3_000; const maxWaitMs = deps.maxWaitMs ?? 50_000;
  const started = Date.now(); const waitUntil = Math.min(deadlineAt || started + maxWaitMs, started + maxWaitMs);
  let latest: RelayResult | null = null; let abandonCall: Promise<{ abandoned?: boolean; lastSeenAt?: number } | undefined> | undefined;
  type Outcome = "done" | "offline" | "timeout" | "missing" | "lost";
  const outcome = await new Promise<Outcome>((resolve) => {
    let settled = false; const timers: NodeJS.Timeout[] = []; let unsubscribe: (() => void) | undefined;
    const finish = (value: Outcome) => { if (settled) return; settled = true; for (const timer of timers) clearTimeout(timer); unsubscribe?.(); resolve(value); };
    unsubscribe = deps.watchResult(requestId, (result) => {
      latest = result;
      // Another account's request is reported exactly like one that does not exist.
      if (result === null || (result.accountId !== undefined && result.accountId !== principal.accountId)) finish("missing");
      else if (result.status === "completed") finish("done");
      else if (result.status === "abandoned") finish("offline");
    }, () => finish("lost"));
    // The first result can arrive synchronously and end the wait before there is anything to unsubscribe or time.
    if (settled) { unsubscribe(); return; }
    timers.push(setTimeout(() => {
      abandonCall = deps.serviceMutation("relay:abandonIfUnclaimed", { requestId }).then((abandoned: { abandoned?: boolean; lastSeenAt?: number }) => { if (abandoned?.abandoned) finish("offline"); return abandoned; }, () => undefined);
    }, Math.max(0, claimWindowMs - (Date.now() - started))));
    timers.push(setTimeout(() => finish("timeout"), Math.max(0, waitUntil - Date.now())));
  });
  if (outcome === "missing") return undefined;
  const last = latest as RelayResult | null;
  const envelope = request ?? last?.request ?? requestFromInvocation({ operation: "system.info", request_id: requestId, input: {} });
  // The request is queued and may still run, so a subscription that failed is a lost answer, never a guess.
  if (outcome === "lost") return { request: envelope, from: "lost", response: failure(envelope, { code: "operation_uncertain", message: "the relay lost track of the request's answer; replay with the same mutation id to get its result", retryable: true }) };
  if (outcome === "done") return { request: envelope, from: "machine", response: last!.response! };
  if (outcome === "offline") {
    // The subscription can report `abandoned` before our own abandon call returns the machine's last-seen time.
    const lastSeenAt = (await abandonCall)?.lastSeenAt;
    const seen = lastSeenAt === undefined ? "" : `; last seen ${new Date(lastSeenAt).toISOString()}`;
    return { request: envelope, from: "relay", response: failure(envelope, { code: "machine_offline", message: `the machine did not pick up the request within ${claimWindowMs / 1000} s${seen}`, retryable: true }) };
  }
  if (deadlineAt && Date.now() >= deadlineAt) return { request: envelope, from: "lost", response: failure(envelope, { code: "operation_uncertain", message: "the machine took the request but did not answer before the deadline; replay with the same mutation id to get its result", retryable: true }) };
  return { request: envelope, pending: { request_id: requestId, deadline_at: deadlineAt } };
}
