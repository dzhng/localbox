import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

type DbContext = { db: any };
type Input = Record<string, any>;

const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const MAX_QUERY_ROWS = 1_000;
const now = (input: Input) => typeof input.now === "number" ? input.now : Date.now();
const jsonHash = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const base64Hash = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  let binary = ""; for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const clean = <T extends Record<string, any>>(row: T): Omit<T, "_id" | "_creationTime"> => {
  const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...rest } = row;
  return rest;
};
const fail = (message: string): never => { throw new Error(message); };
async function boundedRows(query: any, label: string): Promise<any[]> {
  const rows = await query.take(MAX_QUERY_ROWS + 1);
  if (rows.length > MAX_QUERY_ROWS) fail(`${label} exceeds the bounded read limit`);
  return rows;
}

async function owner(ctx: DbContext, ownerId: string): Promise<any> {
  return await ctx.db.query("owners").withIndex("by_owner", (q: any) => q.eq("ownerId", ownerId)).first();
}
async function vm(ctx: DbContext, ownerId: string, vmId: string): Promise<any> {
  const row = await ctx.db.query("vms").withIndex("by_owner", (q: any) => q.eq("ownerId", ownerId)).filter((q: any) => q.eq(q.field("vmId"), vmId)).first();
  if (!row || row.revokedAt !== undefined) fail(`VM ${vmId} not found`);
  return row;
}
async function byField(ctx: DbContext, table: string, index: string, field: string, value: any): Promise<any> {
  return await ctx.db.query(table).withIndex(index, (q: any) => q.eq(field, value)).first();
}

