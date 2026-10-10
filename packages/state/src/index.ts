import { createHash, randomBytes } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Clock { now(): number }
export interface IdFactory { next(prefix: string): string }
export interface RelayStateRepository {
  readonly deploymentId: string;
  createOwner(input: OwnerInput): Promise<OwnerRecord>;
  createVm(input: VmInput): Promise<VmRecord>;
  listVms(ownerId: string): Promise<VmRecord[]>;
  issueChannelGrant(input: ChannelGrantInput): Promise<ChannelGrantRecord>;
  rotateChannelGrant(channelId: string, expectedEpoch: number): Promise<ChannelGrantRecord>;
  revokeChannel(channelId: string): Promise<void>;
  validateChannelGrant(input: { channelId: string; token: string; vmId: string; epoch: number }): Promise<ChannelGrantRecord>;
  enqueueRequest(input: RequestFrameInput): Promise<RequestFrameRecord>;
  claimRequests(input: ClaimInput): Promise<RequestFrameRecord[]>;
  recordResponse(input: ResponseFrameInput): Promise<ResponseFrameRecord>;
  getResponse(requestId: string): Promise<ResponseFrameRecord | undefined>;
  ackRequest(requestId: string, leaseOwner: string): Promise<void>;
  createAuthorizationCode(input: AuthorizationCodeInput): Promise<AuthorizationCodeRecord>;
  consumeAuthorizationCode(code: string, verifier: string): Promise<AuthorizationCodeRecord>;
  issueOAuthTokens(input: OAuthTokenInput): Promise<OAuthTokenRecord>;
  rotateRefreshToken(refreshToken: string): Promise<OAuthTokenRecord>;
  validateAccessToken(accessToken: string, resource: string, vmId?: string): Promise<AccessTokenRecord>;
  revokeOAuthFamily(familyId: string): Promise<void>;
  appendAudit(input: AuditInput): Promise<AuditRecord>;
  quota(input: QuotaInput): Promise<QuotaRecord>;
  snapshot(): Promise<StateSnapshot>;
}

export interface OwnerInput { ownerId?: string; subject: string; displayName?: string }
export interface OwnerRecord { ownerId: string; subject: string; displayName?: string; createdAt: number }
export interface VmInput { ownerId: string; vmId?: string; name?: string }
export interface VmRecord { vmId: string; ownerId: string; name?: string; createdAt: number; revokedAt?: number }
export interface ChannelGrantInput { ownerId: string; vmId: string; channelId?: string; token: string; epoch?: number; expiresAt?: number }
export interface ChannelGrantRecord { channelId: string; ownerId: string; vmId: string; tokenHash: string; epoch: number; expiresAt: number; revokedAt?: number }
export interface RequestFrameInput { ownerId: string; vmId: string; requestId: string; operation: string; mutationId?: string | null; payload: Json; deadlineAt?: number }
export interface RequestFrameRecord extends RequestFrameInput { frameId: string; payloadHash: string; status: "queued" | "leased" | "completed"; createdAt: number; leaseOwner?: string; leaseExpiresAt?: number }
export interface ClaimInput { ownerId?: string; leaseOwner: string; limit?: number; leaseMs?: number; vmId?: string }
export interface ResponseFrameInput { requestId: string; response: Json; payloadHash?: string; leaseOwner?: string }
export interface ResponseFrameRecord { requestId: string; response: Json; responseHash: string; recordedAt: number }
export interface AuthorizationCodeInput { ownerId: string; clientId: string; redirectUri: string; resource: string; vmId: string; codeChallenge: string; expiresAt?: number; scope?: string }
export interface AuthorizationCodeRecord extends AuthorizationCodeInput { code: string; codeHash: string; expiresAt: number; usedAt?: number }
export interface OAuthTokenInput { ownerId: string; vmId: string; resource: string; scope?: string; familyId?: string; accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number }
export interface OAuthTokenRecord { ownerId: string; vmId: string; resource: string; scope: string; familyId: string; accessTokenHash: string; refreshTokenHash: string; accessExpiresAt: number; refreshExpiresAt: number; refreshUsedAt?: number; replacementRefreshHash?: string; revokedAt?: number }
export interface AccessTokenRecord { ownerId: string; vmId: string; resource: string; scope: string; familyId: string; accessExpiresAt: number }
export interface AuditInput { ownerId?: string; vmId?: string; requestId?: string; operation: string; outcome: "success" | "error"; code?: string; metadata?: Json }
export interface AuditRecord extends AuditInput { auditId: string; at: number; metadata?: Json }
export interface QuotaInput { ownerId: string; bucket: string; limit: number; amount?: number }
export interface QuotaRecord { ownerId: string; bucket: string; used: number; limit: number; resetAt: number }
export interface StateSnapshot { owners: OwnerRecord[]; vms: VmRecord[]; channels: ChannelGrantRecord[]; requests: RequestFrameRecord[]; responses: ResponseFrameRecord[]; audit: AuditRecord[]; quotas: QuotaRecord[] }

