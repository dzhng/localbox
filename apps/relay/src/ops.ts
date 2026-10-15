import {
  catalogById, ContractError, defaultSize, failure, requestFromInvocation, success, validateJson,
  type ActionReport, type CapacityReport, type ErrorCode, type Json, type OperationId, type RequestEnvelope, type ResponseEnvelope,
} from "../../../packages/contract/src/index.js";
import { place } from "../../../packages/placement/src/index.js";

/** The caller: one of the account's machines (machine credential) or a signed-in agent (OAuth token family). */
export interface Principal { accountId: string; machineId?: string; familyId?: string }

export interface RelayResult { accountId?: string; status: "queued" | "claimed" | "completed" | "abandoned"; response?: ResponseEnvelope }

/** Everything the agent API needs from Convex, injected so the waiting logic is testable without it. */
export interface OpsDeps {
  /** Account-catalog call made as the caller (its machine, or its agent token family). */
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

/** A row of `machines:list`: the machine's last capacity report and when it last reached the relay. */
interface MachineRow { machineId: string; name: string; lastSeenAt?: number; capacity?: CapacityReport; capacityAt?: number }

/** A row of `sandboxes:list`. */
export interface SandboxRow { sandbox_id: string; name: string; machine_id: string; machine_name: string | null; cpus: number; memory_bytes: number; sleep_after_ms: number; delete_after_ms: number | null; state: string }

/** Operations that only read or change the account catalog; they are never relayed to a machine. */
export const ACCOUNT_OPERATIONS: Record<string, ["mutation" | "query", string]> = {
  "account.status": ["query", "accounts:status"], "account.rename": ["mutation", "accounts:rename"],
  "machine.list": ["query", "machines:list"], "machine.rename": ["mutation", "machines:rename"], "machine.remove": ["mutation", "machines:remove"],
  "sandbox.list": ["query", "sandboxes:list"],
};

const GIB = 1024 ** 3;
/**
 * A machine counts as online for placement when it reached the relay (a claim or a token fetch) or reported capacity
 * this recently. Connectors write only on change, so an idle Mac can read offline; a create relayed to a machine that
 * is really gone still fails within the 3 s claim window.
 */
/** Placement prefers machines with room for the sandbox; with no size asked, that is the smallest default size. */
const SMALLEST_DEFAULT_BYTES = 2 * GIB;
const errorCodes: ErrorCode[] = ["name_conflict", "sandbox_not_found", "machine_not_found", "quota_exceeded", "invalid_input"];
/** Convex functions signal contract errors as `<code>: message`; anything else is not the caller's to see. */
function contractError(error: unknown): ContractError {
  const text = error instanceof Error ? error.message : String(error);
  const coded = text.match(new RegExp(`(${errorCodes.join("|")}): ([^\\n]*)`));
  if (coded) return new ContractError(coded[1] as ErrorCode, coded[2].trim());
  const label = text.match(/label must be [^\n]*/);
  if (label) return new ContractError("invalid_input", `sandbox name: ${label[0]}`);
  throw error;
}
const answer = (response: ResponseEnvelope): OpsResponse => ({ status: 200, body: { response } });

/**
 * `POST /api/v1/ops`. Account operations run against the catalog. `sandbox.create`, `.rename` and `.delete` change
 * the catalog and tell the sandbox's machine. Every other operation names a sandbox (`sandbox`: name or id; omitted
 * only when the account has exactly one) and is enqueued for the connector of the machine holding it; this call
 * waits on a Convex subscription for up to min(deadline, 50 s). A request no connector claims within 3 s is
 * abandoned and reported `machine_offline`; one still running when the wait ends comes back as a continuation the
 * client resumes with `{continue: request_id}`.
 */
export async function handleOps(principal: Principal, input: Record<string, unknown>, deps: OpsDeps): Promise<OpsResponse> {
  if (typeof input.continue === "string") return await waitFor(principal, input.continue, Number(input.deadline_at ?? 0), deps);
  const operation = String(input.operation ?? "");
  const payload = (input.input ?? {}) as Record<string, Json>;
  const account = ACCOUNT_OPERATIONS[operation];
  if (account) {
    const args = operation === "machine.rename" || operation === "machine.remove" ? (({ machine_id: machineId, ...rest }) => ({ ...rest, machineId }))(payload) : payload;
    const result = await deps.accountCall(principal, account[0], account[1], args);
    return { status: 200, body: operation === "sandbox.list" ? { sandboxes: result } : result };
  }
  const entry = catalogById.get(operation as OperationId);
  if (!entry) return { status: 400, body: { error: `unsupported operation: ${operation}` } };
  const base = requestFromInvocation({ operation: entry.id, request_id: typeof input.request_id === "string" ? input.request_id : `req_${crypto.randomUUID()}`, deadline_ms: typeof input.deadline_ms === "number" ? input.deadline_ms : undefined, mutation_id: typeof input.mutation_id === "string" ? input.mutation_id : null, input: payload });
  try {
    validateJson(payload, entry.input_schema);
    if (entry.id === "sandbox.create") return await createSandbox(principal, base, typeof input.caller_machine_id === "string" ? input.caller_machine_id : undefined, deps);
    const target = await resolveSandbox(principal, typeof input.sandbox === "string" ? input.sandbox : undefined, deps);
    const request = { ...base, sandbox_id: target.sandbox_id };
    if (entry.id === "sandbox.rename") return await renameSandbox(principal, request, target, deps);
    if (entry.id === "sandbox.delete") return await deleteSandbox(principal, request, target, deps);
    return await relay(principal, target.machine_id, request, deps);
  } catch (error) {
    return answer(failure(base, error instanceof ContractError ? error : contractError(error)));
  }
}

/** The named sandbox (name or id) on the caller's account; omitted, the account's only sandbox. */
export async function resolveSandbox(principal: Principal, wanted: string | undefined, deps: OpsDeps): Promise<SandboxRow> {
  const rows = await deps.accountCall(principal, "query", "sandboxes:list", {}) as SandboxRow[];
  const names = rows.map((row) => row.name);
  if (wanted) {
    const row = rows.find((candidate) => candidate.sandbox_id === wanted || candidate.name === wanted);
    if (!row) throw new ContractError("sandbox_not_found", `no sandbox ${wanted} on this account; ${names.length ? `sandboxes: ${names.join(", ")}` : "it has none"}`, { names });
    return row;
  }
  if (rows.length === 1) return rows[0];
  if (!rows.length) throw new ContractError("sandbox_not_found", "this account has no sandboxes; create one with sandbox create", { names });
  throw new ContractError("sandbox_ambiguous", `this account has ${rows.length} sandboxes; name one: ${names.join(", ")}`, { names });
}

const gib = (bytes: number) => `${Math.round(bytes / GIB * 10) / 10} GiB`;

/**
 * Place the sandbox (`place`, D8), reserve its identity in Convex, then have the machine create it; a machine that
 * refuses releases the name. `callerMachineId` is the calling machine, sent by a CLI whose local daemon answers; a
 * machine can only name itself, and agents have no machine.
 */
async function createSandbox(principal: Principal, base: RequestEnvelope, callerMachineId: string | undefined, deps: OpsDeps): Promise<OpsResponse> {
  const asked = base.input as { name?: string; machine?: string; placement?: "auto" | "remote"; cpus?: number; memory_bytes?: number; sleep_after_ms?: number; delete_after_ms?: number };
  const policy = { ...(asked.sleep_after_ms ? { sleep_after_ms: asked.sleep_after_ms } : {}), ...(asked.delete_after_ms ? { delete_after_ms: asked.delete_after_ms } : {}) };
  if (callerMachineId !== undefined && callerMachineId !== principal.machineId) throw new ContractError("invalid_input", "caller_machine_id must be the calling machine's own id");
  const rows = await deps.accountCall(principal, "query", "machines:list", {}) as MachineRow[];
  // An idle connected Mac makes no Convex calls, so report age says nothing about presence. A machine counts as
  // online once it has reported capacity; the relayed create itself finds a gone machine in 3 s (machine_offline),
  // and auto/remote placement then moves on to the next candidate.
  const machines = rows.map((row) => {
    const lastReportAt = Math.max(row.lastSeenAt ?? 0, row.capacityAt ?? 0) || undefined;
    return { id: row.machineId, name: row.name, online: row.capacity !== undefined, roomBytes: row.capacity?.room_bytes ?? 0, totalBytes: row.capacity?.total_bytes ?? 0, lastReportAt };
  });
  const tried = new Set<string>();
  for (;;) {
    const placed = place({ flags: { machine: asked.machine, placement: asked.placement }, callerMachineId, machines: machines.map((machine) => tried.has(machine.id) ? { ...machine, online: false } : machine), neededBytes: asked.memory_bytes ?? SMALLEST_DEFAULT_BYTES });
    if ("error" in placed) throw new ContractError(placed.error, placed.message, { machines: placed.machines as unknown as Json }, placed.error === "machine_offline");
    const machine = rows.find((row) => row.machineId === placed.machineId)!;
    const { cpus: hostCpus, total_bytes: hostMemory } = machine.capacity ?? {};
    if ((asked.cpus === undefined || asked.memory_bytes === undefined) && (!hostCpus || !hostMemory)) throw new ContractError("machine_offline", `${machine.name} has not connected yet, so its size is unknown; start its connector or pass cpus and memory_bytes`, undefined, true);
    const fallback = hostCpus && hostMemory ? defaultSize(hostCpus, hostMemory) : undefined;
    const cpus = asked.cpus ?? fallback!.cpus; const memoryBytes = asked.memory_bytes ?? fallback!.memory_bytes;
    const sizeReason = asked.cpus !== undefined && asked.memory_bytes !== undefined ? "as requested"
      : `${asked.cpus === undefined && asked.memory_bytes === undefined ? "default" : "partly default"} for ${machine.name}: half its ${hostCpus} CPUs and a quarter of its ${gib(hostMemory!)}, at least 2 CPUs and 2 GiB`;
    const row = await deps.accountCall(principal, "mutation", "sandboxes:create", { machineId: machine.machineId, ...(asked.name ? { name: asked.name } : {}), cpus, memoryBytes, ...(policy.sleep_after_ms ? { sleepAfterMs: policy.sleep_after_ms } : {}), ...(policy.delete_after_ms ? { deleteAfterMs: policy.delete_after_ms } : {}) }) as SandboxRow;
    // Each placement attempt is a new relay row (request ids are scoped to one machine).
    const request: RequestEnvelope = { ...base, request_id: tried.size ? `${base.request_id}-${tried.size}` : base.request_id, sandbox_id: row.sandbox_id, mutation_id: base.mutation_id ?? `create-${row.sandbox_id}`, input: { name: row.name, cpus, memory_bytes: memoryBytes, sleep_after_ms: row.sleep_after_ms, ...(row.delete_after_ms ? { delete_after_ms: row.delete_after_ms } : {}) } };
    const relayed = await relay(principal, machine.machineId, request, deps);
    const response = (relayed.body as { response?: ResponseEnvelope }).response;
    // A pending create keeps its reservation: the machine took the request and its answer arrives by continuation.
    if (!response) return relayed;
    if (!response.ok) {
      await deps.accountCall(principal, "mutation", "sandboxes:remove", { sandboxId: row.sandbox_id });
      if (response.error.code === "machine_offline" && asked.placement && !asked.machine) { tried.add(machine.machineId); continue; }
      return answer({ ...response, request_id: base.request_id, sandbox_id: null });
    }
    const machineReport = response.result as unknown as ActionReport;
    const report: ActionReport = {
      requested: asked as Json,
      produced: { sandbox_id: row.sandbox_id, name: row.name, machine: machine.name, placement_reason: placed.reason, cpus, memory_bytes: memoryBytes, size_reason: sizeReason, sleep_after_ms: row.sleep_after_ms, delete_after_ms: row.delete_after_ms },
      actions: machineReport.actions ?? [],
    };
    return answer(success({ ...base, sandbox_id: row.sandbox_id }, report as unknown as Json));
  }
}

/** Rename in the catalog, then tell the machine; an offline machine takes the name from its mirror when it reconnects. */
async function renameSandbox(principal: Principal, request: RequestEnvelope, target: SandboxRow, deps: OpsDeps): Promise<OpsResponse> {
  const renamed = await deps.accountCall(principal, "mutation", "sandboxes:rename", { sandboxId: target.sandbox_id, name: (request.input as { name: string }).name }) as { name: string; previous_name: string };
  const told = await relayedResponse(principal, target.machine_id, request, deps);
  const machine = target.machine_name ?? target.machine_id;
  const detail = `renamed ${renamed.previous_name} to ${renamed.name}${told?.ok ? ` on ${machine}` : `; ${machine} did not answer (${told ? told.error.code : "still pending"}) and takes the name when it reconnects`}`;
  const report: ActionReport = { requested: request.input, produced: { sandbox_id: target.sandbox_id, name: renamed.name, previous_name: renamed.previous_name, machine }, actions: [{ kind: "renamed", detail }] };
  return answer(success(request, report as unknown as Json));
}

/** The machine drops the sandbox first (and reports what it removed), then the catalog row goes. */
async function deleteSandbox(principal: Principal, request: RequestEnvelope, target: SandboxRow, deps: OpsDeps): Promise<OpsResponse> {
  const confirm = (request.input as { confirm?: string }).confirm;
  if (confirm !== undefined && confirm !== target.name) throw new ContractError("invalid_input", `confirm must be the sandbox's name, ${target.name}`);
  const told = await relayedResponse(principal, target.machine_id, request, deps);
  if (told && !told.ok && !["machine_offline", "sandbox_not_found"].includes(told.error.code)) return answer(told);
  await deps.accountCall(principal, "mutation", "sandboxes:remove", { sandboxId: target.sandbox_id });
  const machine = target.machine_name ?? target.machine_id;
  const fromMachine = told?.ok ? ((told.result as unknown as ActionReport).produced as { removed?: Json[] }).removed ?? [] : [];
  const removed = ["account catalog entry", ...fromMachine.map((item) => `${item} on ${machine}`)];
  const detail = `deleted ${target.name}: removed ${removed.join(", ")}${told?.ok ? "" : `; ${machine} did not answer and drops it when it reconnects`}`;
  const report: ActionReport = { requested: request.input, produced: { sandbox_id: target.sandbox_id, name: target.name, machine, removed }, actions: [{ kind: "deleted", detail }] };
  return answer(success(request, report as unknown as Json));
}

/** The machine's answer, or undefined when it is still running past this call's wait. */
async function relayedResponse(principal: Principal, machineId: string, request: RequestEnvelope, deps: OpsDeps): Promise<ResponseEnvelope | undefined> {
  const mutationId = request.mutation_id ?? `${request.operation}-${request.request_id}`;
  return ((await relay(principal, machineId, { ...request, mutation_id: mutationId }, deps)).body as { response?: ResponseEnvelope }).response;
}

async function relay(principal: Principal, machineId: string, request: RequestEnvelope, deps: OpsDeps): Promise<OpsResponse> {
  let queued: { requestId: string };
  try {
    queued = await deps.serviceMutation("relay:enqueue", { accountId: principal.accountId, machineId, ...(request.sandbox_id ? { sandboxId: request.sandbox_id } : {}), requestId: request.request_id, operation: request.operation, ...(request.mutation_id ? { mutationId: request.mutation_id } : {}), payload: request });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const limit = message.match(/relay_daily_limit:\s*(.*)/);
    if (limit) return answer(failure(request, { code: "rate_limited", message: limit[1].trim(), retryable: true }));
    throw error;
  }
  return await waitFor(principal, queued.requestId, Date.now() + request.deadline_ms, deps, request);
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
    return answer(failure(envelope, { code: "machine_offline", message: `the machine did not pick up the request within ${claimWindowMs / 1000} s${seen}`, retryable: true }));
  }
  if (deadlineAt && Date.now() >= deadlineAt) return answer(failure(envelope, { code: "operation_uncertain", message: `the machine took the request but did not answer before the deadline; replay with the same mutation id to get its result`, retryable: true }));
  return { status: 202, body: { status: "pending", request_id: requestId, deadline_at: deadlineAt } };
}
