import { catalogById, failure, requestFromInvocation, type Json, type OperationId, type RequestEnvelope, type ResponseEnvelope } from "../../../packages/contract/src/index.js";

/** The caller, resolved from a machine credential (slice 08 adds agent tokens). */
export interface Principal { accountId: string; machineId: string }

export interface RelayResult { accountId?: string; status: "queued" | "claimed" | "completed" | "abandoned"; response?: ResponseEnvelope }

/** Everything the agent API needs from Convex, injected so the waiting logic is testable without it. */
export interface OpsDeps {
  /** Account-catalog call made as the caller's machine. */
  accountCall(principal: Principal, kind: "mutation" | "query", name: string, args: Record<string, unknown>): Promise<any>;
  /** Service-identity mutation (`relay:enqueue`, `relay:abandonIfUnclaimed`). */
  serviceMutation(name: string, args: Record<string, unknown>): Promise<any>;
  /** Subscribe to `relay:result`; returns the unsubscribe function. */
  watchResult(requestId: string, onChange: (result: RelayResult | null) => void): () => void;
  /** Lazy offline window: a request still unclaimed after this long is abandoned. */
  claimWindowMs?: number;
  /** Longest a single HTTP call waits before handing back a continuation. */
  maxWaitMs?: number;
}

export interface OpsResponse { status: number; body: unknown }

/** Operations about the account itself; they run against the catalog and are never relayed to a machine. */
export const ACCOUNT_OPERATIONS: Record<string, ["mutation" | "query", string]> = {
  "account.status": ["query", "accounts:status"], "account.rename": ["mutation", "accounts:rename"],
  "machine.list": ["query", "machines:list"], "machine.rename": ["mutation", "machines:rename"], "machine.remove": ["mutation", "machines:remove"],
};

/**
 * `POST /api/v1/ops`. Account operations run against the catalog directly. Every other operation is bound to a
 * machine: it is enqueued for that machine's connector, and this call waits on a Convex subscription for up to
 * min(deadline, 50 s). A request no connector claims within 3 s is abandoned and reported `machine_offline`; one
 * still running when the wait ends comes back as a continuation the client resumes with `{continue: request_id}`.
 */
export async function handleOps(principal: Principal, input: Record<string, unknown>, deps: OpsDeps): Promise<OpsResponse> {
  if (typeof input.continue === "string") return await waitFor(principal, input.continue, Number(input.deadline_at ?? 0), deps);
  const operation = String(input.operation ?? "");
  const account = ACCOUNT_OPERATIONS[operation];
  if (account) {
    const payload = (input.input ?? {}) as Record<string, unknown>;
    const args = operation === "machine.rename" || operation === "machine.remove" ? (({ machine_id: machineId, ...rest }) => ({ ...rest, machineId }))(payload) : payload;
    return { status: 200, body: await deps.accountCall(principal, account[0], account[1], args) };
  }
  if (!catalogById.has(operation as OperationId)) return { status: 400, body: { error: `unsupported operation: ${operation}` } };
  const request = requestFromInvocation({ operation: operation as OperationId, vm_id: typeof input.vm_id === "string" ? input.vm_id : "vm_01", request_id: typeof input.request_id === "string" ? input.request_id : `req_${crypto.randomUUID()}`, deadline_ms: typeof input.deadline_ms === "number" ? input.deadline_ms : undefined, mutation_id: typeof input.mutation_id === "string" ? input.mutation_id : null, input: (input.input ?? {}) as Json });
  const machine = await resolveMachine(principal, String(input.machine ?? ""), deps);
  if (!machine) return { status: 200, body: { response: failure(request, { code: "machine_not_found", message: `no machine named ${String(input.machine ?? "")} on this account`, retryable: false }) } };
  let queued: { requestId: string };
  try {
    queued = await deps.serviceMutation("relay:enqueue", { accountId: principal.accountId, machineId: machine.machineId, ...(typeof input.sandbox_id === "string" ? { sandboxId: input.sandbox_id } : {}), requestId: request.request_id, operation, ...(request.mutation_id ? { mutationId: request.mutation_id } : {}), payload: request });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const limit = message.match(/relay_daily_limit:\s*(.*)/);
    if (limit) return { status: 200, body: { response: failure(request, { code: "rate_limited", message: limit[1].trim(), retryable: true }) } };
    throw error;
  }
  return await waitFor(principal, queued.requestId, Date.now() + request.deadline_ms, deps, request);
}

