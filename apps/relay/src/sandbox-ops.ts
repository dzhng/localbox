import { ContractError, DEFAULT_SIZE_MINIMUM, defaultSize, defaultSizeReason, failure, requestFromInvocation, sizeText, success, type ActionReport, type ErrorBody, type HostOperationRecord, type ImageOperationState, type Json, type RequestEnvelope } from "../../../packages/contract/src/index.js";
import { contractError } from "../../../packages/contract/src/convex-errors.js";
import { place } from "../../../packages/placement/src/index.js";
import { imageRow, placementError, placementImage, placementMachines, startCopySides } from "./image-ops.js";
import { progressOf, progressText, type CopyRow, type ImageRow } from "./image-state.js";
import { answer, relay, responseOf, toHttp, type OpsDeps, type OpsResponse, type Principal, type Relayed } from "./relay-wait.js";
import { machineRows, type MachineRow, type SandboxRow } from "./resolve.js";
import type { Call } from "./ops.js";

/** `sandboxes:byCreateMutation`: the sandbox a create with this mutation id reserved, and the input it relayed (null once the relay row expired). */
interface ReservedCreate extends SandboxRow { create_input: Record<string, Json> | null }
/** `sandbox.create`'s input as a caller sends it. */
interface CreateAsk { name?: string; image?: string; placement?: "auto" | "remote"; cpus?: number; memory_bytes?: number; sleep_after_ms?: number; delete_after_ms?: number; after_copy?: string }
/** What a create's report says it chose, and why. */
type CreateFacts = { image: string; image_reason: string; machine: string; placement_reason: string; cpus: number; memory_bytes: number; size_reason: string };

/** What a create relays to its machine: the reservation's identity and size, its image by id, and the copy it waits for. */
const createInput = (row: SandboxRow, afterCopy?: string): Record<string, Json> => ({ name: row.name, image: row.image_id, cpus: row.cpus, memory_bytes: row.memory_bytes, sleep_after_ms: row.sleep_after_ms, ...(row.delete_after_ms ? { delete_after_ms: row.delete_after_ms } : {}), ...(afterCopy ? { after_copy: afterCopy } : {}) });
/** The facts of a create whose first call (same mutation id) already chose them. */
const replayFacts = (row: SandboxRow, image: string): CreateFacts => {
  const machine = row.machine_name ?? row.machine_id;
  return { image, image_reason: "as the first create chose it", machine, placement_reason: `on ${machine}, where the first create with this mutation id placed it`, cpus: row.cpus, memory_bytes: row.memory_bytes, size_reason: "as the first create sized it" };
};
/** `sandboxes:create`'s arguments: the reservation on `machine`, under the create's mutation id. */
const reserveArgs = (request: RequestEnvelope, asked: CreateAsk, machineId: string, image: ImageRow, facts: CreateFacts, copyOperationId?: string) => ({
  machineId, ...(asked.name ? { name: asked.name } : {}), imageId: image.image_id, cpus: facts.cpus, memoryBytes: facts.memory_bytes,
  ...(asked.sleep_after_ms ? { sleepAfterMs: asked.sleep_after_ms } : {}), ...(asked.delete_after_ms ? { deleteAfterMs: asked.delete_after_ms } : {}),
  createMutationId: request.mutation_id, ...(copyOperationId ? { copyOperationId } : {}),
});
const reservation = async (principal: Principal, mutationId: string, deps: OpsDeps) => await deps.accountCall(principal, "query", "sandboxes:byCreateMutation", { mutationId }) as ReservedCreate | null;
const release = (principal: Principal, row: SandboxRow, deps: OpsDeps) => deps.accountCall(principal, "mutation", "sandboxes:remove", { sandboxId: row.sandbox_id });
const imageName = (principal: Principal, imageId: string, deps: OpsDeps) => imageRow(principal, imageId, deps).then((row) => row.name, () => imageId);
/**
 * Whether a failed create made nothing, so its reservation can go: the machine answered it, or (on a first call) it
 * never reached one. A replay's relay row may be new (the first one expired) and unclaimed while the first create ran,
 * so only the machine's own answer settles a replay.
 */
const settled = (relayed: Relayed & { from: string }, replay: boolean) => relayed.from === "machine" || (relayed.from === "relay" && !replay);

