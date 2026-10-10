import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export interface OAuthVm { vm_id: string; name?: string }
export interface OAuthAccount { account_id: string; vms: OAuthVm[]; default_vm_id?: string }
export interface OAuthServerOptions {
  issuer?: string;
  resource?: string;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  authorizationCodeTtlSeconds?: number;
  refreshReplayGraceSeconds?: number;
  accounts?: OAuthAccount[];
  now?: () => number;
}
export interface OAuthAuthorizationRequest {
  response_type: "code";
  client_id: string;
  redirect_uri: string;
  scope?: string;
  state?: string;
  code_challenge: string;
  code_challenge_method?: "S256";
  resource?: string;
  vm_id?: string;
  account_id?: string;
}
export interface OAuthToken {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
  vm_id: string;
  resource: string;
}
interface CodeRecord { code: string; request: OAuthAuthorizationRequest; account: OAuthAccount; vmId: string; expiresAt: number; used: boolean }
interface RefreshRecord { token: string; family: string; accountId: string; vmId: string; scope: string; resource: string; expiresAt: number; usedAt?: number; replacement?: string; revoked: boolean }
interface AccessRecord { token: string; accountId: string; vmId: string; scope: string; resource: string; expiresAt: number; family: string; revoked: boolean }

const b64url = (bytes: Buffer) => bytes.toString("base64url");
const opaque = (bytes = 32) => b64url(randomBytes(bytes));
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** VM-scoped, in-memory OAuth authorization server for relay fixtures and local development. */
export class OAuthAuthorizationServer {
  readonly issuer: string;
  readonly resource: string;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly codeTtl: number;
  private readonly replayGrace: number;
  private readonly clock: () => number;
  private readonly accounts = new Map<string, OAuthAccount>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly refresh = new Map<string, RefreshRecord>();
  private readonly access = new Map<string, AccessRecord>();
  private readonly revokedFamilies = new Set<string>();
  private readonly issuedRefreshTokens = new Map<string, OAuthToken>();

  constructor(options: OAuthServerOptions = {}) {
    this.issuer = (options.issuer ?? "https://relay.example.test").replace(/\/$/, "");
    this.resource = options.resource ?? `${this.issuer}/mcp`;
    this.accessTtl = options.accessTokenTtlSeconds ?? 900;
    this.refreshTtl = options.refreshTokenTtlSeconds ?? 30 * 24 * 3600;
    this.codeTtl = options.authorizationCodeTtlSeconds ?? 300;
    this.replayGrace = options.refreshReplayGraceSeconds ?? 5;
    this.clock = options.now ?? nowSeconds;
    for (const account of options.accounts ?? [{ account_id: "account_fixture", vms: [{ vm_id: "vm_01", name: "Default VM" }, { vm_id: "vm_02", name: "Second VM" }], default_vm_id: "vm_01" }]) this.addAccount(account);
  }

