import { relayStateSchema, type RelayStateTable } from "../schema.js";

export type DbContext = { db: any };
export const MAX_QUERY_ROWS = 1_000;
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
export const clean = <T extends Record<string, any>>(row: T): Omit<T, "_id" | "_creationTime"> => { const { _id: _a, _creationTime: _b, ...rest } = row; return rest; };
export const fail = (message: string): never => { throw new Error(message); };
export async function boundedRows(query: any, label: string): Promise<any[]> { const rows = await query.take(MAX_QUERY_ROWS + 1); if (rows.length > MAX_QUERY_ROWS) fail(`${label} exceeds the bounded read limit`); return rows; }
export async function byField(ctx: DbContext, table: string, index: string, field: string, value: any): Promise<any> { return await ctx.db.query(table).withIndex(index, (q: any) => q.eq(field, value)).first(); }
export async function jsonHash(value: unknown): Promise<string> { const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)); const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
export async function base64Hash(value: string): Promise<string> { const bytes = new TextEncoder().encode(value); const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)); let binary = ""; for (const byte of digest) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
export async function familyRevoked(ctx: DbContext, familyId: string): Promise<any | undefined> { return await ctx.db.query("oauthRevocations").withIndex("by_family", (q: any) => q.eq("familyId", familyId)).first(); }
/** Revokes a token family with one row; every token check consults it, so no token row is touched (a family of any age stays revocable). */
export async function persistFamilyRevocation(ctx: DbContext, familyId: string, at: number): Promise<void> { if (!(await familyRevoked(ctx, familyId))) await ctx.db.insert("oauthRevocations", { familyId, revokedAt: at }); }

const HOUR = 60 * 60 * 1000;
/** Fixed one-hour window counter; false once `key` has used `maximum` calls of `bucket`. */
export async function rateLimit(ctx: DbContext, key: string, bucket: string, maximum: number): Promise<boolean> {
  const now = Date.now();
  const row = await ctx.db.query("rateLimits").withIndex("by_key_bucket", (q: any) => q.eq("key", key).eq("bucket", bucket)).first();
  if (!row || row.resetAt <= now) {
    if (row) await ctx.db.patch(row._id, { count: 1, resetAt: now + HOUR });
    else await ctx.db.insert("rateLimits", { key, bucket, count: 1, resetAt: now + HOUR });
    return true;
  }
  if (row.count >= maximum) return false;
  await ctx.db.patch(row._id, { count: row.count + 1 }); return true;
}

/** Every schema table, without Convex's internal row fields. */
export async function snapshot(ctx: DbContext) {
  const tables = Object.keys(relayStateSchema) as RelayStateTable[];
  return Object.fromEntries(await Promise.all(tables.map(async (name) => [name, (await boundedRows(ctx.db.query(name), `${name} snapshot`)).map(clean)]))) as Record<RelayStateTable, any[]>;
}
