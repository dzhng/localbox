import { ConvexError } from "convex/values";
import {
  BUILT_IN_IMAGE, catalogById, ContractError, DEFAULT_SIZE_MINIMUM, ERROR_CODES, defaultSize, defaultSizeReason, failure, gibibytes, requestFromInvocation, sizeText, success, validateInput, validateRequest,
  type ActionReport, type CapacityReport, type ErrorBody, type ErrorCode, type ImageOperationState, type Json, type OperationId, type RequestEnvelope, type ResponseEnvelope,
} from "../../../packages/contract/src/index.js";
import { byNameOrId, place, type PlacementImage, type PlacementMachine } from "../../../packages/placement/src/index.js";

/** The caller: one of the account's machines (machine credential) or a signed-in agent (OAuth token family). */
export interface Principal { accountId: string; machineId?: string; familyId?: string }

export interface RelayResult { accountId?: string; status: "queued" | "claimed" | "completed" | "abandoned"; response?: ResponseEnvelope }

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

/** A row of `machines:list`: the machine's last capacity report and when it last reached the relay. */
interface MachineRow { machineId: string; name: string; lastSeenAt?: number; capacity?: CapacityReport; capacityAt?: number }

/** A row of `images:list` / `images:get`. */
export interface ImageRow {
  image_id: string; name: string; os: "linux" | "macos"; size_bytes: number | null; min_macos: string | null; source: { kind: "sandbox" | "ipsw" | "release"; sandboxName?: string; ipswVersion?: string };
  default: boolean; created_at: number | null;
  holders: Array<{ machine_id: string; machine_name: string | null; state: "building" | "copying" | "ready" | "failed"; operation_id: string | null; error: { code: string; message: string; next_step: string } | null; updated_at: number | null }>;
}
/** A host operation record as the daemon answers `image.wait` with it. */
interface HostOperationView {
  key: string; kind: string; subject: string; state: "running" | "succeeded" | "failed";
  progress?: { phase: string; completed?: number; total?: number }; result?: Json; error?: { code: string; message: string; next_step?: string };
}

/** A row of `images:copyByOperation` / `images:startCopy`: one copy, without its key. */
interface CopyRow {
  copy_id: string; image_id: string; operation_id: string; state: "waiting" | "copying" | "copied" | "failed";
  from_machine_id: string; from_machine_name: string | null; to_machine_id: string; to_machine_name: string | null;
  result: { bytes: number; duration_ms: number; path: "local_network" | "internet" } | null; error: { code: string; message: string; next_step: string } | null;
}

/**
 * A row of `sandboxes:list`. A sandbox made on a Mac without its image is `copying` (`copy_operation_id` names the copy)
 * until that Mac reports it created, or `failed` with `error` (why, and what to try next).
 */
export interface SandboxRow { sandbox_id: string; name: string; machine_id: string; machine_name: string | null; image_id: string; cpus: number; memory_bytes: number; sleep_after_ms: number; delete_after_ms: number | null; state: string; copy_operation_id?: string | null; error?: { code: string; message: string; next_step: string } | null }
/** `sandboxes:byCreateMutation`: the sandbox a create with this mutation id reserved, and the input it relayed (null once the relay row expired). */
interface ReservedCreate extends SandboxRow { create_input: Record<string, Json> | null }

/**
 * A create refused this way never made the sandbox, so its reservation is released. Anything else (a deadline that
 * passed, a lost answer, a daily result limit) may still complete on the machine, so the reservation stays.
 */
const DEFINITIVE_CREATE_FAILURES: ErrorCode[] = ["machine_offline", "machine_not_found", "machine_full", "invalid_input", "name_conflict", "sandbox_not_ready", "image_not_found"];
/** The same for `image create --from`: the machine refused before journaling the capture, or never got it. */
const DEFINITIVE_CAPTURE_FAILURES: ErrorCode[] = ["machine_offline", "machine_not_found", "sandbox_not_found", "invalid_input", "unsupported"];
/** The same for one side of `image copy`: that Mac never journaled its side, so the copy can't go on. */
const DEFINITIVE_COPY_FAILURES: ErrorCode[] = ["machine_offline", "machine_not_found", "invalid_input", "unsupported", "image_not_found"];

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
/** Convex refused the caller's own credential (`unauthorized`: a removed machine, a revoked agent). */
export const callerRefused = (error: unknown): boolean => error instanceof ConvexError && error.data?.code === "unauthorized";
const answer = (response: ResponseEnvelope): OpsResponse => ({ status: 200, body: { response } });

/**
 * `POST /api/v1/ops`, for the HTTP route and MCP alike. Every answer is `{response: envelope}`, except a caller whose
 * credential Convex refuses (a removed machine, a revoked agent: 401) and other failures before an envelope exists (400).
 */
