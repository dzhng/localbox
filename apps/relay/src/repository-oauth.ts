import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RelayStateRepository, OAuthTokenRecord } from "../../../packages/state/src/index.js";
import { OAuthError, type OAuthAuthorizationRequest, type OAuthToken } from "./oauth.js";

const opaque = (bytes = 32) => randomBytes(bytes).toString("base64url");
const pkce = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export interface RepositoryOAuthOptions {
  repository: RelayStateRepository;
  issuer: string;
  resource: string;
  ownerSubject: string;
  ownerId?: string;
  defaultVmId?: string;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  authorizationCodeTtlSeconds?: number;
  now?: () => number;
}

/** OAuth endpoints backed by RelayStateRepository. Raw tokens are returned once and only hashes are durable. */
export class RepositoryOAuthServer {
  readonly issuer: string;
  readonly resource: string;
  private readonly repository: RelayStateRepository;
  private readonly ownerSubject: string;
  private readonly ownerId?: string;
  private readonly defaultVmId?: string;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly codeTtl: number;
  private readonly now: () => number;

  constructor(options: RepositoryOAuthOptions) {
    this.issuer = options.issuer.replace(/\/$/, "");
    this.resource = options.resource;
    this.repository = options.repository;
    this.ownerSubject = options.ownerSubject;
    this.ownerId = options.ownerId;
    this.defaultVmId = options.defaultVmId;
    this.accessTtl = options.accessTokenTtlSeconds ?? 900;
    this.refreshTtl = options.refreshTokenTtlSeconds ?? 30 * 24 * 3600;
    this.codeTtl = options.authorizationCodeTtlSeconds ?? 300;
    this.now = options.now ?? (() => Date.now());
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return { resource: this.resource, authorization_servers: [this.issuer], bearer_methods_supported: ["header"], scopes_supported: ["vm"] };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return { issuer: this.issuer, authorization_endpoint: `${this.issuer}/oauth/authorize`, token_endpoint: `${this.issuer}/oauth/token`, revocation_endpoint: `${this.issuer}/oauth/revoke`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["vm"] };
  }

  async authorize(request: OAuthAuthorizationRequest): Promise<{ code: string; state?: string; redirect_uri: string; vm_id: string }> {
    if (request.response_type !== "code" || !request.client_id || !request.redirect_uri || !request.code_challenge) throw new OAuthError("invalid_request", "response_type, client_id, redirect_uri, and code_challenge are required", 400);
    if (request.code_challenge_method && request.code_challenge_method !== "S256") throw new OAuthError("invalid_request", "only S256 PKCE is supported", 400);
    if (request.resource && request.resource !== this.resource) throw new OAuthError("invalid_target", "resource does not match this server", 400);
    try { new URL(request.redirect_uri); } catch { throw new OAuthError("invalid_request", "redirect_uri must be an absolute URL", 400); }
    const owner = await this.repository.createOwner({ ownerId: this.ownerId, subject: this.ownerSubject });
    let vms = await this.repository.listVms(owner.ownerId);
    if (vms.length === 0 && this.defaultVmId) {
      await this.repository.createVm({ ownerId: owner.ownerId, vmId: this.defaultVmId, name: "Default VM" });
      vms = await this.repository.listVms(owner.ownerId);
    }
    const vmId = request.vm_id ?? this.defaultVmId ?? vms[0]?.vmId;
    if (!vmId || !vms.some((vm) => vm.vmId === vmId)) throw new OAuthError("invalid_target", "selected VM is not available to this owner", 400);
    const code = opaque(24);
    await this.repository.createAuthorizationCode({ ownerId: owner.ownerId, clientId: request.client_id, redirectUri: request.redirect_uri, resource: this.resource, vmId, codeChallenge: request.code_challenge, code, scope: request.scope ?? "vm", expiresAt: this.now() + this.codeTtl * 1000 });
    return { code, state: request.state, redirect_uri: request.redirect_uri, vm_id: vmId };
  }

