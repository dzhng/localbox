import { ConvexError } from "convex/values";
import type { ErrorBody } from "../../../contract/src/index.js";
import { relayStateSchema, type RelayStateTable } from "../schema.js";

export type DbContext = { db: any };
export const MAX_QUERY_ROWS = 1_000;
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
export const clean = <T extends Record<string, any>>(row: T): Omit<T, "_id" | "_creationTime"> => { const { _id: _a, _creationTime: _b, ...rest } = row; return rest; };
/**
 * Refuses the call with a contract error the caller sees; the agent API and the connector decode it (`contractError`).
 * Every expected failure is a `ConvexError`: production Convex redacts any other error's message to "Server Error",
 * so callers match on `data.code`, never on message text.
 */
export const refuse = (code: ErrorBody["code"], message: string, details?: ErrorBody["details"]): never => { throw new ConvexError({ code, message, ...(details === undefined ? {} : { details }) }); };
/** An expected failure of the Vercel routes' own calls (a malformed or conflicting request); `invalid_input` unless it names another code. */
export const fail = (message: string, code: ErrorBody["code"] = "invalid_input"): never => refuse(code, message);
export async function boundedRows(query: any, label: string): Promise<any[]> { const rows = await query.take(MAX_QUERY_ROWS + 1); if (rows.length > MAX_QUERY_ROWS) fail(`${label} exceeds the bounded read limit`, "resource_exhausted"); return rows; }
/** The account's machines that are not removed; revoked rows stay out of the read, so they never count toward its bound. */
export async function liveMachines(ctx: DbContext, accountId: string): Promise<any[]> { return await boundedRows(ctx.db.query("machines").withIndex("by_account_revoked", (q: any) => q.eq("accountId", accountId).eq("revokedAt", undefined)), "machine list"); }
export async function byField(ctx: DbContext, table: string, index: string, field: string, value: any): Promise<any> { return await ctx.db.query(table).withIndex(index, (q: any) => q.eq(field, value)).first(); }
export async function jsonHash(value: unknown): Promise<string> { const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)); const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
export async function base64Hash(value: string): Promise<string> { const bytes = new TextEncoder().encode(value); const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)); let binary = ""; for (const byte of digest) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
export async function familyRevoked(ctx: DbContext, familyId: string): Promise<any | undefined> { return await ctx.db.query("oauthRevocations").withIndex("by_family", (q: any) => q.eq("familyId", familyId)).first(); }
/** Revokes a token family with one row; every token check consults it, so no token row is touched (a family of any age stays revocable). */
export async function persistFamilyRevocation(ctx: DbContext, familyId: string, at: number): Promise<void> { if (!(await familyRevoked(ctx, familyId))) await ctx.db.insert("oauthRevocations", { familyId, revokedAt: at }); }

/** A plausible email address: one `@`, a dotted domain, no whitespace, at most 254 characters. */
export const validEmail = (email: string) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/**
 * The key a client IP is rate-limited under. An IPv6 client usually holds a whole /64, so it counts as that prefix;
 * an IPv4 address (including one mapped into IPv6) counts as itself.
 */
export function ipKey(ip: string): string {
  const address = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!address.includes(":")) return address;
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address); if (mapped) return mapped[1];
  const [head, tail] = address.split("::");
  const groups = (part: string | undefined) => part ? part.split(":") : [];
  const left = groups(head); const right = tail === undefined ? [] : groups(tail);
  const full = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  if (full.length !== 8 || !full.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return address;
  return `${full.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export const HOUR = 60 * 60 * 1000;
const limitRow = async (ctx: DbContext, key: string, bucket: string) => await ctx.db.query("rateLimits").withIndex("by_key_bucket", (q: any) => q.eq("key", key).eq("bucket", bucket)).first();
/** Fixed-window counter (one hour unless `windowMs` says otherwise); false once `key` has used `maximum` calls of `bucket`. */
export async function rateLimit(ctx: DbContext, key: string, bucket: string, maximum: number, windowMs = HOUR): Promise<boolean> {
  const now = Date.now();
  const row = await limitRow(ctx, key, bucket);
  if (!row || row.resetAt <= now) {
    if (row) await ctx.db.patch(row._id, { count: 1, resetAt: now + windowMs });
    else await ctx.db.insert("rateLimits", { key, bucket, count: 1, resetAt: now + windowMs });
    return true;
  }
  if (row.count >= maximum) return false;
  await ctx.db.patch(row._id, { count: row.count + 1 }); return true;
}
/** Whether `key` has already used `maximum` calls of `bucket` in its current window, without counting this one. */
export async function limitReached(ctx: DbContext, key: string, bucket: string, maximum: number): Promise<boolean> {
  const row = await limitRow(ctx, key, bucket);
  return row !== null && row.resetAt > Date.now() && row.count >= maximum;
}

/** Every schema table, without Convex's internal row fields. */
export async function snapshot(ctx: DbContext) {
  const tables = Object.keys(relayStateSchema) as RelayStateTable[];
  return Object.fromEntries(await Promise.all(tables.map(async (name) => [name, (await boundedRows(ctx.db.query(name), `${name} snapshot`)).map(clean)]))) as Record<RelayStateTable, any[]>;
}
