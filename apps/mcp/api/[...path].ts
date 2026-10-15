import { ConvexHttpClient } from "convex/browser";
import { AgentClient, RelayHttpTransport } from "../../../packages/client/src/index.js";
import { ConvexRelayStateRepository, InMemoryRelayStateRepository, type RelayStateRepository } from "../../../packages/state/src/index.js";
import { OAuthAuthorizationServer, OAuthError } from "../../relay/src/oauth.js";
import { oauthErrorResponse, oauthRedirect, RepositoryOAuthServer } from "../../relay/src/repository-oauth.js";
import { McpAdapter } from "../src/index.js";

const resource = process.env.LOCALBOX_RESOURCE ?? "https://relay.example.test/mcp";
const issuer = resource.replace(/\/$/, "");
const relayUrl = defaultRelayUrl(resource);
if (process.env.VERCEL && !process.env.CONVEX_URL) throw new Error("CONVEX_URL is required for the deployed MCP endpoint");
if (process.env.VERCEL && !process.env.LOCALBOX_RESOURCE) throw new Error("LOCALBOX_RESOURCE is required for the deployed MCP endpoint");
if (process.env.VERCEL && !process.env.LOCALBOX_OWNER_SUBJECT) throw new Error("LOCALBOX_OWNER_SUBJECT is required for the deployed MCP endpoint");
const repository: RelayStateRepository = process.env.CONVEX_URL
  ? new ConvexRelayStateRepository(new ConvexHttpClient(process.env.CONVEX_URL, { skipConvexDeploymentUrlCheck: true }))
  : new InMemoryRelayStateRepository({ deploymentId: "mcp-local" });
const durableOAuth = process.env.CONVEX_URL ? new RepositoryOAuthServer({ repository, issuer, resource, ownerSubject: process.env.LOCALBOX_OWNER_SUBJECT ?? "default-owner" }) : undefined;
const fixtureOAuth = new OAuthAuthorizationServer({ issuer, resource });

export default async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const metadata = url.searchParams.get("metadata");
  if (request.method === "GET" && metadata === "oauth-protected-resource") return json(200, durableOAuth?.protectedResourceMetadata() ?? fixtureOAuth.protectedResourceMetadata());
  if (request.method === "GET" && metadata === "oauth-authorization-server") return json(200, durableOAuth?.authorizationServerMetadata() ?? fixtureOAuth.authorizationServerMetadata());
  const oauthResponse = await handleOAuth(request, url);
  if (oauthResponse) return oauthResponse;
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const client = new AgentClient({ transport: new RelayHttpTransport({ baseUrl: relayUrl, accessToken: token }) });
  const adapter = new McpAdapter({ client, oauth: fixtureOAuth, endpoint: resource, accessTokenValidator: durableOAuth ? (access) => durableOAuth.validateAccessToken(access).then((identity) => ({ vm_id: identity.vm_id })) : undefined });
  const body = request.method === "GET" ? undefined : await request.text();
  if (body !== undefined && Buffer.byteLength(body) > 1024 * 1024) return new Response(JSON.stringify({ error: "payload_too_large", error_description: "MCP request exceeds the configured size limit" }), { status: 413, headers: { "content-type": "application/json" } });
  let parsed: unknown;
  try { parsed = body ? JSON.parse(body) : undefined; } catch { return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers: { "content-type": "application/json" } }); }
  const result = await adapter.handle({ method: request.method, url: request.url, headers: requestHeaders(request.headers), body: parsed });
  return new Response(result.body === undefined ? undefined : JSON.stringify(result.body), { status: result.status, headers: result.headers });
}

function defaultRelayUrl(resourceUrl: string): string {
  const url = new URL(resourceUrl);
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "/relay");
  return url.toString().replace(/\/$/, "");
}

function requestHeaders(value: Headers | Record<string, string | string[]>): Record<string, string> {
  if (typeof (value as Headers).entries === "function") return Object.fromEntries((value as Headers).entries());
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), Array.isArray(item) ? item.join(", ") : item]));
}

async function handleOAuth(request: Request, url: URL): Promise<Response | undefined> {
  const oauth = durableOAuth ?? fixtureOAuth;
  if (request.method === "GET" && url.pathname.endsWith("/.well-known/oauth-protected-resource")) return json(200, oauth.protectedResourceMetadata());
  if (request.method === "GET" && url.pathname.endsWith("/.well-known/oauth-authorization-server")) return json(200, oauth.authorizationServerMetadata());
  if (request.method === "GET" && url.pathname.endsWith("/oauth/authorize")) {
    try {
      const input = Object.fromEntries(url.searchParams.entries()) as any;
      const result = await oauth.authorize({ ...input, response_type: input.response_type ?? "code", code_challenge_method: input.code_challenge_method ?? "S256" });
      return new Response(null, { status: 302, headers: { location: oauthRedirect(result), "cache-control": "no-store" } });
    } catch (error) { return oauthErrorResponse(error); }
  }
  if (url.pathname.endsWith("/oauth/token") || url.pathname.endsWith("/oauth/revoke")) {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });
    try {
      const input = await formBody(request);
      if (url.pathname.endsWith("/oauth/token")) return json(200, await oauth.token(input as any), { "cache-control": "no-store" });
      await oauth.revoke(input.token, input.token_type_hint as "access_token" | "refresh_token" | undefined); return json(200, {});
    } catch (error) { return oauthErrorResponse(error); }
  }
  return undefined;
}

async function formBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const text = await request.text();
  if (text.length > 1024 * 1024) throw new OAuthError("invalid_request", "request body is too large", 413);
  if (contentType === "application/json") { try { return JSON.parse(text || "{}") as Record<string, string>; } catch { throw new OAuthError("invalid_request", "malformed JSON request body", 400); } }
  if (contentType !== "application/x-www-form-urlencoded") throw new OAuthError("invalid_request", "OAuth endpoints require form encoded requests", 400);
  return Object.fromEntries(new URLSearchParams(text).entries());
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } }); }