/**
 * Resolve the image (`image`, else the account default, which is `linux` until changed), place the sandbox on a
 * machine holding it (`place`: on `named`, the machine the request names, else by placement), reserve its identity
 * and image in Convex, then have the machine create it from that image. `callerMachineId` is the calling machine, sent
 * by a CLI whose local daemon answers; a machine can only name itself, and agents have no machine. A replay (the same
 * mutation id) relays the first create again, so the relay's and the machine's dedupe answer with its result instead
 * of making a second sandbox.
 */
export async function createSandbox({ principal, request, machine: named, callerMachineId, deps }: Call): Promise<OpsResponse> {
  const asked = request.input as CreateAsk;
  if (callerMachineId !== undefined && callerMachineId !== principal.machineId) throw new ContractError("invalid_input", "caller_machine_id must be the calling machine's own id");
  if (asked.after_copy !== undefined) throw new ContractError("invalid_input", "after_copy is set by the agent API; leave it out");
  const reserved = await reservation(principal, request.mutation_id!, deps);
  if (reserved) return await replayCreate(principal, request, reserved, deps);
  // `macos` with no IPSW-built image, or a name the account lacks, refuses here with image_not_found and what to do.
  const image = await deps.accountCall(principal, "query", "images:get", asked.image === undefined ? {} : { image: asked.image }) as ImageRow;
  const imageReason = asked.image === undefined ? "the account default" : "as asked";
  const rows = await machineRows(principal, deps);
  // The relayed create itself finds a gone machine in 3 s (machine_offline), and auto/remote placement then tries the
  // next candidate, counting the one it tried as not reported.
  const machines = placementMachines(rows, image);
  const tried = new Set<string>();
  for (;;) {
    const placed = place({ machine: named, placement: asked.placement, callerMachineId, machines: machines.map((machine) => tried.has(machine.id) ? { ...machine, reported: false } : machine), neededBytes: asked.memory_bytes ?? DEFAULT_SIZE_MINIMUM.memory_bytes, image: placementImage(image) });
    if ("error" in placed) throw placementError(placed);
    const machine = rows.find((row) => row.machineId === placed.machineId)!;
    const facts = { image: image.name, image_reason: imageReason, machine: machine.name, placement_reason: placed.reason, ...sized(asked, machine) };
    // A target without the image (a named machine, the caller's own Mac, or auto with no holder that fits) copies first.
    if (placed.copy) return await createAfterCopy(principal, request, asked, image, machine, placed.copy.fromMachineId, facts, deps);
    const row = await deps.accountCall(principal, "mutation", "sandboxes:create", reserveArgs(request, asked, machine.machineId, image, facts)) as SandboxRow;
    // Each placement attempt is a new relay row (request ids are scoped to one machine).
    const attempt: RequestEnvelope = { ...request, request_id: tried.size ? `${request.request_id}-${tried.size}` : request.request_id, sandbox_id: row.sandbox_id, input: createInput(row) };
    const relayed = await relay(principal, machine.machineId, attempt, deps);
    if ("response" in relayed && relayed.from === "relay" && !relayed.response.ok && relayed.response.error.code === "machine_offline" && asked.placement) {
      await release(principal, row, deps); tried.add(machine.machineId); continue;
    }
    return await created(principal, request, relayed, row, asked as Json, facts, deps);
  }
}

/** The size a create asked for, else the default for `machine`, and why. */
function sized(asked: CreateAsk, machine: MachineRow): Pick<CreateFacts, "cpus" | "memory_bytes" | "size_reason"> {
  const { cpus: hostCpus, total_bytes: hostMemory } = machine.capacity ?? {};
  if (asked.cpus !== undefined && asked.memory_bytes !== undefined) return { cpus: asked.cpus, memory_bytes: asked.memory_bytes, size_reason: "as requested" };
  if (!hostCpus || !hostMemory) throw new ContractError("machine_offline", `${machine.name} has not connected yet, so its size is unknown; start its connector or pass cpus and memory_bytes`, undefined, true);
  const fallback = defaultSize(hostCpus, hostMemory);
  return { cpus: asked.cpus ?? fallback.cpus, memory_bytes: asked.memory_bytes ?? fallback.memory_bytes, size_reason: `${asked.cpus === undefined && asked.memory_bytes === undefined ? "default" : "partly default"} for ${machine.name}: ${defaultSizeReason(hostCpus, hostMemory)}` };
}

