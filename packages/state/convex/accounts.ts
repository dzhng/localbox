import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/identity.js";
import { byField, clean, fail } from "./lib/relay.js";
import { validateLabel } from "../../names/src/index.js";

export const status = queryGeneric({ args: {}, handler: async (ctx) => { const identity = await requireIdentity(ctx, "machine"); const account = await byField(ctx, "accounts", "by_account", "accountId", identity.accountId); if (!account) fail("account not found"); return clean(account); } });
export const rename = mutationGeneric({ args: { name: v.string() }, handler: async (ctx, args) => { const identity = await requireIdentity(ctx, "machine"); const name = validateLabel(args.name); const account = await byField(ctx, "accounts", "by_account", "accountId", identity.accountId); if (!account) fail("account not found"); await ctx.db.patch(account._id, { name }); return { account_id: account.accountId, account_name: name }; } });
