import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/identity.js";
import * as r from "./lib/relay.js";
export const append = mutationGeneric({ args: { ownerId: v.optional(v.string()), vmId: v.optional(v.string()), requestId: v.optional(v.string()), operation: v.string(), outcome: v.union(v.literal("success"), v.literal("error")), code: v.optional(v.string()), metadata: v.optional(v.any()) }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.appendAudit(ctx, args); } });
