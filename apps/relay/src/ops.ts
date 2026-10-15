import { ConvexError } from "convex/values";
import {
  catalogById, ContractError, DEFAULT_SIZE_MINIMUM, ERROR_CODES, defaultSize, defaultSizeReason, failure, requestFromInvocation, success, validateJson,
  type ActionReport, type CapacityReport, type ErrorBody, type ErrorCode, type Json, type OperationId, type RequestEnvelope, type ResponseEnvelope,
} from "../../../packages/contract/src/index.js";
import { byNameOrId, place } from "../../../packages/placement/src/index.js";

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
/** `sandboxes:byCreateMutation`: the sandbox a create with this mutation id reserved, and the input it relayed (null once the relay row expired). */
interface ReservedCreate extends SandboxRow { create_input: Record<string, Json> | null }

/**
 * A create refused this way never made the sandbox, so its reservation is released. Anything else (a deadline that
 * passed, a lost answer, a daily result limit) may still complete on the machine, so the reservation stays.
 */
const DEFINITIVE_CREATE_FAILURES: ErrorCode[] = ["machine_offline", "machine_not_found", "machine_full", "invalid_input", "name_conflict", "sandbox_not_ready"];

/** Operations that only read or change the account catalog; they are never relayed to a machine. */
const ACCOUNT_OPERATIONS: Record<string, ["mutation" | "query", string]> = {
  "account.status": ["query", "accounts:status"], "account.rename": ["mutation", "accounts:rename"],
  "machine.list": ["query", "machines:list"], "machine.rename": ["mutation", "machines:rename"], "machine.remove": ["mutation", "machines:remove"],
  "sandbox.list": ["query", "sandboxes:list"],
};

/**
 * A Convex function's refusal (`refuse`: a `ConvexError` carrying an error body without `retryable`) as the contract
 * error it is; anything else is not the caller's to see. A rate limit lifts by itself, so it is retryable.
 */
export function contractError(error: unknown): ContractError {
  if (error instanceof ContractError) return error;
  if (error instanceof ConvexError && (ERROR_CODES as readonly string[]).includes(error.data?.code)) { const { code, message, details } = error.data as Omit<ErrorBody, "retryable">; return new ContractError(code, message, details, code === "rate_limited"); }
  // Convex's own limits (TooManyWrites, OCC retries exhausted) are transient platform errors, not the caller's input.
  if (error instanceof ConvexError) return new ContractError("internal", typeof error.data?.message === "string" ? error.data.message : String(error.message), undefined, true);
  throw error;
}
const answer = (response: ResponseEnvelope): OpsResponse => ({ status: 200, body: { response } });

/**
 * `POST /api/v1/ops`, for the HTTP route and MCP alike. Every answer is `{response: envelope}`, except a caller whose
 * credential Convex refuses (a removed machine, a revoked agent: 401) and other failures before an envelope exists (400).
 */
export async function runOps(principal: Principal, input: Record<string, unknown>, deps: OpsDeps): Promise<OpsResponse> {
  try { return await handleOps(principal, input, deps); }
  catch (error) {
    const message = error instanceof Error ? error.message : "operation failed";
    if (!/revoked|Forbidden/i.test(message)) return { status: 400, body: { error: message } };
    return { status: 401, body: { error: principal.machineId ? "this machine was removed; run localbox login" : "this agent's sign-in was revoked; sign in again" } };
  }
}

/**
 * A request names what it is for with two selectors beside the operation: `sandbox` and `machine`, each a name or id.
 * Account operations run against the catalog. `sandbox.create` places on the named machine, and `.rename` and
 * `.delete` change the catalog and tell the sandbox's machine. Machine-level host operations (relay status, agent
 * setup) go to one machine (`resolveMachine`). Every other operation acts on a sandbox (`sandbox`; omitted only when
 * the account has exactly one) and is enqueued for the connector of the machine holding it; this call waits on a
 * Convex subscription for up to min(deadline, 50 s). A request no connector claims within 3 s is abandoned and
 * reported `machine_offline`; one still running when the wait ends comes back as a continuation the client resumes with `{continue: request_id}`.
 */
