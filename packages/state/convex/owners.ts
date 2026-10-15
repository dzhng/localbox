import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/identity.js";
import * as r from "./lib/relay.js";
export const create = mutationGeneric({ args: { ownerId: v.optional(v.string()), subject: v.string(), displayName: v.optional(v.string()) }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.createOwner(ctx, args); } });
export const list = queryGeneric({ args: {}, handler: async (ctx) => { await requireIdentity(ctx, "service"); return r.listOwners(ctx); } });
