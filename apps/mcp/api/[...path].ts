import { selectMailer } from "../../../packages/mail/src/index.js";
import { PUBLIC_MCP_RESOURCE } from "../../../packages/config/src/index.js";
import { RepositoryOAuthServer } from "../../relay/src/repository-oauth.js";
import { runOps, type OpsResponse, type Principal } from "../../relay/src/ops.js";
import { oauthRepository, opsDeps } from "../../relay/src/convex-deps.js";
import { json } from "../../relay/src/http.js";
import { McpAdapter } from "../src/index.js";

if (process.env.VERCEL && !process.env.CONVEX_URL) throw new Error("CONVEX_URL is required for the deployed MCP endpoint");
if (process.env.VERCEL && !process.env.LOCALBOX_JWT_PRIVATE_KEY) throw new Error("LOCALBOX_JWT_PRIVATE_KEY is required for the deployed MCP endpoint");

const MAX_BODY_BYTES = 1024 * 1024;

/** The MCP endpoint: OAuth sign-in routes, then MCP calls that run the agent API in-process as the token's account. */
export function createMcpHandler(options: { oauth: RepositoryOAuthServer; ops: (principal: Principal, input: Record<string, unknown>) => Promise<OpsResponse> }): (request: Request) => Promise<Response> {
  const { oauth } = options;
  const adapter = new McpAdapter({
    endpoint: oauth.resource,
    authenticate: async (token) => { const grant = await oauth.validateAccessToken(token); return { accountId: grant.accountId, familyId: grant.familyId }; },
    ops: options.ops,
  });
  return async (request) => {
    const url = new URL(request.url);
    // Vercel rewrites the two well-known paths to `?metadata=` (vercel.json).
    const metadata = url.searchParams.get("metadata");
    if (request.method === "GET" && metadata === "oauth-protected-resource") return json(oauth.protectedResourceMetadata());
    if (request.method === "GET" && metadata === "oauth-authorization-server") return json(oauth.authorizationServerMetadata());
    const oauthResponse = await oauth.handle(request);
    if (oauthResponse) return oauthResponse;
    const body = request.method === "GET" ? undefined : await request.text();
    if (body !== undefined && Buffer.byteLength(body) > MAX_BODY_BYTES) return json({ error: "payload_too_large", error_description: "MCP request exceeds the configured size limit" }, 413);
    let parsed: unknown;
    try { parsed = body ? JSON.parse(body) : undefined; } catch { return json({ error: "invalid_json" }, 400); }
    const result = await adapter.handle({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers.entries()), body: parsed });
    return new Response(result.body === undefined ? undefined : JSON.stringify(result.body), { status: result.status, headers: result.headers });
  };
}

const resource = PUBLIC_MCP_RESOURCE;
export default createMcpHandler({
  oauth: new RepositoryOAuthServer({ repository: oauthRepository, issuer: resource, resource, mailer: selectMailer }),
  ops: (principal, input) => runOps(principal, input, opsDeps),
});