async function handleOps(principal: Principal, input: Record<string, unknown>, deps: OpsDeps): Promise<OpsResponse> {
  if (typeof input.continue === "string") return await waitFor(principal, input.continue, Number(input.deadline_at ?? 0), deps);
  const operation = String(input.operation ?? "");
  const payload = (input.input ?? {}) as Record<string, Json>;
  const entry = catalogById.get(operation as OperationId);
  const base = requestFromInvocation({ operation, request_id: typeof input.request_id === "string" ? input.request_id : `req_${crypto.randomUUID()}`, deadline_ms: typeof input.deadline_ms === "number" ? input.deadline_ms : undefined, mutation_id: typeof input.mutation_id === "string" ? input.mutation_id : null, input: payload });
  const sandbox = typeof input.sandbox === "string" ? input.sandbox : undefined;
  const machine = typeof input.machine === "string" ? input.machine : undefined;
  try {
    if (!entry) throw new ContractError("invalid_input", `unsupported operation: ${operation}`);
    validateJson(payload, entry.input_schema);
    if (ACCOUNT_OPERATIONS[entry.id]) return answer(success(base, await accountOperation(principal, entry.id, payload, deps)));
    if (entry.id === "sandbox.create") return await createSandbox(principal, base, machine, typeof input.caller_machine_id === "string" ? input.caller_machine_id : undefined, deps);
    if (!entry.sandbox_scoped) return await relay(principal, await resolveMachine(principal, sandbox, machine, deps), base, deps);
    const target = await resolveSandbox(principal, sandbox, deps).catch((error) => {
      // A delete of a sandbox that is already gone has nothing left to do.
      if (entry.id === "sandbox.delete" && sandbox && error instanceof ContractError && error.code === "sandbox_not_found") return undefined;
      throw error;
    });
    if (!target) return answer(success(base, alreadyDeleted(payload, sandbox!) as unknown as Json));
    await requireSameMachine(principal, target, machine, deps);
    const request = { ...base, sandbox_id: target.sandbox_id };
    if (entry.id === "sandbox.rename") return await renameSandbox(principal, request, target, deps);
    if (entry.id === "sandbox.delete") return await deleteSandbox(principal, request, target, deps);
    return await relay(principal, target.machine_id, request, deps);
  } catch (error) {
    return answer(failure(base, contractError(error)));
  }
}

/** An account operation's value; `machine_id` (a machine's name or id) resolves first. */
async function accountOperation(principal: Principal, operation: string, payload: Record<string, Json>, deps: OpsDeps): Promise<Json> {
  const [kind, name] = ACCOUNT_OPERATIONS[operation];
  if (operation === "machine.rename" || operation === "machine.remove") {
    const { machine_id: machine, ...rest } = payload;
    return await deps.accountCall(principal, kind, name, { ...rest, machineId: (await findMachine(principal, machine as string, deps)).machineId });
  }
  const result = await deps.accountCall(principal, kind, name, payload);
  return operation === "sandbox.list" ? { sandboxes: result } : result;
}

/** The named sandbox (name or id) on the caller's account; omitted, the account's only sandbox. */
async function resolveSandbox(principal: Principal, wanted: string | undefined, deps: OpsDeps): Promise<SandboxRow> {
  const rows = await deps.accountCall(principal, "query", "sandboxes:list", {}) as SandboxRow[];
  const names = rows.map((row) => row.name);
  if (wanted) {
    const row = byNameOrId(rows, wanted, (candidate) => candidate.sandbox_id);
    if (!row) throw new ContractError("sandbox_not_found", `no sandbox ${wanted} on this account; ${names.length ? `sandboxes: ${names.join(", ")}` : "it has none"}`, { names });
    return row;
  }
  if (rows.length === 1) return rows[0];
  if (!rows.length) throw new ContractError("sandbox_not_found", "this account has no sandboxes; create one with sandbox create", { names });
  throw new ContractError("sandbox_ambiguous", `this account has ${rows.length} sandboxes; name one: ${names.join(", ")}`, { names });
}

/** The machine `wanted` (name or id) names on the caller's account. */
async function findMachine(principal: Principal, wanted: string, deps: OpsDeps): Promise<MachineRow> {
  const rows = await deps.accountCall(principal, "query", "machines:list", {}) as MachineRow[];
  const row = byNameOrId(rows, wanted, (candidate) => candidate.machineId);
  if (row) return row;
  const names = rows.map((candidate) => candidate.name);
  throw new ContractError("machine_not_found", `no machine ${wanted} on this account; ${names.length ? `machines: ${names.join(", ")}` : "it has none"}`, { names });
}

/** A request naming both a sandbox and a machine must mean the same machine; otherwise the caller meant something else. */
async function requireSameMachine(principal: Principal, target: SandboxRow, machine: string | undefined, deps: OpsDeps): Promise<void> {
  if (machine && (await findMachine(principal, machine, deps)).machineId !== target.machine_id) throw new ContractError("invalid_input", `${target.name} is on ${target.machine_name ?? target.machine_id}, not ${machine}; name one or the other`);
}

