import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/identity.js";
import * as r from "./lib/relay.js";
export const create = mutationGeneric({ args: { ownerId: v.string(), clientId: v.string(), redirectUri: v.string(), resource: v.string(), vmId: v.string(), codeChallenge: v.string(), code: v.optional(v.string()), expiresAt: v.optional(v.number()), scope: v.optional(v.string()) }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.createAuthorizationCode(ctx, args); } });
export const consume = mutationGeneric({ args: { code: v.string(), verifier: v.string() }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.consumeAuthorizationCode(ctx, args); } });
