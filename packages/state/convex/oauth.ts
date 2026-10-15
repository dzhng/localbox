import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/identity.js";
import * as r from "./lib/relay.js";
export const issue = mutationGeneric({ args: { ownerId: v.string(), vmId: v.string(), resource: v.string(), scope: v.optional(v.string()), familyId: v.optional(v.string()), accessToken: v.string(), refreshToken: v.string(), accessExpiresAt: v.number(), refreshExpiresAt: v.number() }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.issueOAuthTokens(ctx, args); } });
export const rotateRefresh = mutationGeneric({ args: { refreshToken: v.string() }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.rotateRefreshToken(ctx, args.refreshToken); } });
export const revokeToken = mutationGeneric({ args: { token: v.string(), hint: v.optional(v.union(v.literal("access_token"), v.literal("refresh_token"))) }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.revokeOAuthToken(ctx, args); } });
export const revokeFamily = mutationGeneric({ args: { familyId: v.string() }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.revokeOAuthFamily(ctx, args.familyId); } });
export const validateAccess = queryGeneric({ args: { accessToken: v.string(), resource: v.string(), vmId: v.optional(v.string()) }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); return r.validateAccessToken(ctx, args); } });
