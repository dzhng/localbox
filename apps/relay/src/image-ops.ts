import { BUILT_IN_IMAGE, ContractError, success, type ActionReport, type ImageOperationState, type Json, type RequestEnvelope, type ResponseEnvelope } from "../../../packages/contract/src/index.js";
import { contractError } from "../../../packages/contract/src/convex-errors.js";
import { buildTarget, place, type Placement, type PlacementImage, type PlacementMachine } from "../../../packages/placement/src/index.js";
import { catalogState, holderName, imageListRow, imageWaitAnswer, type CopyRow, type ImageRow } from "./image-state.js";
import { answer, refusal, relay, responseOf, toHttp, type OpsDeps, type OpsResponse, type Principal, type Relayed } from "./relay-wait.js";
import { alreadyDeleted, findMachine, machineRows, requireSameMachine, resolveMachine, resolveSandbox, type MachineRow, type SandboxRow } from "./resolve.js";
import type { Call } from "./ops.js";

const readyHolders = (image: ImageRow) => new Map(image.holders.filter((holder) => holder.state === "ready").map((holder) => [holder.machine_id, holder]));

/**
 * The account's machines as `place()` reads them for `image`. An idle connected Mac makes no Convex calls, so report
 * age says nothing about presence: any machine that has reported capacity counts as online.
 */
export function placementMachines(rows: MachineRow[], image?: ImageRow): PlacementMachine[] {
  const held = image ? readyHolders(image) : new Map();
  return rows.map((row) => ({
    id: row.machineId, name: row.name, reported: row.capacity !== undefined, roomBytes: row.capacity?.room_bytes ?? 0, totalBytes: row.capacity?.total_bytes ?? 0, lastReportAt: Math.max(row.lastSeenAt ?? 0, row.capacityAt ?? 0) || undefined,
    holds: held.has(row.machineId), heldAt: held.get(row.machineId)?.updated_at ?? undefined, freeDiskBytes: row.capacity?.free_disk_bytes ?? undefined, macOSVersion: row.capacity?.macos_version,
  }));
}
export const placementImage = (image: ImageRow): PlacementImage => ({ id: image.image_id, name: image.name, os: image.os, ...(image.min_macos ? { minMacOS: image.min_macos } : {}), sizeBytes: image.size_bytes ?? 0 });
/** A placement refusal as the contract error it answers with. */
export const placementError = (placed: Extract<Placement, { error: unknown }>, details: Record<string, Json> = {}) => new ContractError(placed.error, placed.message, { machines: placed.machines as unknown as Json, ...details }, placed.error === "machine_offline");

export const imageRow = async (principal: Principal, image: string, deps: OpsDeps) => await deps.accountCall(principal, "query", "images:get", { image }) as ImageRow;
const copyRow = async (principal: Principal, operationId: string, deps: OpsDeps) => await deps.accountCall(principal, "query", "images:copyByOperation", { operationId }) as CopyRow | null;
/** A reservation that will never be built goes; one already gone (deleted meanwhile) has nothing left to release. */
const releaseImage = (principal: Principal, image: ImageRow, deps: OpsDeps) => deps.accountCall(principal, "mutation", "images:remove", { image: image.image_id }).catch((error: unknown) => { if (contractError(error).code !== "image_not_found") throw error; });

/**
 * `image create`: reserve the image's row with the target Mac as its first holder (`building`), then have that Mac
 * capture the source sandbox (`from`) or build a macOS base (`macos`) under the create's mutation id; `settleImageCreate`
 * reads its answer. A replay reserves nothing new and gets the first answer back.
 */
export async function createImage({ principal, request, machine, deps }: Call): Promise<OpsResponse> {
  const asked = request.input as { from?: string; macos?: true; name?: string; image?: string };
  if (asked.image !== undefined) throw new ContractError("invalid_input", "image is set by the agent API; leave it out");
  const named = asked.name === undefined ? {} : { name: asked.name };
  if (asked.macos) {
    // A Mac too old to build is refused before anything is reserved.
    const target = await resolveMachine(principal, undefined, machine, deps);
    const row = (await machineRows(principal, deps)).find((candidate) => candidate.machineId === target)!;
    const placed = buildTarget(placementMachines([row])[0]);
    if ("error" in placed) throw placementError(placed, placed.error === "image_incompatible" ? { next_step: "update that Mac to macOS 27, or build on another Mac with --machine" } : {});
    return await reserveAndStart(principal, request, target, { ...named, os: "macos", source: { kind: "ipsw" } }, { macos: true }, deps);
  }
  // The source's own OS (and the oldest macOS its disk runs on) carries over to the image.
  const source = await resolveSandbox(principal, asked.from, deps);
  await requireSameMachine(principal, source, machine, deps);
  return await reserveAndStart(principal, request, source.machine_id, { ...named, os: source.os, ...(source.min_macos ? { minMacOS: source.min_macos } : {}), source: { kind: "sandbox", sandboxName: source.name } }, { from: source.sandbox_id }, deps);
}

