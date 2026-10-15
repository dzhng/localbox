import { createHash, randomBytes } from "node:crypto";
import { makeFunctionReference } from "convex/server";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Clock { now(): number }
export interface IdFactory { next(prefix: string): string }
export interface RelayStateRepository {
  readonly deploymentId: string;
  createOwner(input: OwnerInput): Promise<OwnerRecord>;
  createVm(input: VmInput): Promise<VmRecord>;
  listVms(ownerId: string): Promise<VmRecord[]>;
  createAuthorizationCode(input: AuthorizationCodeInput): Promise<AuthorizationCodeRecord>;
  consumeAuthorizationCode(code: string, verifier: string): Promise<AuthorizationCodeRecord>;
  issueOAuthTokens(input: OAuthTokenInput): Promise<OAuthTokenRecord>;
  rotateRefreshToken(refreshToken: string): Promise<OAuthTokenRecord>;
  revokeOAuthToken(token: string, hint?: "access_token" | "refresh_token"): Promise<void>;
  validateAccessToken(accessToken: string, resource: string, vmId?: string): Promise<AccessTokenRecord>;
  revokeOAuthFamily(familyId: string): Promise<void>;
  appendAudit(input: AuditInput): Promise<AuditRecord>;
  quota(input: QuotaInput): Promise<QuotaRecord>;
}