  addAccount(account: OAuthAccount): void {
    if (!account.account_id || account.vms.length === 0) throw new TypeError("account must have an id and at least one VM");
    const defaultVm = account.default_vm_id && account.vms.some((vm) => vm.vm_id === account.default_vm_id) ? account.default_vm_id : account.vms[0].vm_id;
    this.accounts.set(account.account_id, { ...account, default_vm_id: defaultVm, vms: account.vms.map((vm) => ({ ...vm })) });
  }
  protectedResourceMetadata(): Record<string, unknown> {
    return { resource: this.resource, authorization_servers: [this.issuer], bearer_methods_supported: ["header"], scopes_supported: ["vm"], resource_documentation: `${this.issuer}/docs` };
  }
  authorizationServerMetadata(): Record<string, unknown> {
    return { issuer: this.issuer, authorization_endpoint: `${this.issuer}/oauth/authorize`, token_endpoint: `${this.issuer}/oauth/token`, revocation_endpoint: `${this.issuer}/oauth/revoke`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["vm"] };
  }
  account(accountId = "account_fixture"): OAuthAccount {
    const account = this.accounts.get(accountId); if (!account) throw new OAuthError("invalid_request", "unknown account", 400); return { ...account, vms: account.vms.map((vm) => ({ ...vm })) };
  }
  authorize(request: OAuthAuthorizationRequest): { code: string; state?: string; redirect_uri: string; vm_id: string } {
    if (request.response_type !== "code" || !request.client_id || !request.redirect_uri || !request.code_challenge) throw new OAuthError("invalid_request", "response_type, client_id, redirect_uri, and code_challenge are required", 400);
    if (request.code_challenge_method && request.code_challenge_method !== "S256") throw new OAuthError("invalid_request", "only S256 PKCE is supported", 400);
    if (request.resource && request.resource !== this.resource) throw new OAuthError("invalid_target", "resource does not match this server", 400);
    const account = this.account(request.account_id);
    const vmId = request.vm_id ?? account.default_vm_id!;
    if (!account.vms.some((vm) => vm.vm_id === vmId)) throw new OAuthError("invalid_target", "selected VM is not available to this account", 400);
    const code = opaque(24);
    this.codes.set(code, { code, request, account, vmId, expiresAt: this.clock() + this.codeTtl, used: false });
    return { code, state: request.state, redirect_uri: request.redirect_uri, vm_id: vmId };
  }
  token(input: { grant_type: "authorization_code" | "refresh_token"; code?: string; refresh_token?: string; client_id?: string; redirect_uri?: string; code_verifier?: string; resource?: string }): OAuthToken {
    if (input.resource && input.resource !== this.resource) throw new OAuthError("invalid_target", "resource does not match this server", 400);
    if (input.grant_type === "authorization_code") return this.exchangeCode(input);
    if (input.grant_type === "refresh_token") return this.exchangeRefresh(input.refresh_token);
    throw new OAuthError("unsupported_grant_type", "unsupported grant type", 400);
  }
  private exchangeCode(input: { code?: string; redirect_uri?: string; code_verifier?: string; client_id?: string }): OAuthToken {
    const record = input.code ? this.codes.get(input.code) : undefined;
    if (!record || record.used || record.expiresAt <= this.clock()) throw new OAuthError("invalid_grant", "authorization code is invalid or expired", 400);
    if (record.request.client_id !== input.client_id || record.request.redirect_uri !== input.redirect_uri || !input.code_verifier) throw new OAuthError("invalid_grant", "authorization code client binding failed", 400);
    const expected = createHash("sha256").update(input.code_verifier).digest("base64url");
    const left = Buffer.from(expected); const right = Buffer.from(record.request.code_challenge);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new OAuthError("invalid_grant", "PKCE verification failed", 400);
    record.used = true;
    return this.issueTokens(record.account.account_id, record.vmId, record.request.scope ?? "vm", this.resource);
  }
  private issueTokens(accountId: string, vmId: string, scope: string, resource: string, family: string = randomUUID()): OAuthToken {
    const accessToken = opaque(); const refreshToken = opaque(); const now = this.clock();
    this.access.set(accessToken, { token: accessToken, accountId, vmId, scope, resource, expiresAt: now + this.accessTtl, family, revoked: false });
    this.refresh.set(refreshToken, { token: refreshToken, family, accountId, vmId, scope, resource, expiresAt: now + this.refreshTtl, revoked: false });
    const token = { access_token: accessToken, token_type: "Bearer" as const, expires_in: this.accessTtl, refresh_token: refreshToken, scope, vm_id: vmId, resource };
    this.issuedRefreshTokens.set(refreshToken, token);
    return token;
  }
  private exchangeRefresh(token?: string): OAuthToken {
    const record = token ? this.refresh.get(token) : undefined;
    if (!record || record.expiresAt <= this.clock() || record.revoked || this.revokedFamilies.has(record.family)) throw new OAuthError("invalid_grant", "refresh token is invalid or revoked", 400);
    if (record.usedAt !== undefined) {
      if (record.replacement && this.clock() - record.usedAt <= this.replayGrace) {
        const replacement = this.refresh.get(record.replacement); if (replacement && !replacement.revoked) return this.issuedRefreshTokens.get(replacement.token) ?? this.issueTokens(replacement.accountId, replacement.vmId, replacement.scope, replacement.resource, replacement.family);
      }
      this.revokeFamily(record.family); throw new OAuthError("invalid_grant", "refresh token replay revoked the token family", 400);
    }
    record.usedAt = this.clock();
    const issued = this.issueTokens(record.accountId, record.vmId, record.scope, record.resource, record.family);
    record.replacement = issued.refresh_token;
    return issued;
  }
  validateAccessToken(token: string | undefined, resource = this.resource, vmId?: string): { account_id: string; vm_id: string; scope: string; expires_at: number; family: string } {
    const record = token ? this.access.get(token) : undefined;
    if (!record || record.revoked || this.revokedFamilies.has(record.family) || record.expiresAt <= this.clock()) throw new OAuthError("invalid_token", "access token is invalid or expired", 401);
    if (record.resource !== resource) throw new OAuthError("invalid_target", "access token audience is invalid", 403);
    if (vmId && record.vmId !== vmId) throw new OAuthError("forbidden", "access token is bound to another VM", 403);
    return { account_id: record.accountId, vm_id: record.vmId, scope: record.scope, expires_at: record.expiresAt, family: record.family };
  }
  revoke(token: string | undefined, hint?: "access_token" | "refresh_token"): void {
    if (!token) return;
    const access = this.access.get(token); if (access && (!hint || hint === "access_token")) { this.revokeFamily(access.family); return; }
    const refresh = this.refresh.get(token); if (refresh) this.revokeFamily(refresh.family);
  }
  revokeFamily(family: string): void { this.revokedFamilies.add(family); for (const token of this.access.values()) if (token.family === family) token.revoked = true; for (const token of this.refresh.values()) if (token.family === family) token.revoked = true; }
  /** Minimal endpoint router useful for relay fixtures. */
  async handle(request: { method: string; url: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    const url = new URL(request.url, this.issuer); const headers = { "content-type": "application/json" };
    try {
      if (request.method === "GET" && url.pathname.endsWith("/.well-known/oauth-protected-resource")) return { status: 200, headers, body: this.protectedResourceMetadata() };
      if (request.method === "GET" && url.pathname.endsWith("/.well-known/oauth-authorization-server")) return { status: 200, headers, body: this.authorizationServerMetadata() };
      const body = (request.body ?? {}) as Record<string, any>;
      if (request.method === "GET" && url.pathname.endsWith("/oauth/authorize")) {
        const input = Object.fromEntries(url.searchParams.entries()) as any;
        const result = this.authorize({ ...input, response_type: input.response_type ?? "code", code_challenge_method: input.code_challenge_method ?? "S256" });
        return { status: 200, headers, body: result };
      }
      if (request.method === "POST" && url.pathname.endsWith("/oauth/token")) return { status: 200, headers, body: this.token(body as any) };
      if (request.method === "POST" && url.pathname.endsWith("/oauth/revoke")) { this.revoke(body.token, body.token_type_hint); return { status: 200, headers, body: {} }; }
      return { status: 404, headers, body: { error: "not_found" } };
    } catch (error) { const e = error instanceof OAuthError ? error : new OAuthError("server_error", "OAuth server error", 500); return { status: e.status, headers, body: { error: e.code, error_description: e.message } }; }
  }
}
export class OAuthError extends Error { constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = "OAuthError"; } }
export function pkceChallenge(verifier: string): string { return createHash("sha256").update(verifier).digest("base64url"); }

export const InMemoryOAuthServer = OAuthAuthorizationServer;
export const OAuthServer = OAuthAuthorizationServer;
