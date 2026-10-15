import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/identity.js";
import { base64Hash, byField, clean, familyRevoked, fail, id, jsonHash, persistFamilyRevocation, rateLimit } from "./lib/relay.js";

// Service-only OAuth state for MCP sign-in. Raw codes and tokens arrive once and only their SHA-256 is stored.
// Failures that must still commit a revocation return `{error}` instead of throwing (a throw rolls it back).

const tokenRow = async (accountId: string, clientId: string, familyId: string, input: { accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number }) => ({
  accountId, clientId, scopes: ["account" as const], constraints: null, familyId,
  accessTokenHash: await jsonHash(input.accessToken), refreshTokenHash: await jsonHash(input.refreshToken), accessExpiresAt: input.accessExpiresAt, refreshExpiresAt: input.refreshExpiresAt,
});
/** Rotation keeps a family at two rows, so this bound only matters if concurrent rotations raced. */
const FAMILY_ROWS = 16;
const issued = { accessToken: v.string(), refreshToken: v.string(), accessExpiresAt: v.number(), refreshExpiresAt: v.number() };

export const registerClient = mutationGeneric({ args: { clientName: v.string(), redirectUris: v.array(v.string()), ip: v.string() }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service");
  if (!await rateLimit(ctx, args.ip, "client_register", 20)) return { limited: true as const };
  const row = { clientId: id("client"), clientName: args.clientName, redirectUris: args.redirectUris, createdAt: Date.now() };
  await ctx.db.insert("oauthClients", row); return row;
} });

export const client = queryGeneric({ args: { clientId: v.string() }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service");
  const row = await byField(ctx, "oauthClients", "by_client", "clientId", args.clientId); return row ? clean(row) : null;
} });

export const createCode = mutationGeneric({ args: { code: v.string(), accountId: v.string(), clientId: v.string(), redirectUri: v.string(), resource: v.string(), codeChallenge: v.string(), expiresAt: v.number() }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service");
  const registered = await byField(ctx, "oauthClients", "by_client", "clientId", args.clientId);
  if (!registered || !registered.redirectUris.includes(args.redirectUri)) fail("redirect_uri is not registered for this client");
  if (!await byField(ctx, "accounts", "by_account", "accountId", args.accountId)) fail("account not found");
  const { code, ...rest } = args; await ctx.db.insert("authCodes", { ...rest, codeHash: await jsonHash(code) }); return null;
} });

/** Consumes a code (single use, every binding and PKCE S256 checked) and issues the first tokens of a new family. */
export const exchangeCode = mutationGeneric({ args: { code: v.string(), clientId: v.string(), redirectUri: v.string(), resource: v.string(), codeVerifier: v.string(), ...issued }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service");
  const at = Date.now(); const row = await byField(ctx, "authCodes", "by_code_hash", "codeHash", await jsonHash(args.code));
  if (!row) return { error: "authorization code is invalid" };
  if (row.usedAt !== undefined) {
    // RFC 6749 §4.1.2: a code used twice revokes what the first use issued.
    if (row.familyId) await persistFamilyRevocation(ctx, row.familyId, at);
    return { error: "authorization code was already used" };
  }
  await ctx.db.patch(row._id, { usedAt: at });
  if (row.expiresAt <= at) return { error: "authorization code expired" };
  if (row.clientId !== args.clientId || row.redirectUri !== args.redirectUri || row.resource !== args.resource) return { error: "authorization code was issued for another client, redirect or resource" };
  if (await base64Hash(args.codeVerifier) !== row.codeChallenge) return { error: "PKCE verification failed" };
  const familyId = id("family");
  await ctx.db.insert("oauthTokens", await tokenRow(row.accountId, row.clientId, familyId, args));
  await ctx.db.patch(row._id, { familyId });
  return { accountId: row.accountId as string, familyId };
} });

/**
 * Rotates a refresh token; the new one gets a fresh lifetime. Presenting a used one revokes the whole family. The
 * family keeps two rows: the new one and the one just used, so replaying the refresh token the client last rotated
 * away is still recognised; older rows are deleted (replaying one of those is refused as unknown).
 */
export const rotateRefresh = mutationGeneric({ args: { presentedRefreshToken: v.string(), clientId: v.optional(v.string()), ...issued }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service");
  const at = Date.now(); const old = await byField(ctx, "oauthTokens", "by_refresh_hash", "refreshTokenHash", await jsonHash(args.presentedRefreshToken));
  if (!old || old.refreshExpiresAt <= at || await familyRevoked(ctx, old.familyId)) return { error: "refresh token is invalid or revoked" };
  if (old.refreshUsedAt !== undefined) { await persistFamilyRevocation(ctx, old.familyId, at); return { error: "refresh token replay revoked the token family" }; }
  if (args.clientId !== undefined && args.clientId !== old.clientId) return { error: "refresh token was issued to another client" };
  await ctx.db.patch(old._id, { refreshUsedAt: at });
  const superseded = await ctx.db.query("oauthTokens").withIndex("by_family", (q: any) => q.eq("familyId", old.familyId)).take(FAMILY_ROWS);
  for (const row of superseded) if (row._id !== old._id && row.refreshUsedAt !== undefined) await ctx.db.delete(row._id);
  await ctx.db.insert("oauthTokens", await tokenRow(old.accountId, old.clientId, old.familyId, args));
  return { accountId: old.accountId as string, familyId: old.familyId as string };
} });

export const validateAccess = queryGeneric({ args: { accessToken: v.string() }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service");
  const row = await byField(ctx, "oauthTokens", "by_access_hash", "accessTokenHash", await jsonHash(args.accessToken));
  if (!row || row.accessExpiresAt <= Date.now() || await familyRevoked(ctx, row.familyId)) fail("access token invalid or expired");
  return { accountId: row.accountId as string, clientId: row.clientId as string, familyId: row.familyId as string, scopes: row.scopes as string[], accessExpiresAt: row.accessExpiresAt as number };
} });

export const revokeToken = mutationGeneric({ args: { token: v.string(), hint: v.optional(v.union(v.literal("access_token"), v.literal("refresh_token"))) }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service");
  const digest = await jsonHash(args.token);
  const access = args.hint === "refresh_token" ? undefined : await byField(ctx, "oauthTokens", "by_access_hash", "accessTokenHash", digest);
  const refresh = args.hint === "access_token" ? undefined : await byField(ctx, "oauthTokens", "by_refresh_hash", "refreshTokenHash", digest);
  const match = access ?? refresh; if (match) await persistFamilyRevocation(ctx, match.familyId, Date.now()); return null;
} });

export const revokeFamily = mutationGeneric({ args: { familyId: v.string() }, handler: async (ctx, args) => { await requireIdentity(ctx, "service"); await persistFamilyRevocation(ctx, args.familyId, Date.now()); return null; } });
