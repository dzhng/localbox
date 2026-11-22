import { ConvexError } from "convex/values";
import { catalogById, ContractError, failure, requestFromInvocation, success, validateInput, type Json, type OperationId, type RequestEnvelope } from "../../../packages/contract/src/index.js";
import { callerRefused, contractError } from "../../../packages/contract/src/convex-errors.js";
import { continuedCopy, continuedImageCreate, copyImage, createImage, defaultImage, deleteImage, listImages, renameImage, waitForImage } from "./image-ops.js";
import { imageWaitAnswer } from "./image-state.js";
import { answer, relay, toHttp, waitFor, type OpsDeps, type OpsResponse, type Principal, type Relayed } from "./relay-wait.js";
import { alreadyDeleted, findMachine, requireSameMachine, resolveMachine, resolveSandbox, type SandboxRow } from "./resolve.js";
import { continuedCreate, createSandbox, deleteSandbox, notCreatedYet, renameSandbox } from "./sandbox-ops.js";

/**
 * One agent API request, resolved: `machine` and `sandbox` are the caller's selectors (a name or id each), and `target`
 * the sandbox a sandbox-scoped operation acts on.
 */
export interface Call { principal: Principal; request: RequestEnvelope; sandbox?: string; machine?: string; callerMachineId?: string; target?: SandboxRow; deps: OpsDeps }
type Handler = (call: Call) => Promise<OpsResponse>;

/** An account-routed operation: one catalog call as the caller, its value the result (`shape` adjusts it). */
const catalogCall = (kind: "mutation" | "query", name: string, shape: (value: any) => Json = (value) => value): Handler =>
  async ({ principal, request, deps }) => answer(success(request, shape(await deps.accountCall(principal, kind, name, request.input as Record<string, Json>))));
/** The same for a machine operation, whose `machine_id` (a machine's name or id) resolves first. */
const machineCall = (name: string): Handler => async ({ principal, request, deps }) => {
  const { machine_id: machine, ...rest } = request.input as { machine_id: string };
  return answer(success(request, await deps.accountCall(principal, "mutation", name, { ...rest, machineId: (await findMachine(principal, machine, deps)).machineId })));
};
/** A host or guest operation, relayed as it is to the machine the request is for. */
const relayed: Handler = async ({ principal, request, sandbox, machine, target, deps }) =>
  toHttp(await relay(principal, target?.machine_id ?? await resolveMachine(principal, sandbox, machine, deps), request, deps));

/**
 * Every operation the account executor answers, by id: the agent API reads or changes the catalog and, as the
 * operation's `routing` says, tells no machine, one machine, or the image's holders. Host and guest operations are
 * relayed as they are.
 */
export const ACCOUNT_HANDLERS: Partial<Record<OperationId, Handler>> = {
  "account.status": catalogCall("query", "accounts:status"),
  "account.rename": catalogCall("mutation", "accounts:rename"),
  "machine.list": catalogCall("query", "machines:list"),
  "machine.rename": machineCall("machines:rename"),
  "machine.remove": machineCall("machines:remove"),
  "sandbox.list": catalogCall("query", "sandboxes:list", (sandboxes) => ({ sandboxes })),
  "sandbox.create": createSandbox,
  "sandbox.rename": (call) => renameSandbox({ ...call, target: call.target! }),
  "sandbox.delete": (call) => deleteSandbox({ ...call, target: call.target! }),
  "image.create": createImage,
  "image.list": listImages,
  "image.rename": renameImage,
  "image.copy": copyImage,
  "image.default": defaultImage,
  "image.delete": deleteImage,
  "image.wait": waitForImage,
};