/** A create whose mutation id already reserved a sandbox: the first create is relayed again, or its copy and chained create told again. */
async function replayCreate(principal: Principal, request: RequestEnvelope, reserved: ReservedCreate, deps: OpsDeps): Promise<OpsResponse> {
  if (reserved.copy_operation_id) return await replayAfterCopy(principal, request, reserved, deps);
  const relayed = await relay(principal, reserved.machine_id, { ...request, sandbox_id: reserved.sandbox_id, input: reserved.create_input ?? createInput(reserved) }, deps);
  return await created(principal, request, relayed, reserved, request.input, replayFacts(reserved, await imageName(principal, reserved.image_id, deps)), deps, true);
}

/**
 * The create's answer as an action report; the machine's creation line gains the image it started from, by name. A
 * pending create keeps its reservation (its answer arrives by continuation), a settled failure releases it, and a
 * lost answer keeps it and says the create may still complete.
 */
async function created(principal: Principal, base: RequestEnvelope, relayed: Relayed, row: SandboxRow, asked: Json, facts: CreateFacts, deps: OpsDeps, replay = false): Promise<OpsResponse> {
  if ("pending" in relayed) return toHttp(relayed);
  const { response } = relayed;
  if (!response.ok) {
    if (settled(relayed, replay)) { await release(principal, row, deps); return answer({ ...response, request_id: base.request_id, sandbox_id: null }); }
    return answer({ ...response, request_id: base.request_id, sandbox_id: row.sandbox_id, error: { ...response.error, message: `${response.error.message}; the create may still complete on ${facts.machine}: ${row.name} stays reserved (replay with mutation id ${base.mutation_id} to get its result)` } });
  }
  const machineReport = response.result as unknown as ActionReport;
  const report: ActionReport = {
    requested: asked,
    produced: { sandbox_id: row.sandbox_id, name: row.name, ...facts, sleep_after_ms: row.sleep_after_ms, delete_after_ms: row.delete_after_ms },
    actions: (machineReport.actions ?? []).map((action) => action.kind === "created" ? { ...action, detail: [action.detail, `image ${facts.image} (${facts.image_reason})`].filter(Boolean).join("; ") } : action),
  };
  return answer(success({ ...base, sandbox_id: row.sandbox_id }, report as unknown as Json));
}

/** A `sandbox.create` that outlived its first call, finished as the first call would have from its reservation. */
export async function continuedCreate(principal: Principal, relayed: Relayed, deps: OpsDeps): Promise<OpsResponse> {
  const { request } = relayed;
  const reserved = await reservation(principal, request.mutation_id!, deps);
  if (!reserved) return toHttp(relayed);
  if (!reserved.copy_operation_id) return await created(principal, request, relayed, reserved, request.input, replayFacts(reserved, await imageName(principal, reserved.image_id, deps)), deps);
  const image = await imageRow(principal, reserved.image_id, deps);
  const copy = await deps.accountCall(principal, "query", "images:copyByOperation", { operationId: reserved.copy_operation_id }) as CopyRow | null;
  return await waitingAnswer(principal, request, relayed, request.input, reserved, image, copy, replayFacts(reserved, image.name), deps);
}

/**
 * `sandbox create` on a Mac without the image: start the image's copy there (or join one already running), reserve the
 * sandbox `copying` with the copy's operation id, and have the Mac journal a create chained to the copy
 * (`sandbox.create_after_copy`, keyed by the create's mutation id). Answers at once: the sandbox is waiting, and
 * `image wait` follows the copy until the sandbox is created.
 */
async function createAfterCopy(principal: Principal, request: RequestEnvelope, asked: CreateAsk, image: ImageRow, machine: MachineRow, fromMachineId: string, facts: CreateFacts, deps: OpsDeps): Promise<OpsResponse> {
  const copyMutation = `${request.mutation_id}-copy`;
  const copy = await deps.accountCall(principal, "mutation", "images:startCopy", { image: image.image_id, fromMachineId, toMachineId: machine.machineId, createMutationId: copyMutation, join: true }) as CopyRow;
  let row: SandboxRow;
  try { row = await deps.accountCall(principal, "mutation", "sandboxes:create", reserveArgs(request, asked, machine.machineId, image, facts, copy.operation_id)) as SandboxRow; }
  catch (error) {
    // A copy this create started, which no Mac was told of yet, would hold the target `copying` with nothing running.
    if (copy.operation_id === copyMutation && copy.state === "waiting") await deps.accountCall(principal, "mutation", "images:cancelCopy", { copyId: copy.copy_id, error: { code: "invalid_input", message: `the sandbox create it was for was refused: ${contractError(error).message}`, nextStep: "create the sandbox again" } });
    throw error;
  }
  return await startAfterCopy(principal, { ...request, sandbox_id: row.sandbox_id, input: createInput(row, copy.operation_id) }, asked as Json, row, image, copy, facts, deps);
}

