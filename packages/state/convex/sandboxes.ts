import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireAccount, requireIdentity } from "./lib/identity.js";
import { boundedRows, byField, id, liveMachines, refuse } from "./lib/relay.js";
import { abandonSandboxCopy } from "./images.js";
import { holderFailure } from "./schema.js";
import { sandboxName, validateLabel } from "../../names/src/index.js";
import { BUILT_IN_IMAGE } from "../../contract/src/index.js";

/** Idle time before a sandbox sleeps, unless its create asks for another; the daemon applies it. */
export const DEFAULT_SLEEP_AFTER_MS = 5 * 60_000;
const NAME_ATTEMPTS = 20;

const accountRows = async (ctx: any, accountId: string) => await boundedRows(ctx.db.query("sandboxes").withIndex("by_account", (q: any) => q.eq("accountId", accountId)), "sandbox list");
const reservedBy = async (ctx: any, accountId: string, mutationId: string) => await ctx.db.query("sandboxes").withIndex("by_account_mutation", (q: any) => q.eq("accountId", accountId).eq("createMutationId", mutationId)).first();
const named = async (ctx: any, accountId: string, name: string) => await ctx.db.query("sandboxes").withIndex("by_account_name", (q: any) => q.eq("accountId", accountId).eq("name", name)).first();
const nameTaken = async (ctx: any, accountId: string, name: string): Promise<never> => {
  const names = (await accountRows(ctx, accountId)).map((row: any) => row.name).sort();
  return refuse("name_conflict", `${name} is taken on this account; sandboxes: ${names.join(", ")}`, { names });
};
async function ownSandbox(ctx: any, accountId: string, sandboxId: string) {
  const row = await byField(ctx, "sandboxes", "by_sandbox", "sandboxId", sandboxId);
  if (!row || row.accountId !== accountId) refuse("sandbox_not_found", `no sandbox ${sandboxId} on this account`);
  return row;
}
/** A sandbox waiting for its image's copy reads `copying` (or `failed`, with why) until its machine reports it created. */
const view = (row: any, machineName?: string) => ({
  sandbox_id: row.sandboxId, name: row.name, machine_id: row.machineId, machine_name: machineName ?? null, image_id: row.imageId, os: row.os, min_macos: row.minMacOS ?? null,
  cpus: row.cpus, memory_bytes: row.memoryBytes, sleep_after_ms: row.sleepAfterMs, delete_after_ms: row.deleteAfterMs ?? null,
  state: row.pending ?? row.reportedState ?? "unknown", reported_at: row.reportedAt ?? null, copy_operation_id: row.copyOperationId ?? null,
  error: row.pendingError ? { code: row.pendingError.code, message: row.pendingError.message, next_step: row.pendingError.nextStep } : null,
});

/**
 * Reserves a sandbox's identity on one of the caller's machines, with the image it starts from (the id the agent API
 * resolved: an image row's, or the built-in `linux`) and that image's OS, which the sandbox keeps after the image is
 * gone (a sandbox saved as an image passes it on); the agent API then asks that machine to create it. With
 * `copyOperationId` (the image's copy to that machine) the sandbox is `copying` until the machine reports it created. A
 * create carrying a mutation id this account already reserved with returns that reservation instead of a second one.
 */
