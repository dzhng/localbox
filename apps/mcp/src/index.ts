import { AgentClient, type ClientRequestOptions, type ClientTransport } from "../../../packages/client/src/index.js";
import { mcpToolsSnapshot, PROTOCOL_VERSION, type Json, type OperationId } from "../../../packages/contract/src/index.js";
import { OAuthAuthorizationServer, OAuthError } from "../../relay/src/oauth.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export interface McpHttpRequest { method: string; url: string; headers?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal }
export interface McpHttpResponse { status: number; headers: Record<string, string>; body?: unknown }
export interface McpAdapterOptions { client?: AgentClient; transport?: ClientTransport; oauth?: OAuthAuthorizationServer; allowedOrigins?: string[]; protocolVersion?: string; endpoint?: string }
interface RpcRequest { jsonrpc?: string; id?: string | number | null; method: string; params?: any }

/** Streamable HTTP MCP adapter generated from the canonical operation catalog. */
export class McpAdapter {
  readonly client: AgentClient;
  readonly oauth: OAuthAuthorizationServer;
  readonly endpoint: string;
  private readonly allowedOrigins: Set<string>;
  readonly protocolVersion: string;
  constructor(options: McpAdapterOptions = {}) {
    this.oauth = options.oauth ?? new OAuthAuthorizationServer();
    this.client = options.client ?? new AgentClient({ transport: options.transport ?? ({ kind: "local", dispatch: async () => { throw new Error("MCP adapter requires a client or transport"); } } as ClientTransport) });
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.protocolVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION;
    this.endpoint = options.endpoint ?? this.oauth.resource;
  }
  protectedResourceMetadata(): Record<string, unknown> { return this.oauth.protectedResourceMetadata(); }
  async handle(request: McpHttpRequest): Promise<McpHttpResponse> {
    const headers = request.headers ?? {};
    const origin = headers.origin ?? headers.Origin;
    if (origin && this.allowedOrigins.size > 0 && !this.allowedOrigins.has(origin)) return this.httpError(403, "forbidden", "origin is not allowed");
    const url = new URL(request.url, this.endpoint);
    if (url.pathname.endsWith("/.well-known/oauth-protected-resource")) return { status: 200, headers: { "content-type": "application/json" }, body: this.oauth.protectedResourceMetadata() };
    if (url.pathname.endsWith("/.well-known/oauth-authorization-server")) return { status: 200, headers: { "content-type": "application/json" }, body: this.oauth.authorizationServerMetadata() };
    if (request.method !== "POST" && request.method !== "GET") return { status: 405, headers: { allow: "POST, GET", "content-type": "application/json" }, body: { error: "method_not_allowed" } };
    const token = this.bearer(headers.authorization ?? headers.Authorization);
    if (!token) return this.unauthorized();
    let auth: ReturnType<OAuthAuthorizationServer["validateAccessToken"]>;
    try { auth = this.oauth.validateAccessToken(token); } catch (error) { return this.oauthHttpError(error); }
    if (request.method === "GET") return { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "mcp-protocol-version": this.protocolVersion }, body: "" };
    const rpc = request.body as RpcRequest;
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return this.rpcResponse(rpc?.id ?? null, undefined, { code: -32600, message: "Invalid Request" });
    const response = await this.dispatch(rpc, auth.vm_id, request.signal);
    return { status: 200, headers: { "content-type": "application/json", "mcp-protocol-version": this.protocolVersion }, body: response };
  }
  private async dispatch(rpc: RpcRequest, vmId: string, signal?: AbortSignal): Promise<any> {
    try {
      if (rpc.method === "initialize") return this.rpcResponse(rpc.id ?? null, { protocolVersion: this.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "agent-computer", version: PROTOCOL_VERSION } });
      if (rpc.method === "notifications/initialized") return undefined;
      if (rpc.method === "tools/list") return this.rpcResponse(rpc.id ?? null, { tools: mcpToolsSnapshot().map((tool) => ({ name: tool.id, description: tool.description, inputSchema: tool.input_schema })) });
      if (rpc.method === "tools/call") {
        const name = rpc.params?.name as OperationId; const args = (rpc.params?.arguments ?? {}) as Json;
        const tool = mcpToolsSnapshot().find((entry) => entry.id === name); if (!tool) return this.rpcResponse(rpc.id ?? null, undefined, { code: -32602, message: `Unknown tool: ${name}` });
        const options: ClientRequestOptions = { vmId, signal };
        const result = await this.client.invoke(name, args, options);
        if (!result.ok) return this.rpcResponse(rpc.id ?? null, { isError: true, content: [{ type: "text", text: result.error.message }], structuredContent: result.error });
        return this.rpcResponse(rpc.id ?? null, { content: [{ type: "text", text: JSON.stringify(result.result) }], structuredContent: result.result });
      }
      return this.rpcResponse(rpc.id ?? null, undefined, { code: -32601, message: `Method not found: ${rpc.method}` });
    } catch (error) { return this.rpcResponse(rpc.id ?? null, undefined, { code: -32603, message: error instanceof Error ? error.message : "Internal error" }); }
  }
  private rpcResponse(id: string | number | null, result?: unknown, error?: { code: number; message: string }): any { return { jsonrpc: "2.0", id, ...(error ? { error } : { result }) }; }
  private bearer(value?: string): string | undefined { const match = value?.match(/^Bearer\s+(.+)$/i); return match?.[1]; }
  private unauthorized(): McpHttpResponse { return { status: 401, headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${this.endpoint}/.well-known/oauth-protected-resource"` }, body: { error: "unauthorized" } }; }
  private oauthHttpError(error: unknown): McpHttpResponse { if (error instanceof OAuthError && error.status === 401) return this.unauthorized(); const status = error instanceof OAuthError ? error.status : 401; return { status, headers: { "content-type": "application/json" }, body: { error: error instanceof Error ? error.message : "unauthorized" } }; }
  private httpError(status: number, code: string, message: string): McpHttpResponse { return { status, headers: { "content-type": "application/json" }, body: { error: code, error_description: message } }; }
}
export const McpStreamableHttpAdapter = McpAdapter;
export function createMcpAdapter(options: McpAdapterOptions = {}): McpAdapter { return new McpAdapter(options); }

export const McpServer = McpAdapter;