  async token(input: { grant_type: "authorization_code" | "refresh_token"; code?: string; refresh_token?: string; client_id?: string; redirect_uri?: string; code_verifier?: string; resource?: string }): Promise<OAuthToken> {
    if (input.resource && input.resource !== this.resource) throw new OAuthError("invalid_target", "resource does not match this server", 400);
    if (input.grant_type === "authorization_code") {
      if (!input.code || !input.client_id || !input.redirect_uri || !input.code_verifier) throw new OAuthError("invalid_request", "code, client_id, redirect_uri, and code_verifier are required", 400);
      const owner = await this.repository.createOwner({ ownerId: this.ownerId, subject: this.ownerSubject });
      let code;
      try { code = await this.repository.consumeAuthorizationCode(input.code, input.code_verifier); } catch { throw new OAuthError("invalid_grant", "authorization code is invalid, expired, or already used", 400); }
      if (code.ownerId !== owner.ownerId || code.clientId !== input.client_id || code.redirectUri !== input.redirect_uri || code.resource !== this.resource) throw new OAuthError("invalid_grant", "authorization code client binding failed", 400);
      const expected = Buffer.from(pkce(input.code_verifier)); const actual = Buffer.from(code.codeChallenge);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new OAuthError("invalid_grant", "PKCE verification failed", 400);
      return this.issueTokens(code.ownerId, code.vmId, code.scope ?? "vm");
    }
    if (input.grant_type === "refresh_token") {
      if (!input.refresh_token) throw new OAuthError("invalid_request", "refresh_token is required", 400);
      let rotated: OAuthTokenRecord;
      try { rotated = await this.repository.rotateRefreshToken(input.refresh_token); } catch { throw new OAuthError("invalid_grant", "refresh token is invalid or revoked", 400); }
      if (!rotated.accessToken || !rotated.refreshToken) throw new OAuthError("server_error", "refresh token rotation did not return token material", 500);
      return { access_token: rotated.accessToken, token_type: "Bearer", expires_in: Math.max(0, Math.floor((rotated.accessExpiresAt - this.now()) / 1000)), refresh_token: rotated.refreshToken, scope: rotated.scope, vm_id: rotated.vmId, resource: rotated.resource };
    }
    throw new OAuthError("unsupported_grant_type", "unsupported grant type", 400);
  }

  async revoke(token: string | undefined, hint?: "access_token" | "refresh_token"): Promise<void> { if (token) await this.repository.revokeOAuthToken(token, hint); }

  async validateAccessToken(token: string | undefined): Promise<{ account_id: string; vm_id: string; scope: string; expires_at: number; family: string }> {
    if (!token) throw new OAuthError("invalid_token", "access token is invalid or expired", 401);
    try {
      const record = await this.repository.validateAccessToken(token, this.resource);
      return { account_id: record.ownerId, vm_id: record.vmId, scope: record.scope, expires_at: record.accessExpiresAt, family: record.familyId };
    } catch { throw new OAuthError("invalid_token", "access token is invalid or expired", 401); }
  }

  private async issueTokens(ownerId: string, vmId: string, scope: string): Promise<OAuthToken> {
    const accessToken = opaque(); const refreshToken = opaque(); const now = this.now();
    await this.repository.issueOAuthTokens({ ownerId, vmId, resource: this.resource, scope, accessToken, refreshToken, accessExpiresAt: now + this.accessTtl * 1000, refreshExpiresAt: now + this.refreshTtl * 1000 });
    return { access_token: accessToken, token_type: "Bearer", expires_in: this.accessTtl, refresh_token: refreshToken, scope, vm_id: vmId, resource: this.resource };
  }
}

export function oauthRedirect(result: { code: string; state?: string; redirect_uri: string }): string {
  const redirect = new URL(result.redirect_uri); redirect.searchParams.set("code", result.code); if (result.state) redirect.searchParams.set("state", result.state); return redirect.toString();
}

export function oauthErrorResponse(error: unknown): Response {
  const value = error instanceof OAuthError ? error : new OAuthError("server_error", "OAuth server error", 500);
  return new Response(JSON.stringify({ error: value.code, error_description: value.message }), { status: value.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