export interface OwnerInput { ownerId?: string; subject: string; displayName?: string }
export interface OwnerRecord { ownerId: string; subject: string; displayName?: string; createdAt: number }
export interface VmInput { ownerId: string; vmId?: string; name?: string }
export interface VmRecord { vmId: string; ownerId: string; name?: string; createdAt: number; revokedAt?: number }
export interface AuthorizationCodeInput { ownerId: string; clientId: string; redirectUri: string; resource: string; vmId: string; codeChallenge: string; code?: string; expiresAt?: number; scope?: string }
export interface AuthorizationCodeRecord extends AuthorizationCodeInput { code: string; codeHash: string; expiresAt: number; usedAt?: number }
export interface OAuthTokenInput { ownerId: string; vmId: string; resource: string; scope?: string; familyId?: string; accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number }
export interface OAuthTokenRecord { ownerId: string; vmId: string; resource: string; scope: string; familyId: string; accessTokenHash: string; refreshTokenHash: string; accessExpiresAt: number; refreshExpiresAt: number; refreshUsedAt?: number; replacementRefreshHash?: string; revokedAt?: number; accessToken?: string; refreshToken?: string }
export interface AccessTokenRecord { ownerId: string; vmId: string; resource: string; scope: string; familyId: string; accessExpiresAt: number }
export interface AuditInput { ownerId?: string; vmId?: string; requestId?: string; operation: string; outcome: "success" | "error"; code?: string; metadata?: Json }
export interface AuditRecord extends AuditInput { auditId: string; at: number; metadata?: Json }
export interface QuotaInput { ownerId: string; bucket: string; limit: number; amount?: number }
export interface QuotaRecord { ownerId: string; bucket: string; used: number; limit: number; resetAt: number }
/** The in-memory repository's row tables; OAuth codes and tokens stay hashed in private maps. */
export interface StateSnapshot { owners: OwnerRecord[]; vms: VmRecord[]; audit: AuditRecord[]; quotas: QuotaRecord[] }

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
    this.store = options.store ?? { deploymentId: this.deploymentId, owners: [], vms: [], audit: [], quotas: [], authCodes: new Map(), oauth: new Map(), revokedFamilies: new Set(), ownersBySubject: new Map() };
  }
  async createOwner(input: OwnerInput): Promise<OwnerRecord> { const existing = this.store.ownersBySubject.get(input.subject); if (existing) return clone(this.store.owners.find((x) => x.ownerId === existing)!); const record = { ownerId: input.ownerId ?? this.id("owner"), subject: input.subject, displayName: input.displayName, createdAt: this.now() }; this.store.owners.push(record); this.store.ownersBySubject.set(record.subject, record.ownerId); return clone(record); }
  async createVm(input: VmInput): Promise<VmRecord> { this.requireOwner(input.ownerId); if (this.store.vms.some((x) => x.vmId === input.vmId)) throw new StateConflictError("VM already exists"); const record = { vmId: input.vmId ?? this.id("vm"), ownerId: input.ownerId, name: input.name, createdAt: this.now() }; this.store.vms.push(record); return clone(record); }
  async listVms(ownerId: string): Promise<VmRecord[]> { this.requireOwner(ownerId); return clone(this.store.vms.filter((x) => x.ownerId === ownerId && !x.revokedAt)); }
  async createAuthorizationCode(input: AuthorizationCodeInput): Promise<AuthorizationCodeRecord> { this.requireVm(input.ownerId, input.vmId); const code = input.code ?? this.id("code"); const record = { ...input, code, codeHash: hash(code), expiresAt: input.expiresAt ?? this.now() + 300_000 }; this.store.authCodes.set(record.codeHash, record); return clone(record); }
  async consumeAuthorizationCode(code: string, verifier: string): Promise<AuthorizationCodeRecord> { const record = this.store.authCodes.get(hash(code)); const standardChallenge = createHash("sha256").update(verifier).digest("base64url"); if (!record || record.usedAt || record.expiresAt <= this.now() || (hash(verifier) !== record.codeChallenge && standardChallenge !== record.codeChallenge)) throw new StateUnauthorizedError("authorization code invalid, expired, or already used"); record.usedAt = this.now(); return clone(record); }
  async issueOAuthTokens(input: OAuthTokenInput): Promise<OAuthTokenRecord> { this.requireVm(input.ownerId, input.vmId); const record = { ...input, scope: input.scope ?? "vm", familyId: input.familyId ?? this.id("family"), accessTokenHash: hash(input.accessToken), refreshTokenHash: hash(input.refreshToken) }; this.store.oauth.set(record.refreshTokenHash, record); return clone(record); }
  async rotateRefreshToken(refreshToken: string): Promise<OAuthTokenRecord> { const old = this.store.oauth.get(hash(refreshToken)); if (!old || old.revokedAt || this.store.revokedFamilies.has(old.familyId) || old.refreshExpiresAt <= this.now()) throw new StateUnauthorizedError("refresh token invalid or revoked"); if (old.refreshUsedAt) { this.store.revokedFamilies.add(old.familyId); throw new StateUnauthorizedError("refresh replay revoked family"); } old.refreshUsedAt = this.now(); const accessToken = this.id("access"); const nextRefreshToken = this.id("refresh"); const replacement = await this.issueOAuthTokens({ ownerId: old.ownerId, vmId: old.vmId, resource: old.resource, scope: old.scope, familyId: old.familyId, accessToken, refreshToken: nextRefreshToken, accessExpiresAt: this.now() + 900_000, refreshExpiresAt: old.refreshExpiresAt }); old.replacementRefreshHash = replacement.refreshTokenHash; return clone({ ...replacement, accessToken, refreshToken: nextRefreshToken }); }
  async validateAccessToken(accessToken: string, resource: string, vmId?: string): Promise<AccessTokenRecord> { const tokenHash = hash(accessToken); const record = [...this.store.oauth.values()].find((x) => x.accessTokenHash === tokenHash); if (!record || record.revokedAt || this.store.revokedFamilies.has(record.familyId) || record.accessExpiresAt <= this.now()) throw new StateUnauthorizedError("access token invalid or expired"); if (record.resource !== resource) throw new StateUnauthorizedError("access token audience invalid"); if (vmId && record.vmId !== vmId) throw new StateUnauthorizedError("access token VM binding invalid"); return { ownerId: record.ownerId, vmId: record.vmId, resource: record.resource, scope: record.scope, familyId: record.familyId, accessExpiresAt: record.accessExpiresAt }; }
  async revokeOAuthFamily(familyId: string): Promise<void> { this.store.revokedFamilies.add(familyId); for (const record of this.store.oauth.values()) if (record.familyId === familyId) record.revokedAt = this.now(); }
  async revokeOAuthToken(token: string, hint?: "access_token" | "refresh_token"): Promise<void> { const digest = hash(token); const record = [...this.store.oauth.values()].find((candidate) => (hint === "refresh_token" ? candidate.refreshTokenHash === digest : hint === "access_token" ? candidate.accessTokenHash === digest : candidate.accessTokenHash === digest || candidate.refreshTokenHash === digest)); if (record) await this.revokeOAuthFamily(record.familyId); }
  async appendAudit(input: AuditInput): Promise<AuditRecord> { const record = { ...input, auditId: this.id("audit"), at: this.now(), ...(input.metadata === undefined ? {} : { metadata: redact(input.metadata) }) }; this.store.audit.push(record); return clone(record); }
  async quota(input: QuotaInput): Promise<QuotaRecord> { const current = this.store.quotas.find((x) => x.ownerId === input.ownerId && x.bucket === input.bucket); const amount = input.amount ?? 0; const record = current ?? { ownerId: input.ownerId, bucket: input.bucket, used: 0, limit: input.limit, resetAt: this.now() + 86_400_000 }; if (record.used + amount > input.limit) throw new StateConflictError("quota exceeded"); record.used += amount; record.limit = input.limit; if (!current) this.store.quotas.push(record); return clone(record); }
  async snapshot(): Promise<StateSnapshot> { return clone({ owners: this.store.owners, vms: this.store.vms, audit: this.store.audit, quotas: this.store.quotas }); }
  private requireOwner(ownerId: string): OwnerRecord { const owner = this.store.owners.find((x) => x.ownerId === ownerId); if (!owner) throw new StateNotFoundError(`owner ${ownerId} not found`); return owner; }
  private requireVm(ownerId: string, vmId: string): VmRecord { this.requireOwner(ownerId); const vm = this.store.vms.find((x) => x.vmId === vmId && x.ownerId === ownerId && !x.revokedAt); if (!vm) throw new StateNotFoundError(`VM ${vmId} not found`); return vm; }
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
  /** Whole-store view for tests; deployed Convex dumps every table only through the internal `snapshots:get`. */
  snapshot(): Promise<StateSnapshot> { this.assertOpen(); return this.repository!.snapshot(); }
  async restart(): Promise<RelayStateRepository> { this.assertOpen(); this.repository = new InMemoryRelayStateRepository({ ...this.options, store: (this.repository as any).store }); return this.repository; }
  async close(): Promise<void> { this.closed = true; this.repository = undefined; }
  private assertOpen(): void { if (this.closed || !this.repository) throw new StateConflictError("harness is closed"); }
}
export async function createLocalConvexHarness(options: LocalRepositoryOptions = {}): Promise<LocalConvexHarness> { return LocalConvexHarness.start(options); }
/** Minimal Convex client surface. ConvexHttpClient and convex-test both satisfy it. */
export interface ConvexFunctionClient {
  mutation(name: any, args: Record<string, unknown> | object): Promise<unknown>;
  query(name: any, args: Record<string, unknown> | object): Promise<unknown>;
}

