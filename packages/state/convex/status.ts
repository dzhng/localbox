import { queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/identity.js";
import * as r from "./lib/relay.js";
export const owner = queryGeneric({ args: { ownerId: v.string(), vmId: v.optional(v.string()) }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.ownerStatus(ctx, args); } });
