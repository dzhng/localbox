import { internalMutationGeneric, mutationGeneric, queryGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/identity.js";
import { byField, clean, jsonHash, fail, refuse } from "./lib/relay.js";
import { OUTPUT_CAP_BYTES } from "../../contract/src/index.js";

const CLAIM_WINDOW_MS = 3_000;
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
const nextMidnight = (at: number) => new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate() + 1)).toISOString();
/** Daily per-account knobs (Convex env), read per call so `npx convex env set` takes effect at once. */
const limit = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const overLimit = (what: "requests" | "result_bytes", value: number, at: number): never => refuse("rate_limited", `the account's daily relay ${what === "requests" ? "request" : "result bytes"} limit (${value}; reset ${nextMidnight(at)})`, { limit: what });
/** A failure envelope this small always completes (and still counts), so a connector can report a refused result instead of leaving the row claimed. */
const SMALL_FAILURE_BYTES = 4 * 1024;
/** Rows one mutation id can have: at most one live row, plus abandoned ones from before replays replaced them. */
const REPLAY_ROWS = 16;

async function machineFor(ctx: any, accountId: string, machineId: string) {
  const machine = await byField(ctx, "machines", "by_machine", "machineId", machineId);
  if (!machine || machine.revokedAt !== undefined || machine.accountId !== accountId) refuse("machine_not_found", `machine ${machineId} is not on this account (removed or never signed in)`);
  return machine;
}

export const enqueue = mutationGeneric({ args: { accountId: v.string(), machineId: v.string(), sandboxId: v.optional(v.string()), requestId: v.string(), operation: v.string(), mutationId: v.optional(v.union(v.string(), v.null())), payload: v.any() }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service");
  const at = Date.now(); await machineFor(ctx, args.accountId, args.machineId);
  // The envelope's sandbox is the one routed on, and it must live on this account's chosen machine.
  if ((args.payload?.sandbox_id ?? undefined) !== args.sandboxId) fail("sandbox id does not match the request");
  if (args.sandboxId !== undefined) { const sandbox = await byField(ctx, "sandboxes", "by_sandbox", "sandboxId", args.sandboxId); if (!sandbox || sandbox.accountId !== args.accountId || sandbox.machineId !== args.machineId) fail("sandbox not found", "sandbox_not_found"); }
  // The payload is a whole request envelope; a replay carries a new request id and deadline, so only what would
  // run (operation and input) decides whether two requests are the same.
  const payloadHash = await jsonHash({ operation: args.operation, input: args.payload?.input ?? args.payload });
  // An abandoned row never reached the machine, so a replay of it is a new request: the row goes and a fresh one queues.
  const existing = await byField(ctx, "requests", "by_request_id", "requestId", args.requestId);
  // Request and mutation ids are caller-chosen, so a match only counts inside the caller's own account and machine.
  if (existing && (existing.accountId !== args.accountId || existing.machineId !== args.machineId)) fail("request id conflicts with payload", "conflict");
  if (existing?.status === "abandoned") await ctx.db.delete(existing._id);
  else if (existing) { if (existing.payloadHash !== payloadHash) fail("request id conflicts with payload", "conflict"); return clean(existing); }
  if (args.mutationId) {
    const replays = await ctx.db.query("requests").withIndex("by_dedupe", (q: any) => q.eq("machineId", args.machineId).eq("sandboxId", args.sandboxId).eq("operation", args.operation).eq("mutationId", args.mutationId)).take(REPLAY_ROWS);
    for (const row of replays) if (row.status === "abandoned" && row._id !== existing?._id) await ctx.db.delete(row._id);
    const duplicate = replays.find((row: any) => row.status !== "abandoned");
    if (duplicate) { if (duplicate.payloadHash !== payloadHash) fail("mutation id conflicts with payload", "conflict"); return clean(duplicate); }
  }
  const day = dayOf(at); const usage = await ctx.db.query("relayUsage").withIndex("by_account_day", (q: any) => q.eq("accountId", args.accountId).eq("day", day)).first();
  const requestLimit = limit("LOCALBOX_RELAY_DAILY_REQUESTS", 500);
  if ((usage?.requests ?? 0) + 1 > requestLimit) overLimit("requests", requestLimit, at);
  if (usage) await ctx.db.patch(usage._id, { requests: usage.requests + 1 }); else await ctx.db.insert("relayUsage", { accountId: args.accountId, day, requests: 1, resultBytes: 0 });
  const row = { requestId: args.requestId, accountId: args.accountId, machineId: args.machineId, sandboxId: args.sandboxId, operation: args.operation, mutationId: args.mutationId ?? undefined, payload: args.payload, payloadHash, status: "queued" as const, createdAt: at, claimDeadlineAt: at + CLAIM_WINDOW_MS };
  await ctx.db.insert("requests", row); return row;
} });