/** Production repository adapter backed by typed authenticated Convex functions. */
export class ConvexRelayStateRepository implements RelayStateRepository {
  constructor(private readonly client: ConvexFunctionClient, readonly deploymentId = "convex", private readonly refreshAuth?: () => string) {}
  private async call<T>(kind: "mutation" | "query", name: string, args: Record<string, unknown> | object): Promise<T> {
    if (this.refreshAuth && typeof (this.client as any).setAuth === "function") (this.client as any).setAuth(this.refreshAuth());
    const ref = makeFunctionReference(name) as any;
    return await this.client[kind](ref, args) as T;
  }
  createOwner(input: OwnerInput) { return this.call<OwnerRecord>("mutation", "owners:create", input); }
  createVm(input: VmInput) { return this.call<VmRecord>("mutation", "vms:create", input); }
  listVms(ownerId: string) { return this.call<VmRecord[]>("query", "vms:list", { ownerId }); }
  createAuthorizationCode(input: AuthorizationCodeInput) { return this.call<AuthorizationCodeRecord>("mutation", "authCodes:create", input); }
  consumeAuthorizationCode(code: string, verifier: string) { return this.call<AuthorizationCodeRecord>("mutation", "authCodes:consume", { code, verifier }); }
  issueOAuthTokens(input: OAuthTokenInput) { return this.call<OAuthTokenRecord>("mutation", "oauth:issue", input); }
  async rotateRefreshToken(refreshToken: string): Promise<OAuthTokenRecord> {
    const result = await this.call<OAuthTokenRecord | { __error?: string }>("mutation", "oauth:rotateRefresh", { refreshToken });
    if (result && typeof result === "object" && (result as { __error?: string }).__error === "refresh_replay_revoked_family") throw new StateUnauthorizedError("refresh replay revoked family");
    return result as OAuthTokenRecord;
  }
  async revokeOAuthToken(token: string, hint?: "access_token" | "refresh_token") { await this.call("mutation", "oauth:revokeToken", { token, hint }); }
  validateAccessToken(accessToken: string, resource: string, vmId?: string) { return this.call<AccessTokenRecord>("query", "oauth:validateAccess", { accessToken, resource, vmId }); }
  async revokeOAuthFamily(familyId: string) { await this.call("mutation", "oauth:revokeFamily", { familyId }); }
  appendAudit(input: AuditInput) { return this.call<AuditRecord>("mutation", "audit:append", input); }
  quota(input: QuotaInput) { return this.call<QuotaRecord>("mutation", "quotas:consume", input); }
}

export const pkceChallenge = (verifier: string): string => hash(verifier);

export { relayStateSchema } from "../convex/schema.js";
export { createConvexTestHarness } from "../test-harness.js";
