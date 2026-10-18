import { randomBytes } from "node:crypto";
import type { AccessGrant, OAuthClientRecord, OAuthRepository } from "../../../packages/state/src/index.js";
import type { Mailer } from "../../../packages/mail/src/index.js";
import { validEmail } from "../../../packages/state/convex/lib/relay.js";
import { clientIp, convexCode, json } from "./http.js";
import { renderCodePage, renderEmailPage, renderErrorPage, type AuthorizeParams } from "./oauth-pages.js";

export class OAuthError extends Error { constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = "OAuthError"; } }
export interface OAuthToken { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: "account" }

export interface RepositoryOAuthOptions {
  repository: OAuthRepository;
  issuer: string;
  resource: string;
  mailer: () => Mailer;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  authorizationCodeTtlSeconds?: number;
}

const opaque = (bytes = 32) => randomBytes(bytes).toString("base64url");
const SCOPE = "account";
/** The OAuth request fields the authorize pages carry between steps. */
const CARRIED = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"] as const;
const pageHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'", "referrer-policy": "no-referrer" };
const html = (body: string, status = 200) => new Response(body, { status, headers: pageHeaders });

/** What the grant sentence names: the host for web and loopback redirects, `scheme://host` for an app's scheme. */
const redirectLabel = (value: string) => { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.host : `${url.protocol}//${url.host}`; };

/** Schemes a browser would run or read locally instead of handing to an app; never a redirect target. */
const UNSAFE_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:", "ws:", "wss:"]);

/**
 * Redirect rule: https; plain http only on the loopback host (CLI clients); or a native app's private-use scheme
 * (RFC 8252 §7.1, e.g. `cursor://…`, `vscode://…`), which only the registering app receives. Matching stays exact.
 */