async function resolveMachine(principal: Principal, wanted: string, deps: OpsDeps): Promise<{ machineId: string; name: string } | undefined> {
  if (!wanted) return undefined;
  const machines = await deps.accountCall(principal, "query", "machines:list", {}) as Array<{ machineId?: string; machine_id?: string; name?: string; machine_name?: string }>;
  const normalized = machines.map((row) => ({ machineId: row.machineId ?? row.machine_id ?? "", name: row.name ?? row.machine_name ?? "" }));
  return normalized.find((row) => row.machineId === wanted) ?? normalized.find((row) => row.name.toLowerCase() === wanted.toLowerCase());
}

async function waitFor(principal: Principal, requestId: string, deadlineAt: number, deps: OpsDeps, request?: RequestEnvelope): Promise<OpsResponse> {
  const claimWindowMs = deps.claimWindowMs ?? 3_000; const maxWaitMs = deps.maxWaitMs ?? 50_000;
  const envelope = request ?? requestFromInvocation({ operation: "system.info", request_id: requestId, input: {} });
  const started = Date.now(); const waitUntil = Math.min(deadlineAt || started + maxWaitMs, started + maxWaitMs);
  let latest: RelayResult | null = null; let abandonCall: Promise<{ abandoned?: boolean; lastSeenAt?: number } | undefined> | undefined;
  const outcome = await new Promise<"done" | "offline" | "timeout" | "foreign">((resolve) => {
    let settled = false; const timers: NodeJS.Timeout[] = [];
    const finish = (value: "done" | "offline" | "timeout" | "foreign") => { if (settled) return; settled = true; for (const timer of timers) clearTimeout(timer); unsubscribe(); resolve(value); };
    const unsubscribe = deps.watchResult(requestId, (result) => {
      latest = result;
      if (result?.accountId !== undefined && result.accountId !== principal.accountId) finish("foreign");
      else if (result?.status === "completed") finish("done");
      else if (result?.status === "abandoned") finish("offline");
    });
    timers.push(setTimeout(() => {
      abandonCall = deps.serviceMutation("relay:abandonIfUnclaimed", { requestId }).then((abandoned: { abandoned?: boolean; lastSeenAt?: number }) => { if (abandoned?.abandoned) finish("offline"); return abandoned; }, () => undefined);
    }, Math.max(0, claimWindowMs - (Date.now() - started))));
    timers.push(setTimeout(() => finish("timeout"), Math.max(0, waitUntil - Date.now())));
  });
  if (outcome === "foreign") return { status: 404, body: { error: "request not found" } };
  if (outcome === "done") return { status: 200, body: { response: (latest as RelayResult | null)?.response } };
  if (outcome === "offline") {
    // The subscription can report `abandoned` before our own abandon call returns the machine's last-seen time.
    const lastSeenAt = (await abandonCall)?.lastSeenAt;
    const seen = lastSeenAt === undefined ? "" : `; last seen ${new Date(lastSeenAt).toISOString()}`;
    return { status: 200, body: { response: failure(envelope, { code: "machine_offline", message: `the machine did not pick up the request within ${claimWindowMs / 1000} s${seen}`, retryable: true }) } };
  }
  if (deadlineAt && Date.now() >= deadlineAt) return { status: 200, body: { response: failure(envelope, { code: "operation_uncertain", message: `the machine took the request but did not answer before the deadline; replay with the same mutation id to get its result`, retryable: true }) } };
  return { status: 202, body: { status: "pending", request_id: requestId, deadline_at: deadlineAt } };
}