/** A continued request's answer is finished the way its first call would have finished it. */
const CONTINUED: Partial<Record<OperationId, (principal: Principal, relayed: Relayed, deps: OpsDeps) => Promise<OpsResponse>>> = {
  "sandbox.create": continuedCreate,
  "image.create": continuedImageCreate,
  "image.copy": continuedCopy,
  "image.wait": (principal, relayed, deps) => imageWaitAnswer(principal, relayed, deps),
};

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
 * Account operations run against the catalog (`ACCOUNT_HANDLERS`). Machine-level host operations (relay status, agent
 * setup) go to one machine (`resolveMachine`). Every other operation acts on a sandbox (`sandbox`; omitted only when
 * the account has exactly one) and is enqueued for the connector of the machine holding it; this call waits on a
 * Convex subscription for up to min(deadline, 50 s). A request no connector claims within 3 s is abandoned and
 * reported `machine_offline`; one still running when the wait ends comes back as a continuation the client resumes with `{continue: request_id}`.
 */
async function handleOps(principal: Principal, input: Record<string, unknown>, deps: OpsDeps): Promise<OpsResponse> {
  if (typeof input.continue === "string") return await continued(principal, input.continue, Number(input.deadline_at ?? 0), deps);
  const operation = String(input.operation ?? "");
  const payload = (input.input ?? {}) as Record<string, Json>;
  const entry = catalogById.get(operation as OperationId);
  const request = requestFromInvocation({ operation, request_id: typeof input.request_id === "string" ? input.request_id : `req_${crypto.randomUUID()}`, deadline_ms: typeof input.deadline_ms === "number" ? input.deadline_ms : undefined, mutation_id: typeof input.mutation_id === "string" ? input.mutation_id : null, input: payload });
  const sandbox = typeof input.sandbox === "string" ? input.sandbox : undefined;
  const call: Call = { principal, request, sandbox, machine: typeof input.machine === "string" ? input.machine : undefined, callerMachineId: typeof input.caller_machine_id === "string" ? input.caller_machine_id : undefined, deps };
  try {
    if (!entry) throw new ContractError("invalid_input", `unsupported operation: ${operation}`);
    validateInput(entry.id, payload);
    if (entry.idempotency === "required" && request.mutation_id === null) throw new ContractError("invalid_input", `${entry.id} requires mutation_id`);
    const handler = ACCOUNT_HANDLERS[entry.id] ?? relayed;
    if (!entry.sandbox_scoped) return await handler(call);
    const target = await resolveSandbox(principal, sandbox, deps).catch((error) => {
      // A delete of a sandbox that is already gone has nothing left to do.
      if (entry.id === "sandbox.delete" && sandbox && error instanceof ContractError && error.code === "sandbox_not_found") return undefined;
      throw error;
    });
    if (!target) return answer(success(request, alreadyDeleted("sandbox", payload, sandbox!)));
    await requireSameMachine(principal, target, call.machine, deps);
    const scoped = { ...call, request: { ...request, sandbox_id: target.sandbox_id }, target };
    // A sandbox still waiting for its image, or failed waiting, exists only in the catalog: the relay answers for it,
    // except a delete, which its Mac takes too (stopping the create that waits there).
    if (entry.id !== "sandbox.delete" && (target.state === "copying" || (target.state === "failed" && target.error))) return await notCreatedYet(principal, scoped.request, target, deps);
    return await handler(scoped);
  } catch (error) {
    if (callerRefused(error)) throw error;
    return answer(failure(request, contractError(error)));
  }
}

/** `{continue: request_id}`: waits on again, then finishes a final answer as the operation's first call would have. */
async function continued(principal: Principal, requestId: string, deadlineAt: number, deps: OpsDeps): Promise<OpsResponse> {
  const relayedNow = await waitFor(principal, requestId, deadlineAt, deps);
  if (!relayedNow) return { status: 404, body: { error: "request not found" } };
  const finish = "response" in relayedNow ? CONTINUED[relayedNow.request.operation as OperationId] : undefined;
  if (!finish) return toHttp(relayedNow);
  try { return await finish(principal, relayedNow, deps); }
  catch (error) {
    if (callerRefused(error)) throw error;
    return answer(failure(relayedNow.request, contractError(error)));
  }
}
