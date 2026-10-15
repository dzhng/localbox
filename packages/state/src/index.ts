import { makeFunctionReference } from "convex/server";

export interface OAuthClientRecord { clientId: string; clientName: string; redirectUris: string[]; createdAt: number }
export interface IssuedTokens { accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number }
export interface TokenGrant { accountId: string; familyId: string }
export interface AccessGrant extends TokenGrant { clientId: string; scopes: string[]; accessExpiresAt: number }
export interface SignInStart { issued: boolean; code?: string }
export type AgentVerification = { valid: true; accountId: string } | { valid: false };

/** Durable state behind MCP sign-in. Every method is a service-identity Convex function. */
export interface OAuthRepository {
  registerClient(input: { clientName: string; redirectUris: string[]; ip: string }): Promise<OAuthClientRecord | { limited: true }>;
  client(clientId: string): Promise<OAuthClientRecord | null>;
  startSignIn(email: string, ip: string): Promise<SignInStart>;
  verifyForAgent(input: { email: string; code: string; ip: string }): Promise<AgentVerification>;
  createCode(input: { code: string; accountId: string; clientId: string; redirectUri: string; resource: string; codeChallenge: string; expiresAt: number }): Promise<void>;
  exchangeCode(input: { code: string; clientId: string; redirectUri: string; resource: string; codeVerifier: string } & IssuedTokens): Promise<TokenGrant | { error: string }>;
  rotateRefresh(input: { presentedRefreshToken: string; clientId?: string } & IssuedTokens): Promise<TokenGrant | { error: string }>;
  validateAccess(accessToken: string): Promise<AccessGrant>;
  revokeToken(token: string, hint?: "access_token" | "refresh_token"): Promise<void>;
}

/** Calls one Convex function as the service identity. */
export type ServiceCall = (kind: "mutation" | "query", name: string, args: object) => Promise<any>;

/** Minimal Convex client surface. ConvexHttpClient and convex-test both satisfy it. */
export interface ConvexFunctionClient {
  mutation(name: any, args: Record<string, unknown> | object): Promise<unknown>;
  query(name: any, args: Record<string, unknown> | object): Promise<unknown>;
}
export const serviceCallFor = (client: ConvexFunctionClient): ServiceCall => async (kind, name, args) => await client[kind](makeFunctionReference(name) as any, args);

export class ConvexOAuthRepository implements OAuthRepository {
  constructor(private readonly call: ServiceCall) {}
  registerClient(input: { clientName: string; redirectUris: string[]; ip: string }) { return this.call("mutation", "oauth:registerClient", input); }
  client(clientId: string) { return this.call("query", "oauth:client", { clientId }); }
  startSignIn(email: string, ip: string) { return this.call("mutation", "signin:start", { email, ip }); }
  verifyForAgent(input: { email: string; code: string; ip: string }) { return this.call("mutation", "signin:verifyForAgent", input); }
  async createCode(input: Parameters<OAuthRepository["createCode"]>[0]) { await this.call("mutation", "oauth:createCode", input); }
  exchangeCode(input: Parameters<OAuthRepository["exchangeCode"]>[0]) { return this.call("mutation", "oauth:exchangeCode", input); }
  rotateRefresh(input: Parameters<OAuthRepository["rotateRefresh"]>[0]) { return this.call("mutation", "oauth:rotateRefresh", input); }
  validateAccess(accessToken: string) { return this.call("query", "oauth:validateAccess", { accessToken }); }
  async revokeToken(token: string, hint?: "access_token" | "refresh_token") { await this.call("mutation", "oauth:revokeToken", { token, ...(hint ? { hint } : {}) }); }
}

export { relayStateSchema } from "../convex/schema.js";
export { createConvexTestHarness } from "../test-harness.js";
