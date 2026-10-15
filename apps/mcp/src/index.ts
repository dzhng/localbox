import { catalogById, mcpToolsSnapshot, PROTOCOL_VERSION, type JsonSchema, type OperationCatalogEntry, type ResponseEnvelope } from "../../../packages/contract/src/index.js";
import type { OpsResponse, Principal } from "../../relay/src/ops.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export interface McpHttpRequest { method: string; url: string; headers?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal }
export interface McpHttpResponse { status: number; headers: Record<string, string>; body?: unknown }
export interface McpAdapterOptions {
  /** The MCP resource URL; its protected-resource metadata is advertised on 401. */
  endpoint: string;
  /** Resolves an OAuth access token to its account; throws when the token is invalid, expired or revoked. */
  authenticate(token: string): Promise<Principal>;
  /** The agent API (`handleOps`), called in-process as the token's account. */
  ops(principal: Principal, input: Record<string, unknown>): Promise<OpsResponse>;
  allowedOrigins?: string[];
  protocolVersion?: string;
  maxBodyBytes?: number;
}
interface RpcRequest { jsonrpc?: string; id?: string | number | null; method: string; params?: any }

const SANDBOX_ARGUMENT: JsonSchema & { description: string } = { type: "string", minLength: 1, description: "The sandbox to act on: a name or id from sandbox.list. May be left out when the account has exactly one sandbox." };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The catalog as MCP tools. Tools that act on one sandbox gain a `sandbox` argument; it is the adapter's, not the catalog's. The agent API finds the sandbox's machine. */
export function mcpTools(): Array<{ name: string; description: string; inputSchema: JsonSchema }> {
  return mcpToolsSnapshot().map((tool) => ({
    name: tool.id, description: tool.description,
    inputSchema: tool.sandbox_scoped ? { ...tool.input_schema, properties: { ...tool.input_schema.properties, sandbox: SANDBOX_ARGUMENT } } : tool.input_schema,
  }));
}

/** Streamable HTTP MCP adapter over the agent API; every call acts as the signed-in account. */
export class McpAdapter {
  readonly endpoint: string;
  readonly protocolVersion: string;
  readonly maxBodyBytes: number;
  private readonly allowedOrigins: Set<string>;
  private readonly authenticate: McpAdapterOptions["authenticate"];
  private readonly ops: McpAdapterOptions["ops"];
  constructor(options: McpAdapterOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.authenticate = options.authenticate;
    this.ops = options.ops;
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.protocolVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION;
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  }
  async handle(request: McpHttpRequest): Promise<McpHttpResponse> {
    const headers = request.headers ?? {};
    if (request.body !== undefined && Buffer.byteLength(typeof request.body === "string" ? request.body : JSON.stringify(request.body)) > this.maxBodyBytes) return this.httpError(413, "payload_too_large", "MCP request exceeds the configured size limit");
    const origin = headers.origin ?? headers.Origin;
    if (origin && this.allowedOrigins.size > 0 && !this.allowedOrigins.has(origin)) return this.httpError(403, "forbidden", "origin is not allowed");
    if (request.method !== "POST" && request.method !== "GET") return { status: 405, headers: { allow: "POST, GET", "content-type": "application/json" }, body: { error: "method_not_allowed" } };
    const token = (headers.authorization ?? headers.Authorization)?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return this.unauthorized();
    let principal: Principal;
    try { principal = await this.authenticate(token); } catch { return this.unauthorized(); }
    if (request.method === "GET") return { status: 405, headers: { allow: "POST", "content-type": "application/json" }, body: { error: "method_not_allowed", error_description: "this server does not open an SSE stream" } };
    const rpc = request.body as RpcRequest;
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return { status: 200, headers: { "content-type": "application/json" }, body: this.rpcResponse(rpc?.id ?? null, undefined, { code: -32600, message: "Invalid Request" }) };
    const response = await this.dispatch(rpc, principal);
    if (response === undefined) return { status: 202, headers: { "mcp-protocol-version": this.protocolVersion } };
    return { status: 200, headers: { "content-type": "application/json", "mcp-protocol-version": this.protocolVersion }, body: response };
  }
  private async dispatch(rpc: RpcRequest, principal: Principal): Promise<any> {
    const id = rpc.id ?? null;
    if (rpc.method === "initialize") return this.rpcResponse(id, { protocolVersion: this.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "localbox", version: PROTOCOL_VERSION } });
    if (rpc.method.startsWith("notifications/")) return undefined;
    if (rpc.method === "ping") return this.rpcResponse(id, {});
    if (rpc.method === "tools/list") return this.rpcResponse(id, { tools: mcpTools() });
    if (rpc.method === "tools/call") {
      const name = String(rpc.params?.name ?? ""); const entry = catalogById.get(name as never);
      if (!entry) return this.rpcResponse(id, undefined, { code: -32602, message: `Unknown tool: ${name}` });
      const { sandbox, ...input } = isObject(rpc.params?.arguments) ? rpc.params.arguments : {};
      try { return this.rpcResponse(id, await this.call(principal, entry, entry.sandbox_scoped ? sandbox : undefined, input)); }
      catch (error) { return this.rpcResponse(id, this.toolError(error instanceof Error ? error.message : "the operation failed")); }
    }
    return this.rpcResponse(id, undefined, { code: -32601, message: `Method not found: ${rpc.method}` });
  }
  private async call(principal: Principal, entry: OperationCatalogEntry, sandbox: unknown, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const operation = entry.id;
    // MCP has no idempotency key of its own: each tool call is one mutation.
    const mutationId = entry.idempotency === "required" ? `mcp_${crypto.randomUUID()}` : null;
    let result = await this.ops(principal, { operation, input, ...(typeof sandbox === "string" && sandbox ? { sandbox } : {}), request_id: `mcp_${crypto.randomUUID()}`, mutation_id: mutationId, deadline_ms: 30_000 });
    // A long request comes back as a continuation; resume it until the machine answers or its deadline passes.
    while (result.status === 202) { const pending = result.body as { request_id: string; deadline_at: number }; result = await this.ops(principal, { continue: pending.request_id, deadline_at: pending.deadline_at }); }
    if (result.status !== 200) return this.toolError(String((result.body as any)?.error ?? `the operation failed (${result.status})`));
    // Account operations answer with the catalog's value; everything else with a response envelope.
    const envelope = (result.body as { response?: ResponseEnvelope } | undefined)?.response;
    if (!envelope) return this.toolResult(result.body);
    return envelope.ok ? this.toolResult(envelope.result) : { ...this.toolError(envelope.error.message), structuredContent: envelope.error };
  }
  private toolResult(value: unknown): Record<string, unknown> { return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isObject(value) ? { structuredContent: value } : {}) }; }
  private toolError(message: string): Record<string, unknown> { return { isError: true, content: [{ type: "text", text: message }] }; }
  private rpcResponse(id: string | number | null, result?: unknown, error?: { code: number; message: string }): any { return { jsonrpc: "2.0", id, ...(error ? { error } : { result }) }; }
  private unauthorized(): McpHttpResponse { return { status: 401, headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${this.endpoint}/.well-known/oauth-protected-resource"` }, body: { error: "unauthorized" } }; }
  private httpError(status: number, code: string, message: string): McpHttpResponse { return { status, headers: { "content-type": "application/json" }, body: { error: code, error_description: message } }; }
}
