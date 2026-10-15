import { createHash, randomBytes } from "node:crypto";
import { ConvexOAuthRepository, createConvexTestHarness, serviceCallFor } from "../../packages/state/src/index.js";
import type { CodeMessage } from "../../packages/mail/src/index.js";
import { RepositoryOAuthServer } from "../../apps/relay/src/repository-oauth.js";

export const RESOURCE = "https://api.test/api/mcp";
export const pkcePair = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
export const form = (fields: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

/** The OAuth server over an in-process Convex (convex-test) with a mailer that keeps what it sent. */
export function oauthFixture() {
  const t = createConvexTestHarness();
  const repository = new ConvexOAuthRepository(serviceCallFor(t.withIdentity({ subject: "service:api" })));
  const sent: CodeMessage[] = [];
  const oauth = new RepositoryOAuthServer({ repository, issuer: RESOURCE, resource: RESOURCE, mailer: () => ({ sendCode: async (message) => { sent.push(message); } }) });
  const call = (path: string, init?: RequestInit) => oauth.handle(new Request(`${RESOURCE}${path}`, init)).then((response) => { if (!response) throw new Error(`no OAuth route for ${path}`); return response; });
  const register = async (redirectUri = "https://claude.ai/api/mcp/auth_callback", clientName = "Claude") =>
    await (await call("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri] }) })).json() as { client_id: string; redirect_uris: string[] };
  /** The authorize parameters a well-behaved client sends. */
  const authorizeParams = (clientId: string, redirectUri: string, challenge: string, state = "state-1") => ({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE, scope: "account", state });
  /** Register, sign in by email code and exchange the code: what an MCP client does once. */
  const signIn = async (email = "agent@example.com", redirectUri = "https://claude.ai/api/mcp/auth_callback") => {
    const client = await register(redirectUri); const pair = pkcePair(); const params = authorizeParams(client.client_id, redirectUri, pair.challenge);
    await call("/oauth/authorize", form({ ...params, step: "email", email }));
    const redirected = await call("/oauth/authorize", form({ ...params, step: "code", email, code: sent.at(-1)!.code }));
    const code = new URL(redirected.headers.get("location")!).searchParams.get("code")!;
    const tokens = await (await call("/oauth/token", form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: pair.verifier, resource: RESOURCE }))).json() as { access_token: string; refresh_token: string };
    return { ...tokens, clientId: client.client_id };
  };
  return { t, repository, oauth, sent, call, register, authorizeParams, signIn };
}