export class StateConflictError extends Error { constructor(message: string) { super(message); this.name = "StateConflictError"; } }
export class StateNotFoundError extends Error { constructor(message: string) { super(message); this.name = "StateNotFoundError"; } }
export class StateUnauthorizedError extends Error { constructor(message: string) { super(message); this.name = "StateUnauthorizedError"; } }

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const redact = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value)) out[key] = /output|content|token|secret|cookie|password|authorization/i.test(key) ? "[REDACTED]" : redact(child);
    return out;
  }
  return value;
};

interface Store extends StateSnapshot {
  deploymentId: string;
  authCodes: Map<string, AuthorizationCodeRecord>;
  oauth: Map<string, OAuthTokenRecord>;
  revokedFamilies: Set<string>;
  ownersBySubject: Map<string, string>;
  requestById: Map<string, string>;
  dedupe: Map<string, { payloadHash: string; requestId: string }>;
}
export interface LocalRepositoryOptions { deploymentId?: string; now?: () => number; id?: (prefix: string) => string; store?: Store }

/** Transactional in-memory implementation matching the Convex repository contract. */
export class InMemoryRelayStateRepository implements RelayStateRepository {
  readonly deploymentId: string;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly id: (prefix: string) => string;
  constructor(options: LocalRepositoryOptions = {}) {
    this.deploymentId = options.deploymentId ?? "local"; this.now = options.now ?? (() => Date.now());
    let sequence = 0; this.id = options.id ?? ((prefix) => `${prefix}_${++sequence}`);
    this.store = options.store ?? { deploymentId: this.deploymentId, owners: [], vms: [], channels: [], requests: [], responses: [], audit: [], quotas: [], authCodes: new Map(), oauth: new Map(), revokedFamilies: new Set(), ownersBySubject: new Map(), requestById: new Map(), dedupe: new Map() };
  }
  async createOwner(input: OwnerInput): Promise<OwnerRecord> { const existing = this.store.ownersBySubject.get(input.subject); if (existing) return clone(this.store.owners.find((x) => x.ownerId === existing)!); const record = { ownerId: input.ownerId ?? this.id("owner"), subject: input.subject, displayName: input.displayName, createdAt: this.now() }; this.store.owners.push(record); this.store.ownersBySubject.set(record.subject, record.ownerId); return clone(record); }
  async createVm(input: VmInput): Promise<VmRecord> { this.requireOwner(input.ownerId); if (this.store.vms.some((x) => x.vmId === input.vmId)) throw new StateConflictError("VM already exists"); const record = { vmId: input.vmId ?? this.id("vm"), ownerId: input.ownerId, name: input.name, createdAt: this.now() }; this.store.vms.push(record); return clone(record); }
  async listVms(ownerId: string): Promise<VmRecord[]> { this.requireOwner(ownerId); return clone(this.store.vms.filter((x) => x.ownerId === ownerId && !x.revokedAt)); }
  async issueChannelGrant(input: ChannelGrantInput): Promise<ChannelGrantRecord> { this.requireVm(input.ownerId, input.vmId); const existing = this.store.channels.find((x) => x.channelId === input.channelId); if (existing) throw new StateConflictError("channel already exists"); const record = { channelId: input.channelId ?? this.id("channel"), ownerId: input.ownerId, vmId: input.vmId, tokenHash: hash(input.token), epoch: input.epoch ?? 1, expiresAt: input.expiresAt ?? this.now() + 86_400_000 }; this.store.channels.push(record); return clone(record); }
  async rotateChannelGrant(channelId: string, expectedEpoch: number): Promise<ChannelGrantRecord> { const record = this.channel(channelId); this.assertLiveChannel(record); if (record.epoch !== expectedEpoch) throw new StateConflictError("stale channel epoch"); record.epoch++; record.tokenHash = hash(this.id("channel_token")); return clone(record); }
  async revokeChannel(channelId: string): Promise<void> { const record = this.channel(channelId); record.revokedAt = this.now(); }
  async validateChannelGrant(input: { channelId: string; token: string; vmId: string; epoch: number }): Promise<ChannelGrantRecord> { const record = this.channel(input.channelId); this.assertLiveChannel(record); if (record.vmId !== input.vmId || record.epoch !== input.epoch || record.tokenHash !== hash(input.token)) throw new StateUnauthorizedError("channel grant is stale, revoked, or VM-bound"); return clone(record); }
  async enqueueRequest(input: RequestFrameInput): Promise<RequestFrameRecord> { this.requireVm(input.ownerId, input.vmId); const payloadHash = hash(JSON.stringify(input.payload)); const dedupeKey = input.mutationId ? `${input.vmId}:${input.operation}:${input.mutationId}` : undefined; if (this.store.requestById.has(input.requestId)) { const old = this.request(input.requestId); if (old.payloadHash !== payloadHash) throw new StateConflictError("request id conflicts with payload"); return clone(old); } if (dedupeKey && this.store.dedupe.has(dedupeKey)) { const old = this.request(this.store.dedupe.get(dedupeKey)!.requestId); if (old.payloadHash !== payloadHash) throw new StateConflictError("mutation id conflicts with payload"); return clone(old); } const record: RequestFrameRecord = { ...input, mutationId: input.mutationId ?? null, frameId: this.id("frame"), payloadHash, status: "queued", createdAt: this.now() }; this.store.requests.push(record); this.store.requestById.set(input.requestId, record.frameId); if (dedupeKey) this.store.dedupe.set(dedupeKey, { payloadHash, requestId: input.requestId }); return clone(record); }
  async claimRequests(input: ClaimInput): Promise<RequestFrameRecord[]> { const now = this.now(); const leaseMs = input.leaseMs ?? 30_000; const limit = input.limit ?? 20; const available = this.store.requests.filter((record) => (!input.ownerId || record.ownerId === input.ownerId) && (!input.vmId || record.vmId === input.vmId) && (record.status === "queued" || (record.status === "leased" && (record.leaseExpiresAt ?? 0) <= now))).slice(0, limit); for (const record of available) { record.status = "leased"; record.leaseOwner = input.leaseOwner; record.leaseExpiresAt = now + leaseMs; } return clone(available); }
  async recordResponse(input: ResponseFrameInput): Promise<ResponseFrameRecord> { const request = this.request(input.requestId); const existing = this.store.responses.find((x) => x.requestId === input.requestId); const responseHash = hash(JSON.stringify(input.response)); if (existing) { if (existing.responseHash !== responseHash) throw new StateConflictError("response conflicts with recorded response"); return clone(existing); } if (request.status === "leased" && (request.leaseOwner !== input.leaseOwner || (request.leaseExpiresAt ?? 0) <= this.now())) throw new StateConflictError("request lease is not owned or has expired"); request.status = "completed"; request.leaseOwner = undefined; request.leaseExpiresAt = undefined; const record = { requestId: input.requestId, response: input.response, responseHash, recordedAt: this.now() }; this.store.responses.push(record); return clone(record); }
  async getResponse(requestId: string): Promise<ResponseFrameRecord | undefined> { const record = this.store.responses.find((x) => x.requestId === requestId); return record && clone(record); }
  async ackRequest(requestId: string, leaseOwner: string): Promise<void> { const request = this.request(requestId); if (request.status !== "leased" || request.leaseOwner !== leaseOwner || (request.leaseExpiresAt ?? 0) <= this.now()) throw new StateConflictError("request lease is not owned"); request.status = "completed"; request.leaseOwner = undefined; request.leaseExpiresAt = undefined; }
  async createAuthorizationCode(input: AuthorizationCodeInput): Promise<AuthorizationCodeRecord> { this.requireVm(input.ownerId, input.vmId); const code = this.id("code"); const record = { ...input, code, codeHash: hash(code), expiresAt: input.expiresAt ?? this.now() + 300_000 }; this.store.authCodes.set(record.codeHash, record); return clone(record); }
  async consumeAuthorizationCode(code: string, verifier: string): Promise<AuthorizationCodeRecord> { const record = this.store.authCodes.get(hash(code)); if (!record || record.usedAt || record.expiresAt <= this.now() || hash(verifier) !== record.codeChallenge) throw new StateUnauthorizedError("authorization code invalid, expired, or already used"); record.usedAt = this.now(); return clone(record); }
  async issueOAuthTokens(input: OAuthTokenInput): Promise<OAuthTokenRecord> { this.requireVm(input.ownerId, input.vmId); const record = { ...input, scope: input.scope ?? "vm", familyId: input.familyId ?? this.id("family"), accessTokenHash: hash(input.accessToken), refreshTokenHash: hash(input.refreshToken) }; this.store.oauth.set(record.refreshTokenHash, record); return clone(record); }
  async rotateRefreshToken(refreshToken: string): Promise<OAuthTokenRecord> { const old = this.store.oauth.get(hash(refreshToken)); if (!old || old.revokedAt || this.store.revokedFamilies.has(old.familyId) || old.refreshExpiresAt <= this.now()) throw new StateUnauthorizedError("refresh token invalid or revoked"); if (old.refreshUsedAt) { this.store.revokedFamilies.add(old.familyId); throw new StateUnauthorizedError("refresh replay revoked family"); } old.refreshUsedAt = this.now(); const replacement = await this.issueOAuthTokens({ ownerId: old.ownerId, vmId: old.vmId, resource: old.resource, scope: old.scope, familyId: old.familyId, accessToken: this.id("access"), refreshToken: this.id("refresh"), accessExpiresAt: this.now() + 900_000, refreshExpiresAt: old.refreshExpiresAt }); old.replacementRefreshHash = replacement.refreshTokenHash; return clone(replacement); }
  async validateAccessToken(accessToken: string, resource: string, vmId?: string): Promise<AccessTokenRecord> { const tokenHash = hash(accessToken); const record = [...this.store.oauth.values()].find((x) => x.accessTokenHash === tokenHash); if (!record || record.revokedAt || this.store.revokedFamilies.has(record.familyId) || record.accessExpiresAt <= this.now()) throw new StateUnauthorizedError("access token invalid or expired"); if (record.resource !== resource) throw new StateUnauthorizedError("access token audience invalid"); if (vmId && record.vmId !== vmId) throw new StateUnauthorizedError("access token VM binding invalid"); return { ownerId: record.ownerId, vmId: record.vmId, resource: record.resource, scope: record.scope, familyId: record.familyId, accessExpiresAt: record.accessExpiresAt }; }
  async revokeOAuthFamily(familyId: string): Promise<void> { this.store.revokedFamilies.add(familyId); for (const record of this.store.oauth.values()) if (record.familyId === familyId) record.revokedAt = this.now(); }
  async appendAudit(input: AuditInput): Promise<AuditRecord> { const record = { ...input, auditId: this.id("audit"), at: this.now(), ...(input.metadata === undefined ? {} : { metadata: redact(input.metadata) }) }; this.store.audit.push(record); return clone(record); }
  async quota(input: QuotaInput): Promise<QuotaRecord> { const current = this.store.quotas.find((x) => x.ownerId === input.ownerId && x.bucket === input.bucket); const amount = input.amount ?? 0; const record = current ?? { ownerId: input.ownerId, bucket: input.bucket, used: 0, limit: input.limit, resetAt: this.now() + 86_400_000 }; if (record.used + amount > input.limit) throw new StateConflictError("quota exceeded"); record.used += amount; record.limit = input.limit; if (!current) this.store.quotas.push(record); return clone(record); }
  async snapshot(): Promise<StateSnapshot> { return clone({ owners: this.store.owners, vms: this.store.vms, channels: this.store.channels, requests: this.store.requests, responses: this.store.responses, audit: this.store.audit, quotas: this.store.quotas }); }
  private requireOwner(ownerId: string): OwnerRecord { const owner = this.store.owners.find((x) => x.ownerId === ownerId); if (!owner) throw new StateNotFoundError(`owner ${ownerId} not found`); return owner; }
  private requireVm(ownerId: string, vmId: string): VmRecord { this.requireOwner(ownerId); const vm = this.store.vms.find((x) => x.vmId === vmId && x.ownerId === ownerId && !x.revokedAt); if (!vm) throw new StateNotFoundError(`VM ${vmId} not found`); return vm; }
  private channel(channelId: string): ChannelGrantRecord { const record = this.store.channels.find((x) => x.channelId === channelId); if (!record) throw new StateNotFoundError(`channel ${channelId} not found`); return record; }
  private assertLiveChannel(record: ChannelGrantRecord): void { if (record.revokedAt || record.expiresAt <= this.now()) throw new StateUnauthorizedError("channel revoked or expired"); }
  private request(requestId: string): RequestFrameRecord { const record = this.store.requests.find((x) => x.requestId === requestId); if (!record) throw new StateNotFoundError(`request ${requestId} not found`); return record; }
}

