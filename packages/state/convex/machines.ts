import { internalMutationGeneric, makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { requireAccount, requireIdentity } from "./lib/identity.js";
import { byField, clean } from "./lib/relay.js";
import { v } from "convex/values";
import { liveMachines, refuse } from "./lib/relay.js";
import { validateLabel } from "../../names/src/index.js";

/** The calling machine's own record; the only data a machine identity can read here. */
export const self = queryGeneric({ args: {}, handler: async (ctx) => {
  const { machineId } = await requireIdentity(ctx, "machine");
  const { credentialHash: _hash, ...machine } = clean(await byField(ctx, "machines", "by_machine", "machineId", machineId));
  return machine;
} });

export const list = queryGeneric({ args: {}, handler: async (ctx) => { const identity = await requireAccount(ctx); return (await liveMachines(ctx, identity.accountId)).map(({ credentialHash: _hash, ...row }: any) => clean(row)); } });
export const rename = mutationGeneric({ args: { machineId: v.string(), name: v.string() }, handler: async (ctx, args) => { const identity = await requireAccount(ctx); const row = await byField(ctx, "machines", "by_machine", "machineId", args.machineId); if (!row || row.accountId !== identity.accountId || row.revokedAt !== undefined) refuse("machine_not_found", `no machine ${args.machineId} on this account`); const name = validateLabel(args.name); await ctx.db.patch(row._id, { name }); return { machine_id: row.machineId, machine_name: name }; } });

const SANDBOX_BATCH = 200;
/**
 * A revoked machine and its disks are gone from the account, so its sandboxes' catalog rows go in the same mutation,
 * a bounded batch at a time (a larger set continues in a scheduled run). Its disks stay on the Mac: a revoked
 * machine's mirror subscription is refused, never told the catalog is empty. Returns how many rows this run deleted.
 */
async function dropSandboxes(ctx: any, machineId: string): Promise<number> {
  const rows = await ctx.db.query("sandboxes").withIndex("by_machine", (q: any) => q.eq("machineId", machineId)).take(SANDBOX_BATCH);
  for (const row of rows) await ctx.db.delete(row._id);
  if (rows.length === SANDBOX_BATCH) await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("machines:dropRevokedSandboxes") as any, { machineId });
  return rows.length;
}
export const dropRevokedSandboxes = internalMutationGeneric({ args: { machineId: v.string() }, handler: async (ctx, args) => ({ deleted: await dropSandboxes(ctx, args.machineId) }) });

export const remove = mutationGeneric({ args: { machineId: v.string() }, handler: async (ctx, args) => { const identity = await requireAccount(ctx); const row = await byField(ctx, "machines", "by_machine", "machineId", args.machineId); if (!row || row.accountId !== identity.accountId) refuse("machine_not_found", `no machine ${args.machineId} on this account`); await ctx.db.patch(row._id, { revokedAt: Date.now() }); return { machine_id: row.machineId, removed: true, sandboxes_removed: await dropSandboxes(ctx, row.machineId) }; } });
export const revokeSelf = mutationGeneric({ args: {}, handler: async (ctx) => { const identity = await requireIdentity(ctx, "machine"); const row = await byField(ctx, "machines", "by_machine", "machineId", identity.machineId); if (row) await ctx.db.patch(row._id, { revokedAt: Date.now() }); return { revoked: true, sandboxes_removed: row ? await dropSandboxes(ctx, row.machineId) : 0 }; } });
/** Service-only: the machine-token route records when a machine last checked in. */
export const touch = mutationGeneric({ args: { machineId: v.string() }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); const row = await byField(ctx, "machines", "by_machine", "machineId", args.machineId); if (row) await ctx.db.patch(row._id, { lastSeenAt: Date.now() }); return null; } });