/** The machine a machine-level operation runs on: the named sandbox's, else the named machine, else the calling machine, else the account's only machine. */
async function resolveMachine(principal: Principal, sandbox: string | undefined, machine: string | undefined, deps: OpsDeps): Promise<string> {
  if (sandbox) { const target = await resolveSandbox(principal, sandbox, deps); await requireSameMachine(principal, target, machine, deps); return target.machine_id; }
  if (machine) return (await findMachine(principal, machine, deps)).machineId;
  if (principal.machineId) return principal.machineId;
  const rows = await deps.accountCall(principal, "query", "machines:list", {}) as MachineRow[];
  const names = rows.map((row) => row.name);
  if (rows.length === 1) return rows[0].machineId;
  if (!rows.length) throw new ContractError("machine_not_found", "this account has no machines; sign a Mac in with localbox login", { names });
  throw new ContractError("invalid_input", `this account has ${rows.length} machines; name one with machine: ${names.join(", ")}`, { names });
}

/**
 * Place the sandbox (`place`: on `named`, the machine the request names, else by placement), reserve its identity in
 * Convex, then have the machine create it; a machine that refuses releases the name. `callerMachineId` is the calling
 * machine, sent by a CLI whose local daemon answers; a machine can only name itself, and agents have no machine. A replay (the same mutation id) relays the first create
 * again, so the relay's and the machine's dedupe answer with its result instead of making a second sandbox.
 */
async function createSandbox(principal: Principal, base: RequestEnvelope, named: string | undefined, callerMachineId: string | undefined, deps: OpsDeps): Promise<OpsResponse> {
  const asked = base.input as { name?: string; placement?: "auto" | "remote"; cpus?: number; memory_bytes?: number; sleep_after_ms?: number; delete_after_ms?: number };
  const policy = { ...(asked.sleep_after_ms ? { sleep_after_ms: asked.sleep_after_ms } : {}), ...(asked.delete_after_ms ? { delete_after_ms: asked.delete_after_ms } : {}) };
  if (callerMachineId !== undefined && callerMachineId !== principal.machineId) throw new ContractError("invalid_input", "caller_machine_id must be the calling machine's own id");
  if (base.mutation_id) {
    const reserved = await deps.accountCall(principal, "query", "sandboxes:byCreateMutation", { mutationId: base.mutation_id }) as ReservedCreate | null;
    if (reserved) {
      const input = reserved.create_input ?? { name: reserved.name, cpus: reserved.cpus, memory_bytes: reserved.memory_bytes, sleep_after_ms: reserved.sleep_after_ms, ...(reserved.delete_after_ms ? { delete_after_ms: reserved.delete_after_ms } : {}) };
      const machineName = reserved.machine_name ?? reserved.machine_id;
      const relayed = await relay(principal, reserved.machine_id, { ...base, sandbox_id: reserved.sandbox_id, input }, deps);
      // A replay never releases: the first create owns the reservation.
      return await created(base, asked, reserved, relayed, { machine: machineName, placement_reason: `on ${machineName}, where the first create with this mutation id placed it`, cpus: input.cpus as number, memory_bytes: input.memory_bytes as number, size_reason: "as the first create sized it" });
    }
  }
  const rows = await deps.accountCall(principal, "query", "machines:list", {}) as MachineRow[];
  // An idle connected Mac makes no Convex calls, so report age says nothing about presence. Placement takes any
  // machine that has reported capacity; the relayed create itself finds a gone machine in 3 s (machine_offline), and
  // auto/remote placement then tries the next candidate, counting the one it tried as not reported.
  const machines = rows.map((row) => {
    const lastReportAt = Math.max(row.lastSeenAt ?? 0, row.capacityAt ?? 0) || undefined;
    return { id: row.machineId, name: row.name, reported: row.capacity !== undefined, roomBytes: row.capacity?.room_bytes ?? 0, totalBytes: row.capacity?.total_bytes ?? 0, lastReportAt };
  });
  const tried = new Set<string>();
  for (;;) {
    const placed = place({ machine: named, placement: asked.placement, callerMachineId, machines: machines.map((machine) => tried.has(machine.id) ? { ...machine, reported: false } : machine), neededBytes: asked.memory_bytes ?? DEFAULT_SIZE_MINIMUM.memory_bytes });
    if ("error" in placed) throw new ContractError(placed.error, placed.message, { machines: placed.machines as unknown as Json }, placed.error === "machine_offline");
    const machine = rows.find((row) => row.machineId === placed.machineId)!;
    const { cpus: hostCpus, total_bytes: hostMemory } = machine.capacity ?? {};
    if ((asked.cpus === undefined || asked.memory_bytes === undefined) && (!hostCpus || !hostMemory)) throw new ContractError("machine_offline", `${machine.name} has not connected yet, so its size is unknown; start its connector or pass cpus and memory_bytes`, undefined, true);
    const fallback = hostCpus && hostMemory ? defaultSize(hostCpus, hostMemory) : undefined;
    const cpus = asked.cpus ?? fallback!.cpus; const memoryBytes = asked.memory_bytes ?? fallback!.memory_bytes;
    const sizeReason = asked.cpus !== undefined && asked.memory_bytes !== undefined ? "as requested"
      : `${asked.cpus === undefined && asked.memory_bytes === undefined ? "default" : "partly default"} for ${machine.name}: ${defaultSizeReason(hostCpus!, hostMemory!)}`;
    const row = await deps.accountCall(principal, "mutation", "sandboxes:create", { machineId: machine.machineId, ...(asked.name ? { name: asked.name } : {}), cpus, memoryBytes, ...(policy.sleep_after_ms ? { sleepAfterMs: policy.sleep_after_ms } : {}), ...(policy.delete_after_ms ? { deleteAfterMs: policy.delete_after_ms } : {}), ...(base.mutation_id ? { createMutationId: base.mutation_id } : {}) }) as SandboxRow;
    // Each placement attempt is a new relay row (request ids are scoped to one machine).
    const request: RequestEnvelope = { ...base, request_id: tried.size ? `${base.request_id}-${tried.size}` : base.request_id, sandbox_id: row.sandbox_id, mutation_id: base.mutation_id ?? `create-${row.sandbox_id}`, input: { name: row.name, cpus, memory_bytes: memoryBytes, sleep_after_ms: row.sleep_after_ms, ...(row.delete_after_ms ? { delete_after_ms: row.delete_after_ms } : {}) } };
    const relayed = await relay(principal, machine.machineId, request, deps);
    const response = (relayed.body as { response?: ResponseEnvelope }).response;
    if (response && !response.ok && response.error.code === "machine_offline" && asked.placement) {
      await deps.accountCall(principal, "mutation", "sandboxes:remove", { sandboxId: row.sandbox_id }); tried.add(machine.machineId); continue;
    }
    const release = () => deps.accountCall(principal, "mutation", "sandboxes:remove", { sandboxId: row.sandbox_id });
    return await created(base, asked, row, relayed, { machine: machine.name, placement_reason: placed.reason, cpus, memory_bytes: memoryBytes, size_reason: sizeReason }, release);
  }
}