/** Isolated local Convex-compatible deployment. Restart keeps committed state; close drops it. */
export class LocalConvexHarness {
  readonly deploymentId: string;
  readonly schemaVersion = 1;
  private repository?: InMemoryRelayStateRepository;
  private closed = false;
  private readonly options: LocalRepositoryOptions;
  private constructor(options: LocalRepositoryOptions = {}) { this.deploymentId = options.deploymentId ?? `convex_${randomBytes(6).toString("hex")}`; this.options = { ...options, deploymentId: this.deploymentId }; }
  static async start(options: LocalRepositoryOptions = {}): Promise<LocalConvexHarness> { const harness = new LocalConvexHarness(options); harness.repository = new InMemoryRelayStateRepository(harness.options); return harness; }
  async pushSchema(): Promise<{ deploymentId: string; version: number }> { this.assertOpen(); return { deploymentId: this.deploymentId, version: this.schemaVersion }; }
  client(): RelayStateRepository { this.assertOpen(); return this.repository!; }
  async restart(): Promise<RelayStateRepository> { this.assertOpen(); this.repository = new InMemoryRelayStateRepository({ ...this.options, store: (this.repository as any).store }); return this.repository; }
  async close(): Promise<void> { this.closed = true; this.repository = undefined; }
  private assertOpen(): void { if (this.closed || !this.repository) throw new StateConflictError("harness is closed"); }
}
export async function createLocalConvexHarness(options: LocalRepositoryOptions = {}): Promise<LocalConvexHarness> { return LocalConvexHarness.start(options); }
export const ConvexRelayStateRepository = InMemoryRelayStateRepository;

export const pkceChallenge = (verifier: string): string => hash(verifier);

export { relayStateSchema } from "../convex/schema.js";