export function redirectUriAllowed(value: string): boolean {
  let url: URL; try { url = new URL(value); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !UNSAFE_SCHEMES.has(url.protocol);
}

/**
 * Account-based OAuth for MCP clients: dynamic registration, an email-code authorize flow, PKCE S256 codes bound to
 * client, redirect and resource, and rotating refresh tokens whose replay revokes the family. State lives in Convex
 * (`OAuthRepository`); raw codes and tokens exist only in responses.
 */
export class RepositoryOAuthServer {
  readonly issuer: string;
  readonly resource: string;
  private readonly repository: OAuthRepository;
  private readonly mailer: () => Mailer;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly codeTtl: number;

  constructor(options: RepositoryOAuthOptions) {
    this.issuer = options.issuer.replace(/\/$/, "");
    this.resource = options.resource;
    this.repository = options.repository;
    this.mailer = options.mailer;
    this.accessTtl = options.accessTokenTtlSeconds ?? 900;
    this.refreshTtl = options.refreshTokenTtlSeconds ?? 30 * 24 * 3600;
    this.codeTtl = options.authorizationCodeTtlSeconds ?? 300;
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return { resource: this.resource, authorization_servers: [this.issuer], bearer_methods_supported: ["header"], scopes_supported: [SCOPE] };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return { issuer: this.issuer, authorization_endpoint: `${this.issuer}/oauth/authorize`, token_endpoint: `${this.issuer}/oauth/token`, registration_endpoint: `${this.issuer}/oauth/register`, revocation_endpoint: `${this.issuer}/oauth/revoke`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: [SCOPE] };
  }

  /** Routes the metadata and `/oauth/*` endpoints; undefined for any other path. */
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url); const path = url.pathname.replace(/\/$/, "");
    if (request.method === "GET" && path.endsWith("/.well-known/oauth-protected-resource")) return json(this.protectedResourceMetadata());
    if (request.method === "GET" && path.endsWith("/.well-known/oauth-authorization-server")) return json(this.authorizationServerMetadata());
    const endpoint = path.match(/\/oauth\/(register|authorize|token|revoke)$/)?.[1];
    if (!endpoint) return undefined;
    if (endpoint === "authorize") {
      if (request.method !== "GET" && request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "GET, POST" });
      try {
        if (request.method === "GET") return await this.authorizePage(Object.fromEntries(url.searchParams.entries()));
        return await this.authorizeSubmit(await formBody(request).catch(() => ({})), clientIp(request));
      } catch { return html(renderErrorPage("Something went wrong on our side. Try again in a minute."), 500); }
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    try {
      const input = await formBody(request);
      if (endpoint === "register") return json(await this.register(input, clientIp(request)), 201, { "cache-control": "no-store" });
      if (endpoint === "token") return json(await this.token(input), 200, { "cache-control": "no-store", pragma: "no-cache" });
      await this.revoke(typeof input.token === "string" ? input.token : undefined, input.token_type_hint === "access_token" || input.token_type_hint === "refresh_token" ? input.token_type_hint : undefined);
      return json({});
    } catch (error) { return oauthErrorResponse(error); }
  }

  /** RFC 7591 dynamic client registration. Clients are public (PKCE, no secret). */
  async register(input: Record<string, unknown>, ip: string): Promise<Record<string, unknown>> {
    const uris = input.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((uri) => typeof uri === "string" && uri.length <= 2048)) throw new OAuthError("invalid_redirect_uri", "redirect_uris must list 1 to 10 URLs", 400);
    const refused = (uris as string[]).find((uri) => !redirectUriAllowed(uri));
    if (refused) throw new OAuthError("invalid_redirect_uri", `redirect URIs must be https, http on 127.0.0.1 or localhost, or an app scheme: ${refused}`, 400);
    const name = typeof input.client_name === "string" ? input.client_name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) : "";
    const registered = await this.repository.registerClient({ clientName: name || "Unnamed app", redirectUris: uris as string[], ip });
    if ("limited" in registered) throw new OAuthError("too_many_requests", "too many client registrations from this address; try again later", 429);
    return { client_id: registered.clientId, client_id_issued_at: Math.floor(registered.createdAt / 1000), client_name: registered.clientName, redirect_uris: registered.redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: SCOPE };
  }

  /** Validates an authorize request; any failure is shown on a page, never redirected to an unverified URI. */
  private async checkAuthorize(params: Record<string, string>): Promise<{ client: OAuthClientRecord; carried: AuthorizeParams; redirectHost: string } | string> {
    const client = params.client_id ? await this.repository.client(params.client_id) : null;
    if (!client) return "This app isn't registered with Localbox.";
    if (!params.redirect_uri || !client.redirectUris.includes(params.redirect_uri)) return "The return address doesn't match the one this app registered.";
    if (params.response_type !== "code") return "Only the authorization code flow is supported.";
    if (params.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge ?? "")) return "The app must use PKCE with S256.";
    if (params.resource !== this.resource) return "The app asked for a different resource than this Localbox server.";
    if (params.scope && params.scope.split(" ").some((scope) => scope && scope !== SCOPE)) return `The only scope is "${SCOPE}".`;
    if ((params.state ?? "").length > 1024) return "The state parameter is too long.";
    const carried = Object.fromEntries(CARRIED.filter((key) => params[key] !== undefined).map((key) => [key, params[key]]));
    return { client, carried, redirectHost: redirectLabel(params.redirect_uri) };
  }

  private async authorizePage(params: Record<string, string>): Promise<Response> {
    const checked = await this.checkAuthorize(params); if (typeof checked === "string") return html(renderErrorPage(checked), 400);
    return html(renderEmailPage({ action: this.authorizeAction(), clientName: checked.client.clientName, redirectHost: checked.redirectHost, params: checked.carried }));
  }

  private async authorizeSubmit(form: Record<string, unknown>, ip: string): Promise<Response> {
    const fields = Object.fromEntries(Object.entries(form).filter(([, value]) => typeof value === "string")) as Record<string, string>;
    const checked = await this.checkAuthorize(fields); if (typeof checked === "string") return html(renderErrorPage(checked), 400);
    const base = { action: this.authorizeAction(), clientName: checked.client.clientName, redirectHost: checked.redirectHost, params: checked.carried };
    const email = (fields.email ?? "").trim().toLowerCase();
    if (fields.step === "email") {
      if (!validEmail(email)) return html(renderEmailPage({ ...base, email, error: "Enter a valid email address." }), 400);
      const started = await this.repository.startSignIn(email, ip);
      if (started.issued && started.code) {
        try { await this.mailer().sendCode({ to: email, code: started.code, idempotencyKey: `${email}:${started.code}` }); }
        catch { return html(renderEmailPage({ ...base, email, error: "We couldn't send the email. Try again in a minute." }), 502); }
      }
      // Rate-limited sends look the same as sent ones.
      return html(renderCodePage({ ...base, email }));
    }
    if (fields.step === "code") {
      if (!email) return html(renderEmailPage(base), 400);
      const code = (fields.code ?? "").replace(/\s+/g, "");
      if (!/^\d{6}$/.test(code)) return html(renderCodePage({ ...base, email, error: "Enter the 6-digit code from the email." }), 400);
      let verified;
      try { verified = await this.repository.verifyForAgent({ email, code, ip }); }
      catch (error) { if (convexCode(error) === "rate_limited") return html(renderCodePage({ ...base, email, error: "Too many attempts. Try again later." }), 429); throw error; }
      if (!verified.valid) return html(renderCodePage({ ...base, email, error: "That code is wrong or has expired." }), 400);
      const authorizationCode = opaque(32);
      await this.repository.createCode({ code: authorizationCode, accountId: verified.accountId, clientId: checked.client.clientId, redirectUri: fields.redirect_uri, resource: this.resource, codeChallenge: fields.code_challenge, expiresAt: Date.now() + this.codeTtl * 1000 });
      const redirect = new URL(fields.redirect_uri); redirect.searchParams.set("code", authorizationCode); if (fields.state) redirect.searchParams.set("state", fields.state);
      return new Response(null, { status: 302, headers: { location: redirect.toString(), "cache-control": "no-store" } });
    }
    return html(renderEmailPage(base), 400);
  }

  async token(input: Record<string, unknown>): Promise<OAuthToken> {
    const field = (name: string) => typeof input[name] === "string" ? input[name] as string : undefined;
    if (field("resource") !== undefined && field("resource") !== this.resource) throw new OAuthError("invalid_target", "resource does not match this server", 400);
    if (field("scope") && field("scope")!.split(" ").some((scope) => scope && scope !== SCOPE)) throw new OAuthError("invalid_scope", `the only scope is ${SCOPE}`, 400);
    const now = Date.now(); const tokens = { accessToken: opaque(), refreshToken: opaque(), accessExpiresAt: now + this.accessTtl * 1000, refreshExpiresAt: now + this.refreshTtl * 1000 };
    let result: { accountId: string } | { error: string };
    if (field("grant_type") === "authorization_code") {
      const [code, clientId, redirectUri, codeVerifier] = [field("code"), field("client_id"), field("redirect_uri"), field("code_verifier")];
      if (!code || !clientId || !redirectUri || !codeVerifier) throw new OAuthError("invalid_request", "code, client_id, redirect_uri and code_verifier are required", 400);
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new OAuthError("invalid_grant", "code_verifier is malformed", 400);
      result = await this.repository.exchangeCode({ code, clientId, redirectUri, resource: this.resource, codeVerifier, ...tokens });
    } else if (field("grant_type") === "refresh_token") {
      const presentedRefreshToken = field("refresh_token"); if (!presentedRefreshToken) throw new OAuthError("invalid_request", "refresh_token is required", 400);
      result = await this.repository.rotateRefresh({ presentedRefreshToken, ...(field("client_id") ? { clientId: field("client_id") } : {}), ...tokens });
    } else throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token", 400);
    if ("error" in result) throw new OAuthError("invalid_grant", result.error, 400);
    return { access_token: tokens.accessToken, token_type: "Bearer", expires_in: this.accessTtl, refresh_token: tokens.refreshToken, scope: SCOPE };
  }

  async revoke(token: string | undefined, hint?: "access_token" | "refresh_token"): Promise<void> { if (token) await this.repository.revokeToken(token, hint); }

  async validateAccessToken(token: string | undefined): Promise<AccessGrant> {
    if (!token) throw new OAuthError("invalid_token", "access token is invalid or expired", 401);
    try { return await this.repository.validateAccess(token); } catch { throw new OAuthError("invalid_token", "access token is invalid or expired", 401); }
  }

  private authorizeAction(): string { return `${new URL(this.issuer).pathname.replace(/\/$/, "")}/oauth/authorize`; }
}

export function oauthErrorResponse(error: unknown): Response {
  const value = error instanceof OAuthError ? error : new OAuthError("server_error", "OAuth server error", 500);
  return json({ error: value.code, error_description: value.message }, value.status, { "cache-control": "no-store" });
}

/** OAuth bodies are form encoded (RFC 6749); registration (RFC 7591) and some clients send JSON. */
async function formBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const text = await request.text();
  if (text.length > 64 * 1024) throw new OAuthError("invalid_request", "request body is too large", 413);
  if (contentType === "application/json") {
    let parsed: unknown; try { parsed = JSON.parse(text || "{}"); } catch { throw new OAuthError("invalid_request", "malformed JSON request body", 400); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new OAuthError("invalid_request", "the request body must be a JSON object", 400);
    return parsed as Record<string, unknown>;
  }
  if (contentType !== "application/x-www-form-urlencoded") throw new OAuthError("invalid_request", "OAuth endpoints require form encoded requests", 400);
  return Object.fromEntries(new URLSearchParams(text).entries());
}
