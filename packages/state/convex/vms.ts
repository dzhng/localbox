import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/identity.js";
import * as r from "./lib/relay.js";
export const create = mutationGeneric({ args: { ownerId: v.string(), vmId: v.optional(v.string()), name: v.optional(v.string()) }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.createVm(ctx, args); } });
export const list = queryGeneric({ args: { ownerId: v.string() }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.listVms(ctx, args.ownerId); } });