export const create = mutationGeneric({ args: { machineId: v.string(), name: v.optional(v.string()), imageId: v.string(), cpus: v.number(), memoryBytes: v.number(), sleepAfterMs: v.optional(v.number()), deleteAfterMs: v.optional(v.number()), createMutationId: v.optional(v.string()), copyOperationId: v.optional(v.string()) }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const machine = await byField(ctx, "machines", "by_machine", "machineId", args.machineId);
  if (!machine || machine.accountId !== accountId || machine.revokedAt !== undefined) refuse("machine_not_found", `no machine ${args.machineId} on this account`);
  if (args.createMutationId !== undefined) { const reserved = await reservedBy(ctx, accountId, args.createMutationId); if (reserved) return view(reserved, (await byField(ctx, "machines", "by_machine", "machineId", reserved.machineId))?.name); }
  const image = args.imageId === BUILT_IN_IMAGE ? { os: "linux" as const } : await byField(ctx, "images", "by_image", "imageId", args.imageId);
  if (!image || (args.imageId !== BUILT_IN_IMAGE && image.accountId !== accountId)) refuse("image_not_found", `no image ${args.imageId} on this account`);
  let name = args.name;
  if (name !== undefined) { validateLabel(name); if (await named(ctx, accountId, name)) await nameTaken(ctx, accountId, name); }
  else {
    for (let attempt = 0; attempt < NAME_ATTEMPTS && name === undefined; attempt++) { const candidate = sandboxName(); if (!(await named(ctx, accountId, candidate))) name = candidate; }
    if (name === undefined) refuse("name_conflict", `no free generated name after ${NAME_ATTEMPTS} tries; pass a name`);
  }
  const row = { sandboxId: id("sandbox"), accountId, machineId: machine.machineId, name: name!, imageId: args.imageId, os: image.os, ...(image.minMacOS === undefined ? {} : { minMacOS: image.minMacOS }), cpus: args.cpus, memoryBytes: args.memoryBytes, sleepAfterMs: args.sleepAfterMs ?? DEFAULT_SLEEP_AFTER_MS, ...(args.deleteAfterMs === undefined ? {} : { deleteAfterMs: args.deleteAfterMs }), ...(args.createMutationId === undefined ? {} : { createMutationId: args.createMutationId }), ...(args.copyOperationId === undefined ? {} : { copyOperationId: args.copyOperationId, pending: "copying" as const }), createdAt: Date.now() };
  await ctx.db.insert("sandboxes", row);
  return view(row, machine.name);
} });

/**
 * The sandbox a create with `mutationId` reserved on the caller's account, with the input that create relayed (null
 * once its relay row expired), so a replay relays the very same create; null when there is none.
 */
export const byCreateMutation = queryGeneric({ args: { mutationId: v.string() }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const row = await reservedBy(ctx, accountId, args.mutationId);
  if (!row) return null;
  const machine = await byField(ctx, "machines", "by_machine", "machineId", row.machineId);
  const request = await ctx.db.query("requests").withIndex("by_dedupe", (q: any) => q.eq("machineId", row.machineId).eq("sandboxId", row.sandboxId).eq("operation", "sandbox.create").eq("mutationId", args.mutationId)).first();
  return { ...view(row, machine?.name), create_input: request?.payload?.input ?? null };
} });

export const list = queryGeneric({ args: {}, handler: async (ctx) => {
  const { accountId } = await requireAccount(ctx);
  const machines = new Map((await liveMachines(ctx, accountId)).map((row: any) => [row.machineId, row.name]));
  return (await accountRows(ctx, accountId)).sort((a: any, b: any) => a.createdAt - b.createdAt).map((row: any) => view(row, machines.get(row.machineId)));
} });

export const rename = mutationGeneric({ args: { sandboxId: v.string(), name: v.string() }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const row = await ownSandbox(ctx, accountId, args.sandboxId);
  const name = validateLabel(args.name);
  if (name !== row.name && await named(ctx, accountId, name)) await nameTaken(ctx, accountId, name);
  if (name !== row.name) await ctx.db.patch(row._id, { name });
  return { sandbox_id: row.sandboxId, name, previous_name: row.name, machine_id: row.machineId };
} });

/**
 * Deletes the sandbox's row; one already gone is already deleted, while another account's stays not found. A sandbox
 * still waiting for its image's copy takes the copy with it when no other sandbox waits on it (`copy_cancelled`).
 */
export const remove = mutationGeneric({ args: { sandboxId: v.string() }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const row = await byField(ctx, "sandboxes", "by_sandbox", "sandboxId", args.sandboxId);
  if (!row) return { sandbox_id: args.sandboxId, removed: false, already_deleted: true };
  if (row.accountId !== accountId) refuse("sandbox_not_found", `no sandbox ${args.sandboxId} on this account`);
  await ctx.db.delete(row._id);
  const operationId = row.pending === "copying" ? row.copyOperationId : undefined;
  const othersWait = operationId !== undefined && (await accountRows(ctx, accountId)).some((other: any) => other.pending === "copying" && other.copyOperationId === operationId);
  const cancelled = operationId !== undefined && !othersWait ? await abandonSandboxCopy(ctx, accountId, operationId) : null;
  return { sandbox_id: row.sandboxId, name: row.name, machine_id: row.machineId, removed: true, copy_cancelled: cancelled !== null };
} });

