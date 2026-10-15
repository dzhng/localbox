import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { waitForCode } from "./codes.js";
import { API_ORIGIN } from "./login.js";

export const MCP = `${API_ORIGIN}/api/mcp`;
export const REDIRECT = "http://127.0.0.1:47123/callback";
export type Metadata = Record<string, any>;

/** Page text without markup, for asserting what a sign-in page says. */
export const pageText = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/\s+/g, " ");
export const form = (fields: Record<string, string>): RequestInit => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(), redirect: "manual" });

/** One JSON-RPC call to the MCP endpoint; the body is parsed only on 200. */
export async function mcp(token: string, method: string, params?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(MCP, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: response.status, body: response.status === 200 ? await response.json() as any : undefined };
}

/** As an MCP client: find the authorization server from the 401, check its metadata, and register `clientName`. */
export async function registerClient(clientName: string): Promise<{ metadata: Metadata; clientId: string }> {
  const unauthenticated = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
  assert.equal(unauthenticated.status, 401);
  const resourceUrl = unauthenticated.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1]; assert.ok(resourceUrl);
  const resource = await (await fetch(resourceUrl)).json() as any;
  assert.equal(resource.resource, MCP); assert.deepEqual(resource.scopes_supported, ["account"]);
  const issuer = new URL(resource.authorization_servers[0]);
  const metadata = await (await fetch(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`)).json() as Metadata;
  assert.deepEqual(await (await fetch(`${issuer.href}/.well-known/oauth-authorization-server`)).json(), metadata, "both discovery paths agree");
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]); assert.ok(metadata.registration_endpoint);
  const registered = await fetch(metadata.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT] }) });
  assert.equal(registered.status, 201);
  return { metadata, clientId: (await registered.json() as any).client_id };
}

/** Authorize by email code (read from dev:local's log) as a scripted MCP client, then exchange with PKCE; returns the token response. */
export async function signInAgent(root: string, metadata: Metadata, clientId: string, address: string, check?: (codePage: string) => void): Promise<Record<string, any>> {
  const devLog = join(root, ".localbox/proof/dev-local.log");
  const verifier = randomBytes(32).toString("base64url"); const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: MCP, scope: "account", state: `st-${randomBytes(4).toString("hex")}` };
  const page = await fetch(`${metadata.authorization_endpoint}?${new URLSearchParams(params)}`);
  assert.equal(page.status, 200); assert.match(await page.text(), /Sign in to Localbox/);
  const since = statSync(devLog).size;
  const codePage = await fetch(metadata.authorization_endpoint, form({ ...params, step: "email", email: address }));
  assert.equal(codePage.status, 200); check?.(pageText(await codePage.text()));
  const code = await waitForCode(address, { sinceByte: since, logPath: devLog });
  const redirected = await fetch(metadata.authorization_endpoint, form({ ...params, step: "code", email: address, code }));
  assert.equal(redirected.status, 302);
  const location = new URL(redirected.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT); assert.equal(location.searchParams.get("state"), params.state);
  const exchanged = await fetch(metadata.token_endpoint, form({ grant_type: "authorization_code", code: location.searchParams.get("code")!, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: MCP }));
  assert.equal(exchanged.status, 200);
  return await exchanged.json() as Record<string, any>;
}
