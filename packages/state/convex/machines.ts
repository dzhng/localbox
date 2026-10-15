import { queryGeneric } from "convex/server";
import { requireIdentity } from "./lib/identity.js";
import { byField, clean } from "./lib/relay.js";
import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { boundedRows, fail } from "./lib/relay.js";
import { validateLabel } from "../../names/src/index.js";

/** The calling machine's own record; the only data a machine identity can read here. */
export const self = queryGeneric({ args: {}, handler: async (ctx) => {
  const { machineId } = await requireIdentity(ctx, "machine");
  const { credentialHash: _hash, ...machine } = clean(await byField(ctx, "machines", "by_machine", "machineId", machineId));
  return machine;
} });

export const list = queryGeneric({ args: {}, handler: async (ctx) => { const identity = await requireIdentity(ctx, "machine"); const rows = await boundedRows(ctx.db.query("machines").withIndex("by_account", (q: any) => q.eq("accountId", identity.accountId)), "machine list"); return rows.filter((row: any) => row.revokedAt === undefined).map(({ credentialHash: _hash, ...row }: any) => clean(row)); } });
export const rename = mutationGeneric({ args: { machineId: v.string(), name: v.string() }, handler: async (ctx, args) => { const identity = await requireIdentity(ctx, "machine"); const row = await byField(ctx, "machines", "by_machine", "machineId", args.machineId); if (!row || row.accountId !== identity.accountId || row.revokedAt !== undefined) fail("machine not found"); const name = validateLabel(args.name); await ctx.db.patch(row._id, { name }); return { machine_id: row.machineId, machine_name: name }; } });
export const remove = mutationGeneric({ args: { machineId: v.string() }, handler: async (ctx, args) => { const identity = await requireIdentity(ctx, "machine"); const row = await byField(ctx, "machines", "by_machine", "machineId", args.machineId); if (!row || row.accountId !== identity.accountId) fail("machine not found"); await ctx.db.patch(row._id, { revokedAt: Date.now() }); return { machine_id: row.machineId, removed: true }; } });
export const revokeSelf = mutationGeneric({ args: {}, handler: async (ctx) => { const identity = await requireIdentity(ctx, "machine"); const row = await byField(ctx, "machines", "by_machine", "machineId", identity.machineId); if (row) await ctx.db.patch(row._id, { revokedAt: Date.now() }); return { revoked: true }; } });
/** Service-only: the machine-token route records when a machine last checked in (map Q13). */
export const touch = mutationGeneric({ args: { machineId: v.string() }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); const row = await byField(ctx, "machines", "by_machine", "machineId", args.machineId); if (row) await ctx.db.patch(row._id, { lastSeenAt: Date.now() }); return null; } });