/** Reserves the image on `machineId` and has that Mac start the work, handing it the reserved id as input `image`. */
async function reserveAndStart(principal: Principal, request: RequestEnvelope, machineId: string, reserve: Record<string, unknown>, input: Record<string, Json>, deps: OpsDeps): Promise<OpsResponse> {
  const image = await deps.accountCall(principal, "mutation", "images:reserve", { machineId, ...reserve, createMutationId: request.mutation_id }) as ImageRow;
  return await settleImageCreate(principal, await relay(principal, machineId, { ...request, input: { ...input, image: image.image_id } }, deps), image, deps);
}

/**
 * A Mac's `image.create` answer: its operation state, usually already finished for a capture and past its first phase
 * for a build. A failure releases the reservation, unless the relay lost the answer: then the work may still finish,
 * the image stays reserved and the error says how to follow it.
 */
async function settleImageCreate(principal: Principal, relayed: Relayed, image: ImageRow, deps: OpsDeps): Promise<OpsResponse> {
  const { request } = relayed;
  const holder = image.holders.find((candidate) => candidate.operation_id === request.mutation_id);
  const where = holder?.machine_name ?? holder?.machine_id ?? "its Mac";
  if (refusal(relayed)) await releaseImage(principal, image, deps);
  else if ("response" in relayed && !relayed.response.ok) {
    const { error } = relayed.response;
    const kept = (request.input as { macos?: true }).macos
      ? `the build may still be running on ${where}: image ${image.name} stays reserved (follow it with localbox image wait ${image.name})`
      : `the save may still complete on ${where}: image ${image.name} stays reserved (replay with mutation id ${request.mutation_id} to get its result)`;
    return answer({ ...relayed.response, error: { ...error, message: `${error.message}; ${kept}` } });
  }
  return await imageWaitAnswer(principal, relayed, deps, image);
}

/** An `image.create` that outlived its first call: its reserved image comes back from the catalog. */
export async function continuedImageCreate(principal: Principal, relayed: Relayed, deps: OpsDeps): Promise<OpsResponse> {
  const image = await imageRow(principal, (relayed.request.input as { image: string }).image, deps).catch((error: unknown) => { if (contractError(error).code === "image_not_found") return undefined; throw error; });
  return image ? await settleImageCreate(principal, relayed, image, deps) : toHttp(relayed);
}

/**
 * `image copy NAME --to M`: `--to` resolves as `--machine` does and the source is the holder `place()` picks (online,
 * holding changed most recently); the copy's row and the target's `copying` holding are made in Convex, then both Macs
 * are told under the copy's mutation id, each journaling its side, and their connectors meet at the row. The answer is
 * the target's operation state, at once. A Mac that never took its side cancels the copy; a replay starts nothing new
 * and gets the copy's state back.
 */
export async function copyImage({ principal, request, deps }: Call): Promise<OpsResponse> {
  const asked = request.input as { image: string; to: string };
  const image = await imageRow(principal, asked.image, deps);
  if (image.image_id === BUILT_IN_IMAGE) throw new ContractError("invalid_input", `${BUILT_IN_IMAGE} is on every Mac from its own release, so it is never copied`);
  let copy = await copyRow(principal, request.mutation_id!, deps);
  if (!copy) {
    const rows = await machineRows(principal, deps);
    const placed = place({ machine: asked.to, machines: placementMachines(rows, image), neededBytes: 0, image: placementImage(image) });
    if ("error" in placed) throw placementError(placed);
    if (!placed.copy) {
      const target = rows.find((row) => row.machineId === placed.machineId)!;
      return answer(success(request, { image: image.image_id, name: image.name, os: image.os, state: "ready", report: [`image ${image.name} is already on ${target.name}; nothing to copy`] } satisfies ImageOperationState as unknown as Json));
    }
    copy = await deps.accountCall(principal, "mutation", "images:startCopy", { image: image.image_id, fromMachineId: placed.copy.fromMachineId, toMachineId: placed.machineId, createMutationId: request.mutation_id }) as CopyRow;
  }
  const sides = await startCopySides(principal, request, image, copy, deps);
  if (sides.failed) return answer(sides.failed.response);
  return await imageWaitAnswer(principal, sides.received, deps, await imageRow(principal, image.image_id, deps), copy);
}

