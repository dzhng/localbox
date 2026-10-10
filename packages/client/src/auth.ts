import { createHash, randomBytes } from "node:crypto";

export interface PkcePair { verifier: string; challenge: string; }
export interface OAuthTokenResponse { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string; vm_id?: string; resource?: string; }

/** Create an RFC 7636 S256 verifier/challenge pair for owner login. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizationUrl(input: { endpoint: string; clientId: string; redirectUri: string; resource: string; challenge: string; state: string; vmId?: string }): string {
  const url = new URL(input.endpoint);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: input.clientId, redirect_uri: input.redirectUri, resource: input.resource, code_challenge: input.challenge, code_challenge_method: "S256", state: input.state, ...(input.vmId ? { vm_id: input.vmId } : {}) })) url.searchParams.set(key, value);
  return url.toString();
}

export async function exchangeAuthorizationCode(input: { endpoint: string; code: string; clientId: string; redirectUri: string; verifier: string; resource?: string; fetchImpl?: typeof fetch }): Promise<OAuthTokenResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: input.code, client_id: input.clientId, redirect_uri: input.redirectUri, code_verifier: input.verifier, ...(input.resource ? { resource: input.resource } : {}) }) });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok || typeof body.access_token !== "string") throw new Error(body.error_description ?? body.error ?? `OAuth token exchange failed (${response.status})`);
  return body as OAuthTokenResponse;
}

export async function refreshAccessToken(input: { endpoint: string; refreshToken: string; clientId: string; resource?: string; fetchImpl?: typeof fetch }): Promise<OAuthTokenResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: input.refreshToken, client_id: input.clientId, ...(input.resource ? { resource: input.resource } : {}) }) });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok || typeof body.access_token !== "string") throw new Error(body.error_description ?? body.error ?? `OAuth refresh failed (${response.status})`);
  return body as OAuthTokenResponse;
}