/**
 * A replayed create of a sandbox that waited for its image: the copy's sides and the chained create are told again
 * (the relay's dedupe answers each with its first answer), then the catalog says how it stands.
 */
async function replayAfterCopy(principal: Principal, request: RequestEnvelope, reserved: ReservedCreate, deps: OpsDeps): Promise<OpsResponse> {
  const image = await imageRow(principal, reserved.image_id, deps);
  const copy = await deps.accountCall(principal, "query", "images:copyByOperation", { operationId: reserved.copy_operation_id }) as CopyRow | null;
  const machine = reserved.machine_name ?? reserved.machine_id;
  if (reserved.state === "failed") return answer(failure({ ...request, sandbox_id: reserved.sandbox_id }, notCreated(reserved, image.name)));
  if (reserved.state !== "copying") {
    const report: ActionReport = { requested: request.input, produced: { sandbox_id: reserved.sandbox_id, name: reserved.name, image: image.name, machine, state: reserved.state }, actions: [{ kind: "created", detail: `created ${reserved.name} on ${machine} from image ${image.name}, once it was copied there` }] };
    return answer(success({ ...request, sandbox_id: reserved.sandbox_id }, report as unknown as Json));
  }
  const input = reserved.create_input ?? createInput(reserved, reserved.copy_operation_id!);
  return await startAfterCopy(principal, { ...request, sandbox_id: reserved.sandbox_id, input }, request.input, reserved, image, copy, replayFacts(reserved, image.name), deps, true);
}

/**
 * Tells both Macs their side of the copy, then the target its chained create, and answers that the sandbox is waiting.
 * A Mac that certainly never took its part releases the reservation; an uncertain answer keeps it for a replay.
 */
async function startAfterCopy(principal: Principal, request: RequestEnvelope, asked: Json, row: SandboxRow, image: ImageRow, copy: CopyRow | null, facts: CreateFacts, deps: OpsDeps, replay = false): Promise<OpsResponse> {
  // A replay after the copy's row expired (a day) has no copy left to tell; the chained create on the Mac still answers.
  const failed = copy ? (await startCopySides(principal, { ...request, sandbox_id: null }, image, copy, deps)).failed : undefined;
  if (failed?.released) { await release(principal, row, deps); return answer({ ...failed.response, sandbox_id: null, error: { ...failed.response.error, message: `${failed.response.error.message}; ${row.name} was not created` } }); }
  if (failed) return answer({ ...failed.response, sandbox_id: row.sandbox_id, error: { ...failed.response.error, message: `${failed.response.error.message}; ${row.name} stays reserved` } });
  return await waitingAnswer(principal, request, await relay(principal, row.machine_id, request, deps), asked, row, image, copy, facts, deps, replay);
}