export const write = mutationGeneric({
  args: { operation: v.string(), input: v.any() },
  handler: async (ctx: DbContext, args: { operation: string; input: Input }) => {
    const input = args.input ?? {};
    const at = now(input);
    switch (args.operation) {
      case "createOwner": {
        const existing = await byField(ctx, "owners", "by_subject", "subject", input.subject);
        if (existing) return clean(existing);
        const row = { ownerId: input.ownerId ?? id("owner"), subject: input.subject, displayName: input.displayName, createdAt: at };
        await ctx.db.insert("owners", row); return row;
      }
      case "createVm": {
        await owner(ctx, input.ownerId) ?? fail(`owner ${input.ownerId} not found`);
        if (input.vmId && await byField(ctx, "vms", "by_vm", "vmId", input.vmId)) fail("VM already exists");
        const row = { vmId: input.vmId ?? id("vm"), ownerId: input.ownerId, name: input.name, createdAt: at };
        await ctx.db.insert("vms", row); return row;
      }
      case "issueChannelGrant": {
        await vm(ctx, input.ownerId, input.vmId);
        if (input.channelId && await byField(ctx, "channels", "by_channel", "channelId", input.channelId)) fail("channel already exists");
        const row = { channelId: input.channelId ?? id("channel"), ownerId: input.ownerId, vmId: input.vmId, tokenHash: await jsonHash(input.token), epoch: input.epoch ?? 1, expiresAt: input.expiresAt ?? at + 86_400_000 };
        await ctx.db.insert("channels", row); return row;
      }
      case "rotateChannelGrant": {
        const row = await byField(ctx, "channels", "by_channel", "channelId", input.channelId); if (!row) fail("channel not found");
        if (row.revokedAt || row.expiresAt <= at) fail("channel revoked or expired");
        if (row.epoch !== input.expectedEpoch) fail("stale channel epoch");
        const next = { epoch: row.epoch + 1, tokenHash: await jsonHash(input.token) }; await ctx.db.patch(row._id, next); return clean({ ...row, ...next });
      }
      case "revokeChannel": {
        const row = await byField(ctx, "channels", "by_channel", "channelId", input.channelId); if (!row) fail("channel not found");
        await ctx.db.patch(row._id, { revokedAt: at }); return null;
      }
      case "enqueueRequest": {
        await vm(ctx, input.ownerId, input.vmId);
        const payloadHash = await jsonHash(input.payload);
        const existing = await byField(ctx, "requests", "by_request_id", "requestId", input.requestId);
        if (existing) { if (existing.payloadHash !== payloadHash) fail("request id conflicts with payload"); return clean(existing); }
        if (input.mutationId) {
          const dedupe = await ctx.db.query("requests").withIndex("by_dedupe", (q: any) => q.eq("vmId", input.vmId).eq("operation", input.operation).eq("mutationId", input.mutationId)).first();
          if (dedupe) { if (dedupe.payloadHash !== payloadHash) fail("mutation id conflicts with payload"); return clean(dedupe); }
        }
        const row = { frameId: id("frame"), ownerId: input.ownerId, vmId: input.vmId, requestId: input.requestId, operation: input.operation, mutationId: input.mutationId ?? undefined, payload: input.payload, payloadHash, status: "queued" as const, createdAt: at, deadlineAt: input.deadlineAt };
        await ctx.db.insert("requests", row); return row;
      }
      case "claimRequests": {
        const limit = input.limit ?? 20; const leaseMs = input.leaseMs ?? 30_000;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_ROWS) fail("claim limit exceeds the bounded read limit");
        let rows: any[];
        if (input.ownerId !== undefined && input.vmId !== undefined) {
          const queued = await ctx.db.query("requests").withIndex("by_owner_vm_status_lease", (q: any) => q.eq("ownerId", input.ownerId).eq("vmId", input.vmId).eq("status", "queued")).take(limit);
          const leased = await ctx.db.query("requests").withIndex("by_owner_vm_status_lease", (q: any) => q.eq("ownerId", input.ownerId).eq("vmId", input.vmId).eq("status", "leased").lte("leaseExpiresAt", at)).take(limit);
          rows = [...queued, ...leased].sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
        } else {
          rows = await ctx.db.query("requests").withIndex("by_lease").filter((q: any) => q.and(
            q.or(q.eq(q.field("status"), "queued"), q.and(q.eq(q.field("status"), "leased"), q.lte(q.field("leaseExpiresAt"), at))),
            ...(input.ownerId === undefined ? [] : [q.eq(q.field("ownerId"), input.ownerId)]),
            ...(input.vmId === undefined ? [] : [q.eq(q.field("vmId"), input.vmId)]),
          )).take(limit);
        }
        for (const row of rows) await ctx.db.patch(row._id, { status: "leased", leaseOwner: input.leaseOwner, leaseExpiresAt: at + leaseMs });
        return rows.map((row: any) => ({ ...clean(row), status: "leased", leaseOwner: input.leaseOwner, leaseExpiresAt: at + leaseMs }));
      }
      case "recordResponse": {
        const request = await byField(ctx, "requests", "by_request_id", "requestId", input.requestId); if (!request) fail("request not found");
        const responseHash = await jsonHash(input.response); const existing = await byField(ctx, "responses", "by_request_id", "requestId", input.requestId);
        if (existing) { if (existing.responseHash !== responseHash) fail("response conflicts with recorded response"); return clean(existing); }
        if (request.status !== "leased" || !input.leaseOwner || request.leaseOwner !== input.leaseOwner || (request.leaseExpiresAt ?? 0) <= at) fail("request lease is not owned or has expired");
        await ctx.db.patch(request._id, { status: "completed", leaseOwner: undefined, leaseExpiresAt: undefined });
        const row = { requestId: input.requestId, response: input.response, responseHash, recordedAt: at }; await ctx.db.insert("responses", row); return row;
      }
      case "ackRequest": {
        const request = await byField(ctx, "requests", "by_request_id", "requestId", input.requestId); if (!request) fail("request not found");
        if (request.status !== "leased" || request.leaseOwner !== input.leaseOwner || (request.leaseExpiresAt ?? 0) <= at) fail("request lease is not owned");
        await ctx.db.patch(request._id, { status: "completed", leaseOwner: undefined, leaseExpiresAt: undefined }); return null;
      }
      case "createAuthorizationCode": {
        await vm(ctx, input.ownerId, input.vmId); const code = input.code ?? id("code");
        const row: any = { ...input, code, codeHash: await jsonHash(code), expiresAt: input.expiresAt ?? at + 300_000 }; delete row.now; await ctx.db.insert("authCodes", row); return row;
      }
      case "consumeAuthorizationCode": {
        const row = await byField(ctx, "authCodes", "by_code_hash", "codeHash", await jsonHash(input.code));
        if (!row || row.usedAt !== undefined || row.expiresAt <= at || (await jsonHash(input.verifier) !== row.codeChallenge && await base64Hash(input.verifier) !== row.codeChallenge)) fail("authorization code invalid, expired, or already used");
        await ctx.db.patch(row._id, { usedAt: at }); return clean({ ...row, usedAt: at });
      }
      case "issueOAuthTokens": {
        await vm(ctx, input.ownerId, input.vmId);
        const row = {
          ownerId: input.ownerId,
          vmId: input.vmId,
          resource: input.resource,
          scope: input.scope ?? "vm",
          familyId: input.familyId ?? id("family"),
          accessTokenHash: await jsonHash(input.accessToken),
          refreshTokenHash: await jsonHash(input.refreshToken),
          accessExpiresAt: input.accessExpiresAt,
          refreshExpiresAt: input.refreshExpiresAt,
        };
        await ctx.db.insert("oauthTokens", row); return row;
      }
      case "rotateRefreshToken": {
        const refreshHash = await jsonHash(input.refreshToken);
        const old = await byField(ctx, "oauthTokens", "by_refresh_hash", "refreshTokenHash", refreshHash);
        if (!old || old.revokedAt !== undefined || old.refreshExpiresAt <= at) fail("refresh token invalid or revoked");
        if (old.refreshUsedAt !== undefined) {
          const familyRows = await boundedRows(ctx.db.query("oauthTokens").withIndex("by_family", (q: any) => q.eq("familyId", old.familyId)), "OAuth token family");
          for (const row of familyRows) await ctx.db.patch(row._id, { revokedAt: at });
          fail("refresh replay revoked family");
        }
        const accessToken = id("access"); const refreshToken = id("refresh");
        await ctx.db.patch(old._id, { refreshUsedAt: at, replacementRefreshHash: await jsonHash(refreshToken) });
        const replacement = { ownerId: old.ownerId, vmId: old.vmId, resource: old.resource, scope: old.scope, familyId: old.familyId, accessTokenHash: await jsonHash(accessToken), refreshTokenHash: await jsonHash(refreshToken), accessExpiresAt: at + 900_000, refreshExpiresAt: old.refreshExpiresAt };
        await ctx.db.insert("oauthTokens", replacement); return { ...replacement, accessToken, refreshToken };
      }
      case "appendAudit": {
        const row: any = { ...input, auditId: input.auditId ?? id("audit"), at, metadata: input.metadata }; delete row.now; await ctx.db.insert("audit", row); return row;
      }
      case "quota": {
        const row = await ctx.db.query("quotas").withIndex("by_owner_bucket", (q: any) => q.eq("ownerId", input.ownerId).eq("bucket", input.bucket)).first(); const amount = input.amount ?? 0;
        const next = row ?? { ownerId: input.ownerId, bucket: input.bucket, used: 0, limit: input.limit, resetAt: at + 86_400_000 }; if (next.used + amount > input.limit) fail("quota exceeded");
        const updated = { ...next, used: next.used + amount, limit: input.limit }; if (row) await ctx.db.patch(row._id, { used: updated.used, limit: updated.limit }); else await ctx.db.insert("quotas", updated); return clean(updated);
      }
      case "revokeOAuthFamily": {
        const rows = await boundedRows(ctx.db.query("oauthTokens").withIndex("by_family", (q: any) => q.eq("familyId", input.familyId)), "OAuth token family");
        for (const row of rows) await ctx.db.patch(row._id, { revokedAt: at });
        return null;
      }
      case "revokeOAuthToken": {
        const digest = await jsonHash(input.token);
        const rows = input.hint === "refresh_token"
          ? [await byField(ctx, "oauthTokens", "by_refresh_hash", "refreshTokenHash", digest)]
          : input.hint === "access_token"
            ? [await byField(ctx, "oauthTokens", "by_access_hash", "accessTokenHash", digest)]
            : [await byField(ctx, "oauthTokens", "by_access_hash", "accessTokenHash", digest), await byField(ctx, "oauthTokens", "by_refresh_hash", "refreshTokenHash", digest)];
        const match = rows.find(Boolean);
        if (match) {
          const family = await boundedRows(ctx.db.query("oauthTokens").withIndex("by_family", (q: any) => q.eq("familyId", match.familyId)), "OAuth token family");
          for (const row of family) await ctx.db.patch(row._id, { revokedAt: at });
        }
        return null;
      }
      default: fail(`unsupported relay mutation ${args.operation}`);
    }
  },
});

