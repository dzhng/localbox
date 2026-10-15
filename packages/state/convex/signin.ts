import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/identity.js";
import { byField, clean, id, jsonHash, fail, rateLimit } from "./lib/relay.js";
import { accountName, machineName, validateLabel } from "../../names/src/index.js";

const normalize = (email: string) => email.trim().toLowerCase();
const accountByEmail = async (ctx: any, email: string) => await byField(ctx, "accounts", "by_email", "email", email);

/** Checks and consumes a code under the shared limits; five wrong guesses delete it. */
async function checkCode(ctx: any, args: { email: string; code: string; ip: string }): Promise<{ valid: boolean; email: string }> {
  const email = normalize(args.email); if (!/^\d{6}$/.test(args.code)) fail("code must be six digits");
  if (!await rateLimit(ctx, args.ip, "ip_verify", 50)) fail("verification rate limit exceeded");
  const row = await byField(ctx, "emailCodes", "by_email", "email", email);
  if (!row || row.expiresAt <= Date.now()) return { valid: false, email };
  if (row.codeHash !== await jsonHash(args.code)) {
    const attempts = row.attempts + 1; if (attempts >= 5) await ctx.db.delete(row._id); else await ctx.db.patch(row._id, { attempts });
    return { valid: false, email };
  }
  await ctx.db.delete(row._id);
  return { valid: true, email };
}

async function accountFor(ctx: any, email: string) {
  let account = await accountByEmail(ctx, email);
  if (!account) { account = { accountId: id("account"), email, name: accountName(), createdAt: Date.now() }; await ctx.db.insert("accounts", account); }
  return account;
}

export const start = mutationGeneric({ args: { email: v.string(), ip: v.string() }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service");
  const email = normalize(args.email); if (!/^.+@.+\..+$/.test(email)) fail("email is invalid");
  const emailAllowed = await rateLimit(ctx, email, "email_send", 5); const ipAllowed = await rateLimit(ctx, args.ip, "ip_send", 20);
  if (!emailAllowed || !ipAllowed) return { sent: true as const, issued: false as const };
  const old = await byField(ctx, "emailCodes", "by_email", "email", email); if (old) await ctx.db.delete(old._id);
  // Rejection sampling keeps the six digits uniform; codes must come from a cryptographic source.
  const draw = new Uint32Array(1); do crypto.getRandomValues(draw); while (draw[0] >= 4_294_000_000);
  const code = String(draw[0] % 1_000_000).padStart(6, "0");
  await ctx.db.insert("emailCodes", { email, codeHash: await jsonHash(code), expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0, createdAt: Date.now() });
  // Nothing about the email's account is returned before its code is verified: the page names no account.
  return { sent: true as const, issued: true as const, code };
} });

export const verify = mutationGeneric({ args: { email: v.string(), code: v.string(), machineName: v.string(), ip: v.string() }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service");
  const checked = await checkCode(ctx, args);
  if (!checked.valid) return { valid: false as const };
  const account = await accountFor(ctx, checked.email);
  const machineId = id("machine"); const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const label = validateLabel(args.machineName || machineName("machine"));
  await ctx.db.insert("machines", { machineId, accountId: account.accountId, name: label, credentialHash: await jsonHash(secret), createdAt: Date.now(), lastSeenAt: Date.now() });
  const machineCount = (await ctx.db.query("machines").withIndex("by_account", (q: any) => q.eq("accountId", account.accountId)).take(1_000)).filter((m: any) => m.revokedAt === undefined).length;
  return { valid: true as const, account_id: account.accountId, account_name: account.name, machine_id: machineId, machine_name: label, secret, machine_count: machineCount };
} });

/** MCP sign-in: the same code check and limits as `verify`, but an agent signs in, so no machine is created. */
export const verifyForAgent = mutationGeneric({ args: { email: v.string(), code: v.string(), ip: v.string() }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service");
  const checked = await checkCode(ctx, args);
  if (!checked.valid) return { valid: false as const };
  const account = await accountFor(ctx, checked.email);
  return { valid: true as const, accountId: account.accountId as string };
} });

export const authenticate = queryGeneric({ args: { secret: v.string() }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service");
  const machine = await byField(ctx, "machines", "by_credential_hash", "credentialHash", await jsonHash(args.secret));
  if (!machine || machine.revokedAt !== undefined) fail("machine credential is invalid or revoked");
  return clean(machine);
} });