/** The receiver's side of an `image.copy` that outlived its first call, finished as the first call would have. */
export async function continuedCopy(principal: Principal, relayed: Relayed, deps: OpsDeps): Promise<OpsResponse> {
  const copy = await copyRow(principal, relayed.request.mutation_id!, deps);
  if (!copy) return toHttp(relayed);
  const failed = await copySideFailure(principal, relayed.request, copy, "to", relayed, deps);
  return failed ? answer(failed.response) : await imageWaitAnswer(principal, relayed, deps, await imageRow(principal, copy.image_id, deps), copy);
}

/** One Mac's side of `copy`, relayed under the copy's mutation id (a repeat is answered by the relay's dedupe). */
const copySide = (principal: Principal, base: RequestEnvelope, copy: CopyRow, side: "from" | "to", deps: OpsDeps) =>
  relay(principal, side === "from" ? copy.from_machine_id : copy.to_machine_id, { ...base, operation: "image.copy", request_id: `${base.request_id}-${side}`, mutation_id: copy.operation_id, input: { image: copy.image_id, to: copy.to_machine_id } }, deps);

export type CopySideFailure = { response: ResponseEnvelope & { ok: false }; released: boolean };

/**
 * Tells both Macs their side of `copy`, answering with the receiver's answer, or with the failure to answer with: a Mac
 * that answered a failure (or never got its side) cancels the copy (`released`); a lost answer keeps it for a replay.
 */
export async function startCopySides(principal: Principal, base: RequestEnvelope, image: ImageRow, copy: CopyRow, deps: OpsDeps): Promise<{ received: Relayed; failed?: CopySideFailure }> {
  const [sent, received] = await Promise.all([copySide(principal, base, copy, "from", deps), copySide(principal, base, copy, "to", deps)]);
  const failed = await copySideFailure(principal, base, copy, "from", sent, deps) ?? await copySideFailure(principal, base, copy, "to", received, deps);
  return { received, ...(failed ? { failed } : {}) };
}

/** Why one side of `copy` did not start, as the request's failure; a side that certainly never will cancels the copy. */
async function copySideFailure(principal: Principal, base: RequestEnvelope, copy: CopyRow, side: "from" | "to", relayed: Relayed, deps: OpsDeps): Promise<CopySideFailure | undefined> {
  const response = responseOf(relayed);
  if (!response || response.ok) return undefined;
  const where = (side === "from" ? copy.from_machine_name : copy.to_machine_name) ?? (side === "from" ? copy.from_machine_id : copy.to_machine_id);
  const asked = { operation: base.operation, request_id: base.request_id };
  if (!refusal(relayed)) return { released: false, response: { ...response, ...asked, error: { ...response.error, message: `${where}: ${response.error.message}; the copy may still go on (replay with mutation id ${base.mutation_id} to get its state)` } } };
  const nextStep = response.error.code === "machine_offline" || response.error.code === "machine_not_found" ? `start ${where}'s connector (or sign it in), then copy again` : `copy again; if it fails the same way, check ${where}'s logs`;
  await deps.accountCall(principal, "mutation", "images:cancelCopy", { copyId: copy.copy_id, error: { code: response.error.code, message: `${where} did not start its side of the copy: ${response.error.message}`, nextStep } });
  return { released: true, response: { ...response, ...asked, error: { ...response.error, message: `${where} did not start its side of the copy, so nothing was copied: ${response.error.message}` } } };
}

/**
 * An image's operation state. While a Mac's holder row is `building` or `copying`, that Mac answers from its operation
 * journal, waiting up to `timeout_ms` (and within the request's deadline) for the work to finish; the answer comes back
 * inline or by continuation, a normal result either way. With no such holder, the catalog answers.
 */
