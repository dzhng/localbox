/** Operator-only: run with `npx convex run admin:wipe` (deploy key), never callable by clients. */
import { internalMutationGeneric } from "convex/server";
export const wipe = internalMutationGeneric({ args: {}, handler: async (ctx) => { const tables = ["owners", "vms", "requests", "responses", "relayUsage", "authCodes", "oauthTokens", "oauthRevocations", "audit", "quotas", "accounts", "machines", "emailCodes", "rateLimits"]; for (const table of tables) { const rows = await ctx.db.query(table).collect(); for (const row of rows) await ctx.db.delete(row._id); } return null; } });