export const read = queryGeneric({
  args: { operation: v.string(), input: v.any() },
  handler: async (ctx: DbContext, args: { operation: string; input: Input }) => {
    const input = args.input ?? {};
    switch (args.operation) {
      case "listVms": {
        const rows = await boundedRows(ctx.db.query("vms").withIndex("by_owner", (q: any) => q.eq("ownerId", input.ownerId)), "VM list"); return rows.filter((row: any) => row.revokedAt === undefined).map(clean);
      }
      case "getChannel": { const row = await byField(ctx, "channels", "by_channel", "channelId", input.channelId); return row ? clean(row) : undefined; }
      case "getRequest": { const row = await byField(ctx, "requests", "by_request_id", "requestId", input.requestId); return row ? clean(row) : undefined; }
      case "getResponse": { const row = await byField(ctx, "responses", "by_request_id", "requestId", input.requestId); return row ? clean(row) : undefined; }
      case "validateChannelGrant": {
        const row = await byField(ctx, "channels", "by_channel", "channelId", input.channelId); if (!row || row.revokedAt !== undefined || row.expiresAt <= (input.now ?? Date.now()) || row.vmId !== input.vmId || row.epoch !== input.epoch || row.tokenHash !== await jsonHash(input.token)) fail("channel grant is stale, revoked, or VM-bound"); return clean(row);
      }
      case "snapshot": {
        const table = async (name: string) => (await boundedRows(ctx.db.query(name), `${name} snapshot`)).map(clean);
        return { owners: await table("owners"), vms: await table("vms"), channels: await table("channels"), requests: await table("requests"), responses: await table("responses"), audit: await table("audit"), quotas: await table("quotas") };
      }
      case "validateAccessToken": {
        const tokenHash = await jsonHash(input.accessToken);
        const row = await byField(ctx, "oauthTokens", "by_access_hash", "accessTokenHash", tokenHash);
        if (!row || row.revokedAt !== undefined || row.accessExpiresAt <= (input.now ?? Date.now()) || row.resource !== input.resource || (input.vmId && row.vmId !== input.vmId)) fail("access token invalid or expired");
        return { ownerId: row.ownerId, vmId: row.vmId, resource: row.resource, scope: row.scope, familyId: row.familyId, accessExpiresAt: row.accessExpiresAt };
      }
      case "ownerStatus": {
        const allVms = input.vmId === undefined;
        const [channelRows, queuedRows, leasedRows] = await Promise.all([
          boundedRows(allVms ? ctx.db.query("channels").withIndex("by_owner", (q: any) => q.eq("ownerId", input.ownerId)) : ctx.db.query("channels").withIndex("by_owner_vm", (q: any) => q.eq("ownerId", input.ownerId).eq("vmId", input.vmId)), "active channel status"),
          boundedRows(allVms ? ctx.db.query("requests").withIndex("by_owner_status", (q: any) => q.eq("ownerId", input.ownerId).eq("status", "queued")) : ctx.db.query("requests").withIndex("by_owner_vm_status_lease", (q: any) => q.eq("ownerId", input.ownerId).eq("vmId", input.vmId).eq("status", "queued")), "queued request status"),
          boundedRows(allVms ? ctx.db.query("requests").withIndex("by_owner_status", (q: any) => q.eq("ownerId", input.ownerId).eq("status", "leased")) : ctx.db.query("requests").withIndex("by_owner_vm_status_lease", (q: any) => q.eq("ownerId", input.ownerId).eq("vmId", input.vmId).eq("status", "leased")), "leased request status"),
        ]);
        return { channels: channelRows.filter((row: any) => row.ownerId === input.ownerId && (!input.vmId || row.vmId === input.vmId) && row.revokedAt === undefined).length, queued: queuedRows.length + leasedRows.length };
      }
      default: fail(`unsupported relay query ${args.operation}`);
    }
  },
});

