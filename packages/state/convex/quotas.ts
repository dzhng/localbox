import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/identity.js";
import * as r from "./lib/relay.js";
export const consume = mutationGeneric({ args: { ownerId: v.string(), bucket: v.string(), limit: v.number(), amount: v.optional(v.number()) }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.quota(ctx, args); } });