export async function runOps(principal: Principal, input: Record<string, unknown>, deps: OpsDeps): Promise<OpsResponse> {
  try { return await handleOps(principal, input, deps); }
  catch (error) {
    if (callerRefused(error)) return { status: 401, body: { error: principal.machineId ? "this machine was removed; run localbox login" : "this agent's sign-in was revoked; sign in again" } };
    return { status: 400, body: { error: error instanceof ConvexError && typeof error.data?.message === "string" ? error.data.message : error instanceof Error ? error.message : "operation failed" } };
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
  if (typeof input.continue === "string") return await imageWaitAnswer(principal, await waitFor(principal, input.continue, Number(input.deadline_at ?? 0), deps), deps);
  const operation = String(input.operation ?? "");
  const payload = (input.input ?? {}) as Record<string, Json>;
  const entry = catalogById.get(operation as OperationId);
  const base = requestFromInvocation({ operation, request_id: typeof input.request_id === "string" ? input.request_id : `req_${crypto.randomUUID()}`, deadline_ms: typeof input.deadline_ms === "number" ? input.deadline_ms : undefined, mutation_id: typeof input.mutation_id === "string" ? input.mutation_id : null, input: payload });
  const sandbox = typeof input.sandbox === "string" ? input.sandbox : undefined;
  const machine = typeof input.machine === "string" ? input.machine : undefined;
  try {
    if (!entry) throw new ContractError("invalid_input", `unsupported operation: ${operation}`);
    validateInput(entry.id, payload);
    if (ACCOUNT_OPERATIONS[entry.id]) return answer(success(base, await accountOperation(principal, entry.id, payload, deps)));
    if (entry.id === "sandbox.create") return await createSandbox(principal, base, machine, typeof input.caller_machine_id === "string" ? input.caller_machine_id : undefined, deps);
    if (entry.id === "image.create") return await createImage(principal, base, machine, deps);
    if (entry.id === "image.wait") return await waitForImage(principal, base, deps);
    if (entry.id === "image.copy") return await copyImage(principal, base, deps);
    if (entry.id === "image.list") return answer(success(base, { images: (await deps.accountCall(principal, "query", "images:list", {}) as ImageRow[]).map(imageListRow) } as unknown as Json));
    if (entry.id === "image.rename") return answer(success(base, await renameImage(principal, base, deps) as unknown as Json));
    if (entry.id === "image.default") return answer(success(base, await defaultImage(principal, base, deps) as unknown as Json));
    if (entry.id === "image.delete") return await deleteImage(principal, base, machine, deps);
    if (!entry.sandbox_scoped) return await relay(principal, await resolveMachine(principal, sandbox, machine, deps), base, deps);
    const target = await resolveSandbox(principal, sandbox, deps).catch((error) => {
      // A delete of a sandbox that is already gone has nothing left to do.
      if (entry.id === "sandbox.delete" && sandbox && error instanceof ContractError && error.code === "sandbox_not_found") return undefined;
      throw error;
    });
    if (!target) return answer(success(base, alreadyDeleted(payload, sandbox!) as unknown as Json));
    await requireSameMachine(principal, target, machine, deps);
    const request = { ...base, sandbox_id: target.sandbox_id };
    // A sandbox still waiting for its image exists only in the catalog: the relay answers for it (a failed one can go).
    if (target.state === "copying" || (target.state === "failed" && target.error && !(entry.id === "sandbox.delete"))) return await notCreatedYet(principal, request, target, deps);
    if (entry.id === "sandbox.rename") return await renameSandbox(principal, request, target, deps);
    if (entry.id === "sandbox.delete") return await deleteSandbox(principal, request, target, deps);
    return await relay(principal, target.machine_id, request, deps);
  } catch (error) {
    if (callerRefused(error)) throw error;
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
 * Resolve the image (`image`, else the account default, which is `linux` until changed), place the sandbox on a
 * machine holding it (`place`: on `named`, the machine the request names, else by placement), reserve its identity
 * and image in Convex, then have the machine create it from that image; a machine that refuses releases the name.
 * `callerMachineId` is the calling machine, sent by a CLI whose local daemon answers; a machine can only name itself,
 * and agents have no machine. A replay (the same mutation id) relays the first create again, so the relay's and the
 * machine's dedupe answer with its result instead of making a second sandbox.
 */
async function createSandbox(principal: Principal, base: RequestEnvelope, named: string | undefined, callerMachineId: string | undefined, deps: OpsDeps): Promise<OpsResponse> {
  const asked = base.input as { name?: string; image?: string; placement?: "auto" | "remote"; cpus?: number; memory_bytes?: number; sleep_after_ms?: number; delete_after_ms?: number; after_copy?: string };
  const policy = { ...(asked.sleep_after_ms ? { sleep_after_ms: asked.sleep_after_ms } : {}), ...(asked.delete_after_ms ? { delete_after_ms: asked.delete_after_ms } : {}) };
  if (callerMachineId !== undefined && callerMachineId !== principal.machineId) throw new ContractError("invalid_input", "caller_machine_id must be the calling machine's own id");
  if (asked.after_copy !== undefined) throw new ContractError("invalid_input", "after_copy is set by the agent API; leave it out");
  if (base.mutation_id) {
    const reserved = await deps.accountCall(principal, "query", "sandboxes:byCreateMutation", { mutationId: base.mutation_id }) as ReservedCreate | null;
    if (reserved?.copy_operation_id) return await replayAfterCopy(principal, base, asked, reserved, deps);
    if (reserved) {
      const input = reserved.create_input ?? { name: reserved.name, image: reserved.image_id, cpus: reserved.cpus, memory_bytes: reserved.memory_bytes, sleep_after_ms: reserved.sleep_after_ms, ...(reserved.delete_after_ms ? { delete_after_ms: reserved.delete_after_ms } : {}) };
      const machineName = reserved.machine_name ?? reserved.machine_id;
      const relayed = await relay(principal, reserved.machine_id, { ...base, sandbox_id: reserved.sandbox_id, input }, deps);
      // A replay never releases: the first create owns the reservation.
      const image = await deps.accountCall(principal, "query", "images:get", { image: reserved.image_id }).then((row: ImageRow) => row.name, () => reserved.image_id);
      return await created(base, asked, reserved, relayed, { image, image_reason: "as the first create chose it", machine: machineName, placement_reason: `on ${machineName}, where the first create with this mutation id placed it`, cpus: input.cpus as number, memory_bytes: input.memory_bytes as number, size_reason: "as the first create sized it" });
    }
  }
  // `macos` with no IPSW-built image, or a name the account lacks, refuses here with image_not_found and what to do.
  const image = await deps.accountCall(principal, "query", "images:get", asked.image === undefined ? {} : { image: asked.image }) as ImageRow;
  const imageReason = asked.image === undefined ? "the account default" : "as asked";
  const held = readyHolders(image);
  const rows = await deps.accountCall(principal, "query", "machines:list", {}) as MachineRow[];
  // The relayed create itself finds a gone machine in 3 s (machine_offline), and auto/remote placement then tries the
  // next candidate, counting the one it tried as not reported.
  const machines = placementMachines(rows, image);
  const placing = placementImage(image);
  const tried = new Set<string>();
  for (;;) {
    const placed = place({ machine: named, placement: asked.placement, callerMachineId, machines: machines.map((machine) => tried.has(machine.id) ? { ...machine, reported: false } : machine), neededBytes: asked.memory_bytes ?? DEFAULT_SIZE_MINIMUM.memory_bytes, image: placing });
    if ("error" in placed) throw new ContractError(placed.error, placed.message, { machines: placed.machines as unknown as Json }, placed.error === "machine_offline");
    const machine = rows.find((row) => row.machineId === placed.machineId)!;
    const { cpus: hostCpus, total_bytes: hostMemory } = machine.capacity ?? {};
    if ((asked.cpus === undefined || asked.memory_bytes === undefined) && (!hostCpus || !hostMemory)) throw new ContractError("machine_offline", `${machine.name} has not connected yet, so its size is unknown; start its connector or pass cpus and memory_bytes`, undefined, true);
    const fallback = hostCpus && hostMemory ? defaultSize(hostCpus, hostMemory) : undefined;
    const cpus = asked.cpus ?? fallback!.cpus; const memoryBytes = asked.memory_bytes ?? fallback!.memory_bytes;
    const sizeReason = asked.cpus !== undefined && asked.memory_bytes !== undefined ? "as requested"
      : `${asked.cpus === undefined && asked.memory_bytes === undefined ? "default" : "partly default"} for ${machine.name}: ${defaultSizeReason(hostCpus!, hostMemory!)}`;
    const facts = { image: image.name, image_reason: imageReason, machine: machine.name, placement_reason: placed.reason, cpus, memory_bytes: memoryBytes, size_reason: sizeReason };
    // A target without the image (a named machine, the caller's own Mac, or auto with no holder that fits) copies first.
    if (placed.copy) return await createAfterCopy(principal, base, asked, policy, image, machine, placed.copy.fromMachineId, facts, deps);
    const row = await deps.accountCall(principal, "mutation", "sandboxes:create", { machineId: machine.machineId, ...(asked.name ? { name: asked.name } : {}), imageId: image.image_id, cpus, memoryBytes, ...(policy.sleep_after_ms ? { sleepAfterMs: policy.sleep_after_ms } : {}), ...(policy.delete_after_ms ? { deleteAfterMs: policy.delete_after_ms } : {}), ...(base.mutation_id ? { createMutationId: base.mutation_id } : {}) }) as SandboxRow;
    // Each placement attempt is a new relay row (request ids are scoped to one machine).
    const request: RequestEnvelope = { ...base, request_id: tried.size ? `${base.request_id}-${tried.size}` : base.request_id, sandbox_id: row.sandbox_id, mutation_id: base.mutation_id ?? `create-${row.sandbox_id}`, input: { name: row.name, image: image.image_id, cpus, memory_bytes: memoryBytes, sleep_after_ms: row.sleep_after_ms, ...(row.delete_after_ms ? { delete_after_ms: row.delete_after_ms } : {}) } };
    const relayed = await relay(principal, machine.machineId, request, deps);
    const response = (relayed.body as { response?: ResponseEnvelope }).response;
    if (response && !response.ok && response.error.code === "machine_offline" && asked.placement) {
      await deps.accountCall(principal, "mutation", "sandboxes:remove", { sandboxId: row.sandbox_id }); tried.add(machine.machineId); continue;
    }
    const release = () => deps.accountCall(principal, "mutation", "sandboxes:remove", { sandboxId: row.sandbox_id });
    return await created(base, asked, row, relayed, facts, release);
  }
}

type CreateFacts = { image: string; image_reason: string; machine: string; placement_reason: string; cpus: number; memory_bytes: number; size_reason: string };

/**
 * `sandbox create` on a Mac without the image: start the image's copy there (or join one already running), reserve the
 * sandbox `copying` with the copy's operation id, and have the Mac journal a create chained to the copy
 * (`sandbox.create_after_copy`, keyed by the create's mutation id). Answers at once: the sandbox is waiting, and
 * `image wait` follows the copy until the sandbox is created.
 */
async function createAfterCopy(principal: Principal, base: RequestEnvelope, asked: Record<string, unknown>, policy: { sleep_after_ms?: number; delete_after_ms?: number }, image: ImageRow, machine: MachineRow, fromMachineId: string, facts: CreateFacts, deps: OpsDeps): Promise<OpsResponse> {
  const createMutation = base.mutation_id ?? `create-${crypto.randomUUID()}`;
  const copy = await deps.accountCall(principal, "mutation", "images:startCopy", { image: image.image_id, fromMachineId, toMachineId: machine.machineId, createMutationId: `${createMutation}-copy`, join: true }) as CopyRow;
  let row: SandboxRow;
  try { row = await deps.accountCall(principal, "mutation", "sandboxes:create", { machineId: machine.machineId, ...(asked.name ? { name: asked.name } : {}), imageId: image.image_id, cpus: facts.cpus, memoryBytes: facts.memory_bytes, ...(policy.sleep_after_ms ? { sleepAfterMs: policy.sleep_after_ms } : {}), ...(policy.delete_after_ms ? { deleteAfterMs: policy.delete_after_ms } : {}), createMutationId: createMutation, copyOperationId: copy.operation_id }) as SandboxRow; }
  catch (error) {
    // A copy this create started, which no Mac was told of yet, would hold the target `copying` with nothing running.
    if (copy.operation_id === `${createMutation}-copy` && copy.state === "waiting") await deps.accountCall(principal, "mutation", "images:cancelCopy", { copyId: copy.copy_id, error: { code: "invalid_input", message: `the sandbox create it was for was refused: ${contractError(error).message}`, nextStep: "create the sandbox again" } });
    throw error;
  }
  const input = { name: row.name, image: image.image_id, cpus: facts.cpus, memory_bytes: facts.memory_bytes, sleep_after_ms: row.sleep_after_ms, ...(row.delete_after_ms ? { delete_after_ms: row.delete_after_ms } : {}), after_copy: copy.operation_id };
  return await startAfterCopy(principal, { ...base, sandbox_id: row.sandbox_id, mutation_id: createMutation, input }, asked, row, image, copy, facts, deps);
}

/**
 * A replayed create of a sandbox that waited for its image: the copy's sides and the chained create are told again
 * (the relay's dedupe answers each with its first answer), then the catalog says how it stands.
 */
async function replayAfterCopy(principal: Principal, base: RequestEnvelope, asked: Record<string, unknown>, reserved: ReservedCreate, deps: OpsDeps): Promise<OpsResponse> {
  const image = await deps.accountCall(principal, "query", "images:get", { image: reserved.image_id }) as ImageRow;
  const copy = await deps.accountCall(principal, "query", "images:copyByOperation", { operationId: reserved.copy_operation_id }) as CopyRow | null;
  const machine = reserved.machine_name ?? reserved.machine_id;
  const input = reserved.create_input ?? { name: reserved.name, image: reserved.image_id, cpus: reserved.cpus, memory_bytes: reserved.memory_bytes, sleep_after_ms: reserved.sleep_after_ms, ...(reserved.delete_after_ms ? { delete_after_ms: reserved.delete_after_ms } : {}), after_copy: reserved.copy_operation_id! };
  const facts: CreateFacts = { image: image.name, image_reason: "as the first create chose it", machine, placement_reason: `on ${machine}, where the first create with this mutation id placed it`, cpus: reserved.cpus, memory_bytes: reserved.memory_bytes, size_reason: "as the first create sized it" };
  if (reserved.state === "failed") return answer(failure({ ...base, sandbox_id: reserved.sandbox_id }, notCreated(reserved, image.name)));
  if (reserved.state !== "copying") {
    const report: ActionReport = { requested: asked as Json, produced: { sandbox_id: reserved.sandbox_id, name: reserved.name, image: image.name, machine, state: reserved.state }, actions: [{ kind: "created", detail: `created ${reserved.name} on ${machine} from image ${image.name}, once it was copied there` }] };
    return answer(success({ ...base, sandbox_id: reserved.sandbox_id }, report as unknown as Json));
  }
  return await startAfterCopy(principal, { ...base, sandbox_id: reserved.sandbox_id, input }, asked, reserved, image, copy, facts, deps);
}

/**
 * Tells both Macs their side of the copy, then the target its chained create, and answers that the sandbox is waiting.
 * A Mac that certainly never took its part releases the reservation; an uncertain answer keeps it for a replay.
 */
async function startAfterCopy(principal: Principal, request: RequestEnvelope, asked: Record<string, unknown>, row: SandboxRow, image: ImageRow, copy: CopyRow | null, facts: CreateFacts, deps: OpsDeps): Promise<OpsResponse> {
  const release = () => deps.accountCall(principal, "mutation", "sandboxes:remove", { sandboxId: row.sandbox_id });
  // A replay after the copy's row expired (a day) has no copy left to tell; the chained create on the Mac still answers.
  const { failed } = copy ? await startCopySides(principal, { ...request, sandbox_id: null }, image, copy, deps) : { failed: undefined };
  if (failed) {
    if (failed.definitive) { await release(); return answer({ ...failed.response, sandbox_id: null, error: { ...failed.response.error, message: `${failed.response.error.message}; ${row.name} was not created` } }); }
    return answer({ ...failed.response, sandbox_id: row.sandbox_id, error: { ...failed.response.error, message: `${failed.response.error.message}; ${row.name} stays reserved` } });
  }
  const relayed = await relay(principal, row.machine_id, request, deps);
  const response = (relayed.body as { response?: ResponseEnvelope }).response;
  if (!response) return relayed;
  if (!response.ok) {
    if (definitive(response)) { await release(); return answer({ ...response, request_id: request.request_id, sandbox_id: null }); }
    return answer({ ...response, request_id: request.request_id, error: { ...response.error, message: `${response.error.message}; ${facts.machine} may still create ${row.name} once the image is there: it stays reserved (replay with mutation id ${request.mutation_id} to get its state)` } });
  }
  const from = copy ? copy.from_machine_name ?? copy.from_machine_id : "its source";
  const report: ActionReport = {
    requested: asked as Json,
    produced: { sandbox_id: row.sandbox_id, name: row.name, image: facts.image, image_reason: facts.image_reason, machine: facts.machine, placement_reason: facts.placement_reason, state: "copying", copying_from: from, image_size_bytes: image.size_bytes, cpus: facts.cpus, memory_bytes: facts.memory_bytes, size_reason: facts.size_reason, sleep_after_ms: row.sleep_after_ms, delete_after_ms: row.delete_after_ms },
    actions: [{ kind: "waiting", detail: `sandbox ${row.name} on ${facts.machine} is waiting for image ${image.name} to copy (${sizeText(image.size_bytes)}); localbox image wait ${image.name}` }],
  };
  return answer(success({ ...request, sandbox_id: row.sandbox_id }, report as unknown as Json));
}

/** Why a sandbox that waited for its image was never created, and what to try next, as the create's failure. */
function notCreated(row: SandboxRow, imageName: string): ErrorBody {
  const error = row.error ?? { code: "internal", message: `image ${imageName} never arrived`, next_step: `delete it with localbox sandbox delete ${row.name} --confirm ${row.name}, then create it again` };
  return { code: "sandbox_not_ready", message: `${row.name} on ${row.machine_name ?? row.machine_id} was not created: ${error.message}`, details: { state: "failed", error, next_step: error.next_step }, retryable: false };
}

/**
 * Any operation on a sandbox that only exists in the catalog so far, answered here without reaching its Mac. Waiting for
 * its image, `sandbox status` reports the copy's progress (read from the target's journal, as `image wait` does) and
 * everything else is `sandbox_not_ready` with that progress; failed, both say why and what to try next.
 */
async function notCreatedYet(principal: Principal, request: RequestEnvelope, target: SandboxRow, deps: OpsDeps): Promise<OpsResponse> {
  const image = await deps.accountCall(principal, "query", "images:get", { image: target.image_id }).then((row: ImageRow) => row.name, () => target.image_id) as string;
  const where = target.machine_name ?? target.machine_id;
  const status = request.operation === "sandbox.status";
  if (target.state === "failed") {
    const refused = notCreated(target, image);
    return answer(status ? success(request, { sandbox_id: target.sandbox_id, name: target.name, machine: where, image, state: "failed", error: target.error as Json }) : failure(request, refused));
  }
  const progress = await copyProgress(principal, request, target, deps);
  const shown = progress ? progressText(progress) : "the copy has not reported progress yet";
  if (status) return answer(success(request, { sandbox_id: target.sandbox_id, name: target.name, machine: where, image, state: "copying", ...(progress ? { progress } : {}), next_step: `localbox image wait ${image}` }));
  return answer(failure(request, { code: "sandbox_not_ready", message: `${target.name} on ${where} is waiting for image ${image} to copy (${shown}); follow it with: localbox image wait ${image}`, details: { state: "copying", image, ...(progress ? { progress } : {}), operation_id: target.copy_operation_id ?? null }, retryable: true }));
}

/** The copy's progress as the target's journal has it now, or undefined when the target doesn't answer. */
async function copyProgress(principal: Principal, request: RequestEnvelope, target: SandboxRow, deps: OpsDeps): Promise<ImageOperationState["progress"] | undefined> {
  const asked = requestFromInvocation({ operation: "image.wait", request_id: `${request.request_id}-progress`, deadline_ms: 10_000, input: { image: target.image_id, timeout_ms: 1 } });
  const response = (await relay(principal, target.machine_id, asked, deps).then((relayed) => relayed.body as { response?: ResponseEnvelope })).response;
  const record = response?.ok ? response.result as unknown as HostOperationView : undefined;
  return record?.progress ? { phase: record.progress.phase, done_bytes: record.progress.completed ?? 0, total_bytes: record.progress.total ?? 0 } : undefined;
}

/** "12 MiB of 64 MiB" while bytes move, else the phase in words. */
const progressText = (progress: NonNullable<ImageOperationState["progress"]>) => progress.total_bytes > 0 ? `${sizeText(progress.done_bytes)} of ${sizeText(progress.total_bytes)}` : progress.phase.replaceAll("_", " ");

const readyHolders = (image: ImageRow) => new Map(image.holders.filter((holder) => holder.state === "ready").map((holder) => [holder.machine_id, holder]));

/**
 * The account's machines as `place()` reads them for `image`. An idle connected Mac makes no Convex calls, so report
 * age says nothing about presence: any machine that has reported capacity counts as online.
 */
function placementMachines(rows: MachineRow[], image: ImageRow): PlacementMachine[] {
  const held = readyHolders(image);
  return rows.map((row) => ({
    id: row.machineId, name: row.name, reported: row.capacity !== undefined, roomBytes: row.capacity?.room_bytes ?? 0, totalBytes: row.capacity?.total_bytes ?? 0, lastReportAt: Math.max(row.lastSeenAt ?? 0, row.capacityAt ?? 0) || undefined,
    holds: held.has(row.machineId), heldAt: held.get(row.machineId)?.updated_at ?? undefined, freeDiskBytes: row.capacity?.free_disk_bytes ?? undefined, macOSVersion: row.capacity?.macos_version,
  }));
}
const placementImage = (image: ImageRow): PlacementImage => ({ id: image.image_id, name: image.name, os: image.os, ...(image.min_macos ? { minMacOS: image.min_macos } : {}), sizeBytes: image.size_bytes ?? 0 });

/** A failed create that certainly made nothing: refused by the machine, never claimed, or never queued. */
const definitive = (response: ResponseEnvelope & { ok: false }, codes = DEFINITIVE_CREATE_FAILURES) => codes.includes(response.error.code)
  || (response.error.code === "rate_limited" && (response.error.details as { limit?: string } | undefined)?.limit === "requests");

/**
 * The create's answer as an action report; the machine's creation line gains the image it started from, by name. A
 * pending create keeps its reservation (its answer arrives by continuation); a definitive failure releases it
 * (`release`, when this call made it); any other failure keeps it and says the create may still complete.
 */
async function created(base: RequestEnvelope, asked: Record<string, unknown>, row: SandboxRow, relayed: OpsResponse, facts: { image: string; image_reason: string; machine: string; placement_reason: string; cpus: number; memory_bytes: number; size_reason: string }, release?: () => Promise<unknown>): Promise<OpsResponse> {
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
    produced: { sandbox_id: row.sandbox_id, name: row.name, image: facts.image, image_reason: facts.image_reason, machine: facts.machine, placement_reason: facts.placement_reason, cpus: facts.cpus, memory_bytes: facts.memory_bytes, size_reason: facts.size_reason, sleep_after_ms: row.sleep_after_ms, delete_after_ms: row.delete_after_ms },
    actions: (machineReport.actions ?? []).map((action) => action.kind === "created" ? { ...action, detail: [action.detail, `image ${facts.image} (${facts.image_reason})`].filter(Boolean).join("; ") } : action),
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

/**
 * `image create --from`: reserve the image's row, with the source sandbox's machine as its first holder (`building`),
 * then have that machine save the sandbox under the create's mutation id. The machine answers with the capture's
 * operation state, usually already finished. A failure that certainly saved nothing releases the reservation; any
 * other keeps it and says the save may still complete. A replay reserves nothing new and gets the first answer back.
 */
async function createImage(principal: Principal, base: RequestEnvelope, machine: string | undefined, deps: OpsDeps): Promise<OpsResponse> {
  const asked = base.input as { from?: string; macos?: true; name?: string; image?: string };
  if (asked.image !== undefined) throw new ContractError("invalid_input", "image is set by the agent API; leave it out");
  if (asked.macos) throw new ContractError("unsupported", "building a macOS base is not available yet; save an image from a sandbox with from");
  if (!base.mutation_id) throw new ContractError("invalid_input", "image.create requires mutation_id");
  const source = await resolveSandbox(principal, asked.from, deps);
  await requireSameMachine(principal, source, machine, deps);
  // Sandbox rows carry no OS: every sandbox runs linux until macOS sandboxes land.
  const image = await deps.accountCall(principal, "mutation", "images:reserve", { machineId: source.machine_id, ...(asked.name === undefined ? {} : { name: asked.name }), os: "linux", source: { kind: "sandbox", sandboxName: source.name }, createMutationId: base.mutation_id }) as ImageRow;
  const relayed = await relay(principal, source.machine_id, { ...base, input: { from: source.sandbox_id, image: image.image_id } }, deps);
  const response = (relayed.body as { response?: ResponseEnvelope }).response;
  if (response && !response.ok) {
    const where = source.machine_name ?? source.machine_id;
    if (!definitive(response, DEFINITIVE_CAPTURE_FAILURES)) return answer({ ...response, error: { ...response.error, message: `${response.error.message}; the save may still complete on ${where}: image ${image.name} stays reserved (replay with mutation id ${base.mutation_id} to get its result)` } });
    await deps.accountCall(principal, "mutation", "images:remove", { image: image.image_id }).catch((error: unknown) => { if (contractError(error).code !== "image_not_found") throw error; });
  }
  return await imageWaitAnswer(principal, relayed, deps, image);
}

/**
 * `image copy NAME --to M`: `--to` resolves as `--machine` does and the source is the holder `place()` picks (online,
 * holding changed most recently); the copy's row and the target's `copying` holding are made in Convex, then both Macs
 * are told under the copy's mutation id, each journaling its side, and their connectors meet at the row. The answer is
 * the target's operation state, at once. A Mac that never took its side cancels the copy; a replay starts nothing new
 * and gets the copy's state back.
 */
async function copyImage(principal: Principal, base: RequestEnvelope, deps: OpsDeps): Promise<OpsResponse> {
  const asked = base.input as { image: string; to: string };
  if (!base.mutation_id) throw new ContractError("invalid_input", "image.copy requires mutation_id");
  const image = await deps.accountCall(principal, "query", "images:get", { image: asked.image }) as ImageRow;
  if (image.image_id === BUILT_IN_IMAGE) throw new ContractError("invalid_input", `${BUILT_IN_IMAGE} is on every Mac from its own release, so it is never copied`);
  let copy = await deps.accountCall(principal, "query", "images:copyByOperation", { operationId: base.mutation_id }) as CopyRow | null;
  if (!copy) {
    const rows = await deps.accountCall(principal, "query", "machines:list", {}) as MachineRow[];
    const placed = place({ machine: asked.to, machines: placementMachines(rows, image), neededBytes: 0, image: placementImage(image) });
    if ("error" in placed) throw new ContractError(placed.error, placed.message, { machines: placed.machines as unknown as Json }, placed.error === "machine_offline");
    if (!placed.copy) {
      const target = rows.find((row) => row.machineId === placed.machineId)!;
      return answer(success(base, { image: image.image_id, name: image.name, os: image.os, state: "ready", report: [`image ${image.name} is already on ${target.name}; nothing to copy`] } satisfies ImageOperationState as unknown as Json));
    }
    copy = await deps.accountCall(principal, "mutation", "images:startCopy", { image: image.image_id, fromMachineId: placed.copy.fromMachineId, toMachineId: placed.machineId, createMutationId: base.mutation_id }) as CopyRow;
  }
  const sides = await startCopySides(principal, base, image, copy, deps);
  if (sides.failed) return answer(sides.failed.response);
  const current = await deps.accountCall(principal, "query", "images:get", { image: image.image_id }) as ImageRow;
  return await imageWaitAnswer(principal, sides.received, deps, current, copy);
}

/** One Mac's side of `copy`, relayed under the copy's mutation id (a repeat is answered by the relay's dedupe). */
const copySide = (principal: Principal, base: RequestEnvelope, image: ImageRow, copy: CopyRow, side: "from" | "to", deps: OpsDeps) =>
  relay(principal, side === "from" ? copy.from_machine_id : copy.to_machine_id, { ...base, operation: "image.copy", request_id: `${base.request_id}-${side}`, mutation_id: copy.operation_id, input: { image: image.image_id, to: copy.to_machine_id } }, deps);

/**
 * Tells both Macs their side of `copy`, answering with the receiver's answer, or with the failure to answer with: a Mac
 * that certainly never took its side cancels the copy (`definitive`), an uncertain answer keeps it for a replay.
 */
async function startCopySides(principal: Principal, base: RequestEnvelope, image: ImageRow, copy: CopyRow, deps: OpsDeps): Promise<{ received: OpsResponse; failed?: { response: ResponseEnvelope & { ok: false }; definitive: boolean } }> {
  const [sent, received] = await Promise.all([copySide(principal, base, image, copy, "from", deps), copySide(principal, base, image, copy, "to", deps)]);
  for (const [relayed, machineId, name] of [[sent, copy.from_machine_id, copy.from_machine_name], [received, copy.to_machine_id, copy.to_machine_name]] as const) {
    const response = (relayed.body as { response?: ResponseEnvelope }).response;
    if (!response || response.ok) continue;
    const where = name ?? machineId;
    if (!definitive(response, DEFINITIVE_COPY_FAILURES)) {
      return { received, failed: { definitive: false, response: { ...response, operation: base.operation, request_id: base.request_id, error: { ...response.error, message: `${where}: ${response.error.message}; the copy may still go on (replay with mutation id ${base.mutation_id} to get its state)` } } } };
    }
    const nextStep = response.error.code === "machine_offline" || response.error.code === "machine_not_found" ? `start ${where}'s connector (or sign it in), then copy again` : `copy again; if it fails the same way, check ${where}'s logs`;
    await deps.accountCall(principal, "mutation", "images:cancelCopy", { copyId: copy.copy_id, error: { code: response.error.code, message: `${where} did not start its side of the copy: ${response.error.message}`, nextStep } });
    return { received, failed: { definitive: true, response: { ...response, operation: base.operation, request_id: base.request_id, error: { ...response.error, message: `${where} did not start its side of the copy, so nothing was copied: ${response.error.message}` } } } };
  }
  return { received };
}

/**
 * An image's operation state. While a Mac's holder row is `building` or `copying`, that Mac answers from its operation
 * journal, waiting up to `timeout_ms` (and within the request's deadline) for the work to finish; the answer comes back
 * inline or by continuation, a normal result either way. With no such holder, the catalog answers.
 */
async function waitForImage(principal: Principal, base: RequestEnvelope, deps: OpsDeps): Promise<OpsResponse> {
  const asked = base.input as { image: string; timeout_ms?: number };
  const image = await deps.accountCall(principal, "query", "images:get", { image: asked.image }) as ImageRow;
  const active = image.holders.filter((holder) => holder.state === "building" || holder.state === "copying").sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0]?.machine_id
    // A copy that landed may still have a sandbox to create from it, on the Mac it landed on.
    ?? (image.image_id === BUILT_IN_IMAGE ? undefined : (await deps.accountCall(principal, "query", "sandboxes:list", {}) as SandboxRow[]).find((row) => row.image_id === image.image_id && row.state === "copying")?.machine_id);
  if (!active) return answer(success(base, catalogState(image) as unknown as Json));
  const request = { ...base, input: { image: image.image_id, ...(asked.timeout_ms === undefined ? {} : { timeout_ms: asked.timeout_ms }) } };
  return await imageWaitAnswer(principal, await relay(principal, active, request, deps), deps, image);
}

/**
 * A machine's `image.wait` or `image.create` answer (its operation record) as the image's operation state, with the image's name and OS
 * from the catalog. Used on the first call and on every continuation, so a long wait reads the same either way; any
 * other answer passes through.
 */
async function imageWaitAnswer(principal: Principal, relayed: OpsResponse, deps: OpsDeps, known?: ImageRow, knownCopy?: CopyRow): Promise<OpsResponse> {
  const response = (relayed.body as { response?: ResponseEnvelope }).response;
  if (!response?.ok || !["image.wait", "image.create", "image.copy"].includes(response.operation)) return relayed;
  const record = response.result as unknown as HostOperationView;
  let image = known; let copy = knownCopy;
  try {
    image ??= await deps.accountCall(principal, "query", "images:get", { image: record.subject }) as ImageRow;
    if (record.kind === COPY_KIND) copy ??= await deps.accountCall(principal, "query", "images:copyByOperation", { operationId: record.key }) as CopyRow | null ?? undefined;
    const copyKey = (record.result as { copy_operation_id?: string } | undefined)?.copy_operation_id;
    if (record.kind === AFTER_COPY_KIND && copyKey) copy ??= await deps.accountCall(principal, "query", "images:copyByOperation", { operationId: copyKey }) as CopyRow | null ?? undefined;
  } catch (error) { return answer(failure(response as unknown as RequestEnvelope, contractError(error))); }
  // A copy answers for its operation, whatever the request was; a request's id stays its own.
  const state = record.kind === COPY_KIND ? copyState(image, record, copy) : record.kind === AFTER_COPY_KIND ? afterCopyState(image, record, copy) : operationState(image, record);
  return answer({ ...response, result: state as unknown as Json });
}

const COPY_KIND = "image.copy";
const AFTER_COPY_KIND = "sandbox.create_after_copy";

/** What a finished `sandbox.create_after_copy` keeps: the sandbox as created, and what its copy moved. */
interface AfterCopyResult { name: string; cpus: number; memory_bytes: number; state: string; copy: { bytes?: number; duration_ms?: number; path?: string; size_bytes?: number } | null }

/**
 * A sandbox create chained to its image's copy, as `image wait` follows it on the Mac the copy goes to: `copying` with the
 * copy's progress, then the copy's line and the created sandbox's, or why it failed and what to try next.
 */
function afterCopyState(image: ImageRow, record: HostOperationView, copy: CopyRow | undefined): ImageOperationState {
  const base = { image: image.image_id, name: image.name, os: image.os };
  const progress = record.progress ? { progress: { phase: record.progress.phase, done_bytes: record.progress.completed ?? 0, total_bytes: record.progress.total ?? 0 } } : {};
  if (record.state === "running") return { ...base, state: "copying", ...progress };
  if (record.state === "failed") return { ...base, state: "failed", error: { code: errorCode(record.error?.code ?? "internal"), message: record.error?.message ?? "the create failed", next_step: record.error?.next_step ?? nextStepFor(image) } };
  const made = record.result as unknown as AfterCopyResult;
  const to = copy?.to_machine_name ?? copy?.to_machine_id ?? "this Mac";
  return { ...base, state: "ready", report: [
    copiedLine(image, copy, { size: made.copy?.size_bytes ?? image.size_bytes, duration: copy?.result?.duration_ms ?? made.copy?.duration_ms ?? 0, path: copy?.result?.path ?? made.copy?.path }),
    `created sandbox ${made.name} on ${to}: ${made.cpus} CPUs and ${gibibytes(made.memory_bytes)}, ${made.state}`,
    `run a command in it: localbox shell exec --sandbox ${made.name} -- CMD`,
  ] };
}

/** `copied image NAME from A to B (SIZE, DURATION, PATH)`. */
function copiedLine(image: ImageRow, copy: CopyRow | undefined, done: { size: number | null | undefined; duration: number; path: string | undefined }): string {
  const from = copy?.from_machine_name ?? copy?.from_machine_id ?? "its source"; const to = copy?.to_machine_name ?? copy?.to_machine_id ?? "the target";
  return `copied image ${image.name} from ${from} to ${to} (${sizeText(done.size ?? null)}, ${durationText(done.duration)}, ${done.path === "internet" ? "internet" : "local network"})`;
}

/**
 * A copy's state, from the target's record and the copy's row. A row that finished wins over a record answered before
 * it did (a replay gets the first answer back from the relay). A copied image reports size, duration and the path.
 */
function copyState(image: ImageRow, record: HostOperationView, copy: CopyRow | undefined): ImageOperationState {
  const base = { image: image.image_id, name: image.name, os: image.os };
  const from = copy?.from_machine_name ?? copy?.from_machine_id ?? "its source"; const to = copy?.to_machine_name ?? copy?.to_machine_id ?? "the target";
  const result = record.result as unknown as { size_bytes?: number; bytes?: number; duration_ms?: number; path?: string } | undefined;
  if (copy?.state === "copied" || record.state === "succeeded") {
    const done = { size: result?.size_bytes ?? image.size_bytes, duration: copy?.result?.duration_ms ?? result?.duration_ms ?? 0, path: copy?.result?.path ?? result?.path };
    return { ...base, state: "ready", report: [
      copiedLine(image, copy, done),
      `start a sandbox from it there: localbox sandbox create --image ${image.name} --machine ${to}`,
    ] };
  }
  const failed = record.state === "failed" ? record.error : copy?.state === "failed" ? copy.error : undefined;
  if (failed) return { ...base, state: "failed", error: { code: errorCode(failed.code), message: `copying ${image.name} from ${from} to ${to} failed: ${failed.message}`, next_step: failed.next_step ?? nextStepFor(image) } };
  return { ...base, state: "copying", ...(record.progress ? { progress: { phase: record.progress.phase, done_bytes: record.progress.completed ?? 0, total_bytes: record.progress.total ?? 0 } } : {}) };
}

/** A duration for a report: "9.5 s", "3 min 5 s", "1 h 2 min". */
export function durationText(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

const nextStepFor = (image: ImageRow) => `delete it with localbox image delete ${image.name} --confirm ${image.name}, then create or copy it again`;

/** A running record shows its holder's state (`building` or `copying`); a finished one is `ready` or `failed`. */
function operationState(image: ImageRow, record: HostOperationView): ImageOperationState {
  const holder = image.holders.find((candidate) => candidate.operation_id === record.key);
  const state = record.state === "succeeded" ? "ready" : record.state === "failed" ? "failed" : holder?.state === "copying" ? "copying" : "building";
  return {
    image: image.image_id, name: image.name, os: image.os, state,
    ...(record.progress ? { progress: { phase: record.progress.phase, done_bytes: record.progress.completed ?? 0, total_bytes: record.progress.total ?? 0 } } : {}),
    ...(record.error ? { error: { code: errorCode(record.error.code), message: record.error.message, next_step: record.error.next_step ?? nextStepFor(image) } } : {}),
    ...(record.state === "succeeded" && record.kind === "image.capture" ? { report: captureReport(image, record.result as unknown as CaptureResult, holder) } : {}),
  };
}

/** What a finished `image.capture` reports: the image's size, and how the source got through it. */
interface CaptureResult { size_bytes: number; stall_ms: number | null; woke?: string; made_room?: string[] }

/**
 * A saved sandbox, line by line (the map's output standard): what was saved, how long the sandbox froze for it, where
 * the image lives, and the next command. A stopped source was saved without a freeze and says so; a sleeping one woke
 * first, and anything slept to make room for it is named.
 */
export function captureReport(image: ImageRow, result: CaptureResult, holder: ImageRow["holders"][number] | undefined): string[] {
  const source = image.source.sandboxName ?? "the sandbox";
  const froze = result.stall_ms === null
    ? `${source} was stopped, so its disk was saved as it lay, without a freeze`
    : `${source} ${result.woke ? "woke from sleep, then " : ""}froze for ${(result.stall_ms / 1000).toFixed(1)} s while its disk was saved, and is running again`;
  return [
    `image ${image.name} saved from sandbox ${source} (${image.os}, ${sizeText(result.size_bytes)})`,
    froze,
    ...(result.made_room ?? []).map((detail) => `made room for it: ${detail}`),
    `on machine ${holder?.machine_name ?? holder?.machine_id ?? "its source's Mac"}; copies to other Macs on first use`,
    `start a sandbox from it: localbox sandbox create --image ${image.name}`,
  ];
}

/** No Mac is building or copying the image, so the catalog's holder rows say how it stands. */
function catalogState(image: ImageRow): ImageOperationState {
  const base = { image: image.image_id, name: image.name, os: image.os };
  if (image.holders.some((holder) => holder.state === "ready")) return { ...base, state: "ready" };
  const failed = image.holders.find((holder) => holder.state === "failed");
  if (failed) {
    const where = failed.machine_name ?? failed.machine_id;
    return { ...base, state: "failed", error: failed.error ? { code: errorCode(failed.error.code), message: `on ${where}: ${failed.error.message}`, next_step: failed.error.next_step } : { code: "internal", message: `the operation on ${where} failed`, next_step: nextStepFor(image) } };
  }
  return { ...base, state: "failed", error: { code: "machine_not_found", message: `no machine holds ${image.name} any more (the Macs that held it left the account)`, next_step: nextStepFor(image) } };
}

const errorCode = (code: string): ErrorCode => (ERROR_CODES as readonly string[]).includes(code) ? code as ErrorCode : "internal";

const imageSource = (source: ImageRow["source"]) => source.kind === "release" ? "release" : source.kind === "ipsw" ? `macOS ${source.ipswVersion ?? ""} IPSW`.replace("  ", " ") : `sandbox ${source.sandboxName ?? "(unknown)"}`;
const holderName = (holder: ImageRow["holders"][number]) => `${holder.machine_name ?? holder.machine_id}${holder.state === "ready" ? "" : ` (${holder.state})`}`;

/**
 * One `image list` row: the facts its table shows (`NAME OS SIZE FROM ON DEFAULT`) and nothing else, so text and JSON
 * carry the same. `on` names the Macs holding the image, with any holding not yet ready marked; `linux` is on every Mac.
 */
function imageListRow(image: ImageRow): Json {
  return { name: image.name, os: image.os, size_bytes: image.size_bytes, from: imageSource(image.source), on: image.image_id === BUILT_IN_IMAGE ? ["every Mac"] : image.holders.map(holderName), default: image.default };
}

async function renameImage(principal: Principal, base: RequestEnvelope, deps: OpsDeps): Promise<ActionReport> {
  const asked = base.input as { image: string; name: string };
  const renamed = await deps.accountCall(principal, "mutation", "images:rename", asked) as { image_id: string; name: string; previous_name: string };
  const changed = renamed.name !== renamed.previous_name;
  return { requested: base.input, produced: renamed, actions: [changed ? { kind: "renamed", detail: `renamed image ${renamed.previous_name} to ${renamed.name}; sandboxes made from it are unaffected` } : { kind: "left_alone", detail: `image ${renamed.name} already has that name` }] };
}

async function defaultImage(principal: Principal, base: RequestEnvelope, deps: OpsDeps): Promise<ActionReport> {
  const previous = (await deps.accountCall(principal, "query", "images:list", {}) as ImageRow[]).find((row) => row.default)?.name ?? BUILT_IN_IMAGE;
  const made = await deps.accountCall(principal, "mutation", "images:setDefault", base.input as { image: string }) as { image_id: string; name: string };
  const action = made.name === previous
    ? { kind: "left_alone" as const, detail: `${made.name} is already the default image` }
    : { kind: "made_default" as const, detail: `${made.name} is now the default image (was ${previous}); sandbox create uses it when it names no image` };
  return { requested: base.input, produced: { ...made, previous_default: previous }, actions: [action] };
}

/**
 * The catalog row (and its holder rows) goes first, then every holder machine is told to remove its files; with
 * `--machine M`, only M's holding and files go and the image stays on the account. A machine that does not answer
 * removes the files when its connector next mirrors the catalog. Sandboxes made from the image keep their own disks.
 */
async function deleteImage(principal: Principal, base: RequestEnvelope, machine: string | undefined, deps: OpsDeps): Promise<OpsResponse> {
  const asked = base.input as { image: string; confirm?: string };
  let image: ImageRow;
  try { image = await deps.accountCall(principal, "query", "images:get", { image: asked.image }) as ImageRow; }
  catch (error) {
    // A delete of an image that is already gone (a replay, or a delete from another caller) has nothing left to do.
    if (contractError(error).code !== "image_not_found") throw error;
    const report: ActionReport = { requested: base.input, produced: { image: asked.image, removed: [] }, actions: [{ kind: "left_alone", detail: `${asked.image} is already deleted: this account has no image by that name or id` }] };
    return answer(success(base, report as unknown as Json));
  }
  if (asked.confirm !== undefined && asked.confirm !== image.name) throw new ContractError("invalid_input", `confirm must be the image's name, ${image.name}`);
  const named = machine ? await findMachine(principal, machine, deps) : undefined;
  let holders: string[]; let defaultReset = false;
  if (named) {
    await deps.accountCall(principal, "mutation", "images:dropHolder", { image: image.image_id, machineId: named.machineId });
    holders = [named.machineId];
  } else {
    const removed = await deps.accountCall(principal, "mutation", "images:remove", { image: image.image_id }) as { holders: string[]; default_reset_to: string | null };
    holders = removed.holders; defaultReset = removed.default_reset_to !== null;
  }
  const nameOf = (machineId: string) => named?.machineId === machineId ? named.name : image.holders.find((holder) => holder.machine_id === machineId)?.machine_name ?? machineId;
  const told = await Promise.all(holders.map(async (machineId, index) => [machineId, await relayedResponse(principal, machineId, { ...base, request_id: `${base.request_id}-${index}`, input: { image: image.image_id } }, deps)] as const));
  const removed = named ? [] : ["account catalog entry"]; const later: string[] = [];
  for (const [machineId, response] of told) {
    if (response?.ok) removed.push(`files on ${nameOf(machineId)}`);
    else if (response?.error.code === "machine_not_found") later.push(`${nameOf(machineId)} is gone from the account, so there is nothing to remove on it`);
    else if (!response || response.error.code === "machine_offline") later.push(`${nameOf(machineId)} did not answer and removes its files when it reconnects`);
    else later.push(`${nameOf(machineId)} did not remove its files (${response.error.code}: ${response.error.message}); they go when its connector next mirrors the catalog`);
  }
  const remaining = image.holders.filter((holder) => holder.machine_id !== named?.machineId).map(holderName);
  const facts = [
    `deleted ${image.name}${named ? ` from ${named.name}` : ""}: removed ${removed.length ? removed.join(", ") : "nothing yet"}`,
    ...later,
    ...(named ? [`the image stays on the account${remaining.length ? `, on ${remaining.join(", ")}` : " with no Mac holding it"}`] : []),
    ...(defaultReset ? [`it was the default image, so the default is now ${BUILT_IN_IMAGE}`] : []),
    `sandboxes made from ${image.name} are unaffected: each has its own copy of the disk`,
  ];
  const report: ActionReport = {
    requested: base.input,
    produced: { image_id: image.image_id, name: image.name, ...(named ? { machine: named.name } : {}), removed, default_reset_to: defaultReset ? BUILT_IN_IMAGE : null },
    actions: [{ kind: "deleted", detail: facts.join("; ") }],
  };
  return answer(success(base, report as unknown as Json));
}

/** The machine's answer (`machine_not_found` when the machine was removed), or undefined while it is still running past this call's wait. */
async function relayedResponse(principal: Principal, machineId: string, request: RequestEnvelope, deps: OpsDeps): Promise<ResponseEnvelope | undefined> {
  const mutationId = request.mutation_id ?? `${request.operation}-${request.request_id}`;
  return ((await relay(principal, machineId, { ...request, mutation_id: mutationId }, deps)).body as { response?: ResponseEnvelope }).response;
}

/**
 * Enqueues `request` for `machineId` and waits for its answer; a malformed envelope or a refused enqueue (machine
 * removed, daily limit) answers as a failure. A create carries the sandbox id it reserved although its operation takes
 * no sandbox, so that one field is checked as the catalog defines it.
 */
async function relay(principal: Principal, machineId: string, request: RequestEnvelope, deps: OpsDeps): Promise<OpsResponse> {
  let queued: { requestId: string };
  try {
    validateRequest(catalogById.get(request.operation as OperationId)?.sandbox_scoped ? request : { ...request, sandbox_id: null });
    queued = await deps.serviceMutation("relay:enqueue", { accountId: principal.accountId, machineId, ...(request.sandbox_id ? { sandboxId: request.sandbox_id } : {}), requestId: request.request_id, operation: request.operation, ...(request.mutation_id ? { mutationId: request.mutation_id } : {}), payload: request });
  } catch (error) { return answer(failure(request, contractError(error))); }
  return await waitFor(principal, queued.requestId, Date.now() + request.deadline_ms, deps, request);
}

async function waitFor(principal: Principal, requestId: string, deadlineAt: number, deps: OpsDeps, request?: RequestEnvelope): Promise<OpsResponse> {
  const claimWindowMs = deps.claimWindowMs ?? 3_000; const maxWaitMs = deps.maxWaitMs ?? 50_000;
  const envelope = request ?? requestFromInvocation({ operation: "system.info", request_id: requestId, input: {} });
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
  if (outcome === "missing") return { status: 404, body: { error: "request not found" } };
  // The request is queued and may still run, so a subscription that failed is a lost answer, never a guess.
  if (outcome === "lost") return answer(failure(envelope, { code: "operation_uncertain", message: "the relay lost track of the request's answer; replay with the same mutation id to get its result", retryable: true }));
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