export const pendingForMachine = queryGeneric({ args: {}, handler: async (ctx) => {
  const identity = await requireIdentity(ctx, "machine");
  // Claimed rows stay visible so a connector that restarts mid-request picks its own unfinished work back up.
  const rows = [];
  for (const status of ["claimed", "queued"]) rows.push(...await ctx.db.query("requests").withIndex("by_machine_status", (q: any) => q.eq("machineId", identity.machineId).eq("status", status)).take(50));
  return rows.map((row: any) => ({ requestId: row.requestId, operation: row.operation, status: row.status, sandboxId: row.sandboxId, mutationId: row.mutationId, payload: row.payload, claimDeadlineAt: row.claimDeadlineAt }));
} });

export const claim = mutationGeneric({ args: { requestId: v.string() }, handler: async (ctx, args) => {
  const identity = await requireIdentity(ctx, "machine");
  const row = await byField(ctx, "requests", "by_request_id", "requestId", args.requestId);
  if (!row || row.machineId !== identity.machineId) fail("request not found");
  const at = Date.now();
  if (row.status === "queued" && at > row.claimDeadlineAt) { await ctx.db.patch(row._id, { status: "abandoned" }); return { claimed: false, status: "abandoned" }; }
  if (row.status === "claimed") return { claimed: true, status: "claimed" }; // this machine's own unfinished claim
  if (row.status !== "queued") return { claimed: false, status: row.status };
  await ctx.db.patch(row._id, { status: "claimed", claimedAt: at });
  const machine = await machineFor(ctx, identity.accountId!, identity.machineId!);
  if (at - machine.lastSeenAt >= 60_000) await ctx.db.patch(machine._id, { lastSeenAt: at });
  return { claimed: true, status: "claimed" };
} });

export const complete = mutationGeneric({ args: { requestId: v.string(), response: v.any() }, handler: async (ctx, args) => {
  const identity = await requireIdentity(ctx, "machine");
  const row = await byField(ctx, "requests", "by_request_id", "requestId", args.requestId);
  if (!row || row.machineId !== identity.machineId) fail("request not found");
  const encoded = JSON.stringify(args.response); const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > OUTPUT_CAP_BYTES) refuse("resource_exhausted", `response is ${bytes} bytes, over the ${OUTPUT_CAP_BYTES}-byte relay cap`, { bytes });
  const existing = await byField(ctx, "responses", "by_request_id", "requestId", args.requestId);
  if (existing) { if (await jsonHash(existing.response) !== await jsonHash(args.response)) fail("response conflicts with recorded response", "conflict"); return clean(existing); }
  if (row.status !== "claimed") return fail(`request is ${row.status}`, "conflict");
  const at = Date.now(); const usage = await ctx.db.query("relayUsage").withIndex("by_account_day", (q: any) => q.eq("accountId", row.accountId).eq("day", dayOf(at))).first();
  const resultLimit = limit("LOCALBOX_RELAY_DAILY_RESULT_BYTES", 25_000_000);
  const smallFailure = args.response?.ok === false && bytes <= SMALL_FAILURE_BYTES;
  if (!smallFailure && (usage?.resultBytes ?? 0) + bytes > resultLimit) overLimit("result_bytes", resultLimit, at);
  if (usage) await ctx.db.patch(usage._id, { resultBytes: usage.resultBytes + bytes }); else await ctx.db.insert("relayUsage", { accountId: row.accountId, day: dayOf(at), requests: 0, resultBytes: bytes });
  await ctx.db.patch(row._id, { status: "completed" });
  const response = { requestId: args.requestId, accountId: row.accountId, response: args.response, bytes, recordedAt: at }; await ctx.db.insert("responses", response); return response;
} });

export const abandonIfUnclaimed = mutationGeneric({ args: { requestId: v.string() }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service"); const row = await byField(ctx, "requests", "by_request_id", "requestId", args.requestId); if (!row) fail("request not found");
  if (row.status !== "queued") return { abandoned: false, status: row.status };
  await ctx.db.patch(row._id, { status: "abandoned" }); const machine = await byField(ctx, "machines", "by_machine", "machineId", row.machineId); return { abandoned: true, lastSeenAt: machine?.lastSeenAt };
} });