/** A failed create that certainly made nothing: refused by the machine, never claimed, or never queued. */
const definitive = (response: ResponseEnvelope & { ok: false }) => DEFINITIVE_CREATE_FAILURES.includes(response.error.code)
  || (response.error.code === "rate_limited" && (response.error.details as { limit?: string } | undefined)?.limit === "requests");

/**
 * The create's answer as an action report. A pending create keeps its reservation (its answer arrives by
 * continuation); a definitive failure releases it (`release`, when this call made it); any other failure keeps it
 * and says the create may still complete.
 */
async function created(base: RequestEnvelope, asked: Record<string, unknown>, row: SandboxRow, relayed: OpsResponse, facts: { machine: string; placement_reason: string; cpus: number; memory_bytes: number; size_reason: string }, release?: () => Promise<unknown>): Promise<OpsResponse> {
  const response = (relayed.body as { response?: ResponseEnvelope }).response;
  if (!response) return relayed;
  if (!response.ok) {
    if (definitive(response)) {
      await release?.();
      return answer({ ...response, request_id: base.request_id, sandbox_id: null });
    }
    const replay = base.mutation_id ? `replay with mutation id ${base.mutation_id}` : "check sandbox list";
    return answer({ ...response, request_id: base.request_id, sandbox_id: row.sandbox_id, error: { ...response.error, message: `${response.error.message}; the create may still complete on ${facts.machine}: ${row.name} stays reserved (${replay} to get its result)` } });
  }
  const machineReport = response.result as unknown as ActionReport;
  const report: ActionReport = {
    requested: asked as Json,
    produced: { sandbox_id: row.sandbox_id, name: row.name, machine: facts.machine, placement_reason: facts.placement_reason, cpus: facts.cpus, memory_bytes: facts.memory_bytes, size_reason: facts.size_reason, sleep_after_ms: row.sleep_after_ms, delete_after_ms: row.delete_after_ms },
    actions: machineReport.actions ?? [],
  };
  return answer(success({ ...base, sandbox_id: row.sandbox_id }, report as unknown as Json));
}