export async function waitForImage({ principal, request, deps }: Call): Promise<OpsResponse> {
  const asked = request.input as { image: string; timeout_ms?: number };
  const image = await imageRow(principal, asked.image, deps);
  const active = image.holders.filter((holder) => holder.state === "building" || holder.state === "copying").sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0]?.machine_id
    // A copy that landed may still have a sandbox to create from it, on the Mac it landed on.
    ?? (image.image_id === BUILT_IN_IMAGE ? undefined : (await deps.accountCall(principal, "query", "sandboxes:list", {}) as SandboxRow[]).find((row) => row.image_id === image.image_id && row.state === "copying")?.machine_id);
  if (!active) return answer(success(request, catalogState(image) as unknown as Json));
  const waited = { ...request, input: { image: image.image_id, ...(asked.timeout_ms === undefined ? {} : { timeout_ms: asked.timeout_ms }) } };
  return await imageWaitAnswer(principal, await relay(principal, active, waited, deps), deps, image);
}

export async function listImages({ principal, request, deps }: Call): Promise<OpsResponse> {
  return answer(success(request, { images: (await deps.accountCall(principal, "query", "images:list", {}) as ImageRow[]).map(imageListRow) }));
}

export async function renameImage({ principal, request, deps }: Call): Promise<OpsResponse> {
  const renamed = await deps.accountCall(principal, "mutation", "images:rename", request.input as { image: string; name: string }) as { image_id: string; name: string; previous_name: string };
  const changed = renamed.name !== renamed.previous_name;
  const report: ActionReport = { requested: request.input, produced: renamed, actions: [changed ? { kind: "renamed", detail: `renamed image ${renamed.previous_name} to ${renamed.name}; sandboxes made from it are unaffected` } : { kind: "left_alone", detail: `image ${renamed.name} already has that name` }] };
  return answer(success(request, report as unknown as Json));
}

export async function defaultImage({ principal, request, deps }: Call): Promise<OpsResponse> {
  const previous = (await deps.accountCall(principal, "query", "images:list", {}) as ImageRow[]).find((row) => row.default)?.name ?? BUILT_IN_IMAGE;
  const made = await deps.accountCall(principal, "mutation", "images:setDefault", request.input as { image: string }) as { image_id: string; name: string };
  const action = made.name === previous
    ? { kind: "left_alone" as const, detail: `${made.name} is already the default image` }
    : { kind: "made_default" as const, detail: `${made.name} is now the default image (was ${previous}); sandbox create uses it when it names no image` };
  const report: ActionReport = { requested: request.input, produced: { ...made, previous_default: previous }, actions: [action] };
  return answer(success(request, report as unknown as Json));
}

/**
 * The catalog row (and its holder rows) goes first, then every holder machine is told to remove its files; with
 * `--machine M`, only M's holding and files go and the image stays on the account. A machine that does not answer
 * removes the files when its connector next mirrors the catalog. Sandboxes made from the image keep their own disks.
 */
export async function deleteImage({ principal, request, machine, deps }: Call): Promise<OpsResponse> {
  const asked = request.input as { image: string; confirm: string };
  let image: ImageRow;
  try { image = await imageRow(principal, asked.image, deps); }
  catch (error) {
    // A delete of an image that is already gone (a replay, or a delete from another caller) has nothing left to do.
    if (contractError(error).code !== "image_not_found") throw error;
    return answer(success(request, alreadyDeleted("image", request.input, asked.image)));
  }
  if (asked.confirm !== image.name) throw new ContractError("invalid_input", `confirm must be the image's name, ${image.name}`);
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
  const told = await Promise.all(holders.map(async (machineId, index) => [machineId, responseOf(await relay(principal, machineId, { ...request, request_id: `${request.request_id}-${index}`, input: { image: image.image_id, confirm: image.name } }, deps))] as const));
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
    requested: request.input,
    produced: { image_id: image.image_id, name: image.name, ...(named ? { machine: named.name } : {}), removed, default_reset_to: defaultReset ? BUILT_IN_IMAGE : null },
    actions: [{ kind: "deleted", detail: facts.join("; ") }],
  };
  return answer(success(request, report as unknown as Json));
}