/** The calling machine's sandboxes, for its daemon's identity mirror. */
export const forMachine = queryGeneric({ args: {}, handler: async (ctx) => {
  const { machineId } = await requireIdentity(ctx, "machine");
  const rows = await boundedRows(ctx.db.query("sandboxes").withIndex("by_machine", (q: any) => q.eq("machineId", machineId)), "machine sandboxes");
  return rows.map((row: any) => ({ sandbox_id: row.sandboxId, name: row.name, cpus: row.cpus, memory_bytes: row.memoryBytes, sleep_after_ms: row.sleepAfterMs, delete_after_ms: row.deleteAfterMs ?? null }));
} });

/**
 * The idle policy deleted a sandbox on the calling machine (its `deleteAfter` passed): the row goes. Only the
 * machine holding the sandbox may remove it this way; the reason is logged with the deletion.
 */
export const removeIdle = mutationGeneric({ args: { sandboxId: v.string(), reason: v.string() }, handler: async (ctx, args) => {
  const { machineId } = await requireIdentity(ctx, "machine");
  const row = await byField(ctx, "sandboxes", "by_sandbox", "sandboxId", args.sandboxId);
  if (!row || row.machineId !== machineId) refuse("sandbox_not_found", `no sandbox ${args.sandboxId} on this machine`);
  await ctx.db.delete(row._id);
  const reason = args.reason.slice(0, 500);
  console.log(`sandbox ${row.name} (${row.sandboxId}) deleted by its machine ${machineId}: ${reason}`);
  return { sandbox_id: row.sandboxId, name: row.name, removed: true, reason };
} });

/**
 * How the calling machine's create of a sandbox that waited for its image's copy ended (`operationId` is the create's
 * mutation id, which the machine journaled it under): created, and from now on the machine's reported state is the
 * sandbox's; or failed, with why and what to try next, until the sandbox is deleted. A sandbox deleted meanwhile, or
 * another machine's, has nothing to report.
 */
export const endCreate = mutationGeneric({ args: { operationId: v.string(), state: v.union(v.literal("succeeded"), v.literal("failed")), error: v.optional(holderFailure) }, handler: async (ctx, args) => {
  const { machineId, accountId } = await requireIdentity(ctx, "machine");
  if ((args.state === "failed") !== (args.error !== undefined)) refuse("invalid_input", "a failed create carries its error, and only a failed one does");
  const row = await reservedBy(ctx, accountId!, args.operationId);
  if (!row || row.machineId !== machineId) return { operation_id: args.operationId, reported: false };
  await ctx.db.patch(row._id, args.state === "succeeded" ? { pending: undefined, pendingError: undefined } : { pending: "failed", pendingError: args.error });
  return { operation_id: args.operationId, sandbox_id: row.sandboxId, reported: true, state: args.state === "succeeded" ? "created" : "failed" };
} });

/** Runtime state (and the size the daemon runs it at) reported by the machine holding each sandbox; other machines' sandboxes are ignored and unchanged values are not written. */
export const reportState = mutationGeneric({ args: { states: v.array(v.object({ sandboxId: v.string(), state: v.string(), cpus: v.optional(v.number()), memoryBytes: v.optional(v.number()) })) }, handler: async (ctx, args) => {
  const { machineId } = await requireIdentity(ctx, "machine");
  let written = 0;
  for (const report of args.states.slice(0, 200)) {
    const row = await byField(ctx, "sandboxes", "by_sandbox", "sandboxId", report.sandboxId);
    if (!row || row.machineId !== machineId) continue;
    const patch: Record<string, unknown> = {};
    if (row.reportedState !== report.state) patch.reportedState = report.state;
    if (report.cpus !== undefined && report.cpus !== row.cpus) patch.cpus = report.cpus;
    if (report.memoryBytes !== undefined && report.memoryBytes !== row.memoryBytes) patch.memoryBytes = report.memoryBytes;
    if (Object.keys(patch).length) { await ctx.db.patch(row._id, { ...patch, reportedAt: Date.now() }); written++; }
  }
  return { written };
} });