/** Rename in the catalog, then tell the machine; an offline machine takes the name from its mirror when it reconnects. */
async function renameSandbox(principal: Principal, request: RequestEnvelope, target: SandboxRow, deps: OpsDeps): Promise<OpsResponse> {
  const renamed = await deps.accountCall(principal, "mutation", "sandboxes:rename", { sandboxId: target.sandbox_id, name: (request.input as { name: string }).name }) as { name: string; previous_name: string };
  const told = await relayedResponse(principal, target.machine_id, request, deps);
  const machine = target.machine_name ?? target.machine_id;
  const detail = `renamed ${renamed.previous_name} to ${renamed.name}${told?.ok ? ` on ${machine}` : told?.error.code === "machine_not_found" ? `; ${machine} is gone from the account, so only the catalog changed` : `; ${machine} did not answer (${told ? told.error.code : "still pending"}) and takes the name when it reconnects`}`;
  const report: ActionReport = { requested: request.input, produced: { sandbox_id: target.sandbox_id, name: renamed.name, previous_name: renamed.previous_name, machine }, actions: [{ kind: "renamed", detail }] };
  return answer(success(request, report as unknown as Json));
}

/** A delete of a sandbox the account no longer has: nothing is left to remove. */
function alreadyDeleted(requested: Json, wanted: string): ActionReport {
  return { requested, produced: { sandbox: wanted, removed: [] }, actions: [{ kind: "left_alone", detail: `${wanted} is already deleted: this account has no sandbox by that name or id` }] };
}

/**
 * The machine drops the sandbox first (and reports what it removed), then the catalog row goes. An offline machine
 * deletes it when its catalog mirror next arrives without it; a machine gone from the account leaves only the row.
 */
async function deleteSandbox(principal: Principal, request: RequestEnvelope, target: SandboxRow, deps: OpsDeps): Promise<OpsResponse> {
  const confirm = (request.input as { confirm?: string }).confirm;
  if (confirm !== undefined && confirm !== target.name) throw new ContractError("invalid_input", `confirm must be the sandbox's name, ${target.name}`);
  const told = await relayedResponse(principal, target.machine_id, request, deps);
  if (told && !told.ok && !["machine_offline", "sandbox_not_found", "machine_not_found"].includes(told.error.code)) return answer(told);
  await deps.accountCall(principal, "mutation", "sandboxes:remove", { sandboxId: target.sandbox_id });
  const machine = target.machine_name ?? target.machine_id;
  const fromMachine = told?.ok ? ((told.result as unknown as ActionReport).produced as { removed?: Json[] }).removed ?? [] : [];
  const removed = ["account catalog entry", ...fromMachine.map((item) => `${item} on ${machine}`)];
  const detail = `deleted ${target.name}: removed ${removed.join(", ")}${told?.ok ? "" : told?.error.code === "machine_not_found" ? `; ${machine} is gone from the account, so there is nothing to remove on it` : `; ${machine} did not answer and deletes it when it reconnects`}`;
  const report: ActionReport = { requested: request.input, produced: { sandbox_id: target.sandbox_id, name: target.name, machine, removed }, actions: [{ kind: "deleted", detail }] };
  return answer(success(request, report as unknown as Json));
}

/** The machine's answer (`machine_not_found` when the machine was removed), or undefined while it is still running past this call's wait. */
async function relayedResponse(principal: Principal, machineId: string, request: RequestEnvelope, deps: OpsDeps): Promise<ResponseEnvelope | undefined> {
  const mutationId = request.mutation_id ?? `${request.operation}-${request.request_id}`;
  return ((await relay(principal, machineId, { ...request, mutation_id: mutationId }, deps)).body as { response?: ResponseEnvelope }).response;
}

/** Enqueues `request` for `machineId` and waits for its answer; a refused enqueue (machine removed, daily limit) answers as a failure. */
async function relay(principal: Principal, machineId: string, request: RequestEnvelope, deps: OpsDeps): Promise<OpsResponse> {
  let queued: { requestId: string };
  try {
    queued = await deps.serviceMutation("relay:enqueue", { accountId: principal.accountId, machineId, ...(request.sandbox_id ? { sandboxId: request.sandbox_id } : {}), requestId: request.request_id, operation: request.operation, ...(request.mutation_id ? { mutationId: request.mutation_id } : {}), payload: request });
  } catch (error) { return answer(failure(request, contractError(error))); }
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