/** The chained create's answer: the sandbox is waiting for its image, or (refused) released, or (answer lost) still reserved. */
async function waitingAnswer(principal: Principal, request: RequestEnvelope, relayed: Relayed, asked: Json, row: SandboxRow, image: ImageRow, copy: CopyRow | null, facts: CreateFacts, deps: OpsDeps, replay = false): Promise<OpsResponse> {
  if ("pending" in relayed) return toHttp(relayed);
  const { response } = relayed;
  if (!response.ok) {
    if (settled(relayed, replay)) { await release(principal, row, deps); return answer({ ...response, request_id: request.request_id, sandbox_id: null }); }
    return answer({ ...response, request_id: request.request_id, error: { ...response.error, message: `${response.error.message}; ${facts.machine} may still create ${row.name} once the image is there: it stays reserved (replay with mutation id ${request.mutation_id} to get its state)` } });
  }
  const report: ActionReport = {
    requested: asked,
    produced: { sandbox_id: row.sandbox_id, name: row.name, image: facts.image, image_reason: facts.image_reason, machine: facts.machine, placement_reason: facts.placement_reason, state: "copying", copying_from: copy ? copy.from_machine_name ?? copy.from_machine_id : "its source", image_size_bytes: image.size_bytes, cpus: facts.cpus, memory_bytes: facts.memory_bytes, size_reason: facts.size_reason, sleep_after_ms: row.sleep_after_ms, delete_after_ms: row.delete_after_ms },
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
export async function notCreatedYet(principal: Principal, request: RequestEnvelope, target: SandboxRow, deps: OpsDeps): Promise<OpsResponse> {
  const image = await imageName(principal, target.image_id, deps);
  const where = target.machine_name ?? target.machine_id;
  const status = request.operation === "sandbox.status";
  if (target.state === "failed") return answer(status ? success(request, { sandbox_id: target.sandbox_id, name: target.name, machine: where, image, state: "failed", error: target.error as Json }) : failure(request, notCreated(target, image)));
  const progress = await copyProgress(principal, request, target, deps);
  if (status) return answer(success(request, { sandbox_id: target.sandbox_id, name: target.name, machine: where, image, state: "copying", ...(progress ? { progress } : {}), next_step: `localbox image wait ${image}` }));
  const shown = progress ? progressText(progress) : "the copy has not reported progress yet";
  return answer(failure(request, { code: "sandbox_not_ready", message: `${target.name} on ${where} is waiting for image ${image} to copy (${shown}); follow it with: localbox image wait ${image}`, details: { state: "copying", image, ...(progress ? { progress } : {}), operation_id: target.copy_operation_id ?? null }, retryable: true }));
}

/** The copy's progress as the target's journal has it now, or undefined when the target doesn't answer. */
async function copyProgress(principal: Principal, request: RequestEnvelope, target: SandboxRow, deps: OpsDeps): Promise<ImageOperationState["progress"] | undefined> {
  const asked = requestFromInvocation({ operation: "image.wait", request_id: `${request.request_id}-progress`, deadline_ms: 10_000, input: { image: target.image_id, timeout_ms: 1 } });
  const response = responseOf(await relay(principal, target.machine_id, asked, deps));
  return response?.ok ? progressOf(response.result as unknown as HostOperationRecord) : undefined;
}

/** Rename in the catalog, then tell the machine; an offline machine takes the name from its mirror when it reconnects. */
export async function renameSandbox({ principal, request, target, deps }: Call & { target: SandboxRow }): Promise<OpsResponse> {
  const renamed = await deps.accountCall(principal, "mutation", "sandboxes:rename", { sandboxId: target.sandbox_id, name: (request.input as { name: string }).name }) as { name: string; previous_name: string };
  const told = responseOf(await relay(principal, target.machine_id, request, deps));
  const machine = target.machine_name ?? target.machine_id;
  const detail = `renamed ${renamed.previous_name} to ${renamed.name}${told?.ok ? ` on ${machine}` : told?.error.code === "machine_not_found" ? `; ${machine} is gone from the account, so only the catalog changed` : `; ${machine} did not answer (${told ? told.error.code : "still pending"}) and takes the name when it reconnects`}`;
  const report: ActionReport = { requested: request.input, produced: { sandbox_id: target.sandbox_id, name: renamed.name, previous_name: renamed.previous_name, machine }, actions: [{ kind: "renamed", detail }] };
  return answer(success(request, report as unknown as Json));
}

/**
 * The machine drops the sandbox first (and reports what it removed), then the catalog row goes. An offline machine
 * deletes it when its catalog mirror next arrives without it; a machine gone from the account leaves only the row.
 */
export async function deleteSandbox({ principal, request, target, deps }: Call & { target: SandboxRow }): Promise<OpsResponse> {
  const confirm = (request.input as { confirm?: string }).confirm;
  if (confirm !== undefined && confirm !== target.name) throw new ContractError("invalid_input", `confirm must be the sandbox's name, ${target.name}`);
  const told = responseOf(await relay(principal, target.machine_id, request, deps));
  if (told && !told.ok && !["machine_offline", "sandbox_not_found", "machine_not_found"].includes(told.error.code)) return answer(told);
  await release(principal, target, deps);
  const machine = target.machine_name ?? target.machine_id;
  const fromMachine = told?.ok ? ((told.result as unknown as ActionReport).produced as { removed?: Json[] }).removed ?? [] : [];
  const removed = ["account catalog entry", ...fromMachine.map((item) => `${item} on ${machine}`)];
  const detail = `deleted ${target.name}: removed ${removed.join(", ")}${told?.ok ? "" : told?.error.code === "machine_not_found" ? `; ${machine} is gone from the account, so there is nothing to remove on it` : `; ${machine} did not answer and deletes it when it reconnects`}`;
  const report: ActionReport = { requested: request.input, produced: { sandbox_id: target.sandbox_id, name: target.name, machine, removed }, actions: [{ kind: "deleted", detail }] };
  return answer(success(request, report as unknown as Json));
}