/** A request's status and answer; null for an unknown (or expired) request id, so a waiter ends instead of erroring. */
export const result = queryGeneric({ args: { requestId: v.string() }, handler: async (ctx, args) => {
  await requireIdentity(ctx, "service"); const row = await byField(ctx, "requests", "by_request_id", "requestId", args.requestId); if (!row) return null; const response = await byField(ctx, "responses", "by_request_id", "requestId", args.requestId); return response ? { accountId: row.accountId, status: row.status, response: response.response } : { accountId: row.accountId, status: row.status };
} });

export const reportCapacity = mutationGeneric({ args: { capacity: v.any() }, handler: async (ctx, args) => { const identity = await requireIdentity(ctx, "machine"); const row = await machineFor(ctx, identity.accountId!, identity.machineId!); await ctx.db.patch(row._id, { capacity: args.capacity, capacityAt: Date.now() }); return null; } });

/**
 * The daily cleanup: relay rows and usage past retention, and sign-in and OAuth state nothing can use any more
 * (expired email codes and rate-limit windows, authorization codes, expired or revoked token families, removed
 * machines). Each table is swept a bounded batch at a time; a sweep that fills its batch continues in a scheduled run.
 */
export const cleanupExpired = internalMutationGeneric({ args: { cutoff: v.optional(v.number()), batch: v.optional(v.number()) }, handler: async (ctx, args) => {
  const now = Date.now(); const cutoff = args.cutoff ?? now - 86_400_000; const batch = args.batch ?? 200;
  const sweeps: number[] = [];
  const requests = await ctx.db.query("requests").withIndex("by_created", (q: any) => q.lt("createdAt", cutoff)).take(batch); for (const row of requests) { const response = await byField(ctx, "responses", "by_request_id", "requestId", row.requestId); if (response) await ctx.db.delete(response._id); await ctx.db.delete(row._id); }
  sweeps.push(requests.length);
  const responses = requests.length < batch ? await ctx.db.query("responses").withIndex("by_recorded", (q: any) => q.lt("recordedAt", cutoff)).take(batch) : [];
  for (const row of responses) await ctx.db.delete(row._id); sweeps.push(responses.length);
  const usages = await ctx.db.query("relayUsage").withIndex("by_day", (q: any) => q.lt("day", dayOf(now - 2 * 86_400_000))).take(batch); for (const row of usages) await ctx.db.delete(row._id); sweeps.push(usages.length);
  const sweep = async (table: string, index: string, field: string, before: number) => {
    // `gte(0)` leaves out rows without the field: an index sorts a missing value before every number.
    const rows = await ctx.db.query(table).withIndex(index, (q: any) => q.gte(field, 0).lt(field, before)).take(batch);
    for (const row of rows) await ctx.db.delete(row._id); sweeps.push(rows.length); return rows;
  };
  await sweep("emailCodes", "by_expires", "expiresAt", now);
  await sweep("rateLimits", "by_reset", "resetAt", now);
  // A used code past its expiry can no longer be exchanged; a replay a day later is refused as unknown instead of revoking.
  await sweep("authCodes", "by_expires", "expiresAt", cutoff);
  await sweep("oauthTokens", "by_refresh_expires", "refreshExpiresAt", now);
  // A revoked family's tokens go once no five-minute agent JWT it issued can still be live; its revocation row goes
  // with its last token, since an unknown family is refused just the same.
  const revocations = await ctx.db.query("oauthRevocations").withIndex("by_revoked", (q: any) => q.lt("revokedAt", now - 60 * 60 * 1000)).take(batch);
  let tokens = 0; let families = 0;
  for (const revocation of revocations) {
    const rows = await ctx.db.query("oauthTokens").withIndex("by_family", (q: any) => q.eq("familyId", revocation.familyId)).take(batch - tokens);
    for (const row of rows) await ctx.db.delete(row._id); tokens += rows.length;
    if (!await ctx.db.query("oauthTokens").withIndex("by_family", (q: any) => q.eq("familyId", revocation.familyId)).first()) { await ctx.db.delete(revocation._id); families++; }
    if (tokens >= batch) break;
  }
  sweeps.push(families, tokens);
  // A removed machine is refused whether its row is revoked or gone; its sandboxes' rows went when it was removed.
  await sweep("machines", "by_revoked", "revokedAt", cutoff);
  if (sweeps.some((count) => count >= batch)) await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("relay:cleanupExpired") as any, { cutoff, batch });
  return { deleted: sweeps.reduce((sum, count) => sum + count, 0) };
} });
