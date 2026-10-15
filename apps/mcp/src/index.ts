import { catalogById, helpSnapshot, PROTOCOL_VERSION, type JsonSchema, type OperationCatalogEntry, type ResponseEnvelope } from "../../../packages/contract/src/index.js";
import type { OpsResponse, Principal } from "../../relay/src/ops.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export interface McpHttpRequest { method: string; url: string; headers?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal }
export interface McpHttpResponse { status: number; headers: Record<string, string>; body?: unknown }
export interface McpAdapterOptions {
  /** The MCP resource URL; its protected-resource metadata is advertised on 401. */
  endpoint: string;
  /** Resolves an OAuth access token to its account; throws when the token is invalid, expired or revoked. */
  authenticate(token: string): Promise<Principal>;
  /** The agent API (`runOps`), called in-process as the token's account. */
  ops(principal: Principal, input: Record<string, unknown>): Promise<OpsResponse>;
  allowedOrigins?: string[];
  protocolVersion?: string;
}
interface RpcRequest { jsonrpc?: string; id?: string | number | null; method: string; params?: any }

/** The request's selectors: what it is for. Every tool takes both; they are the agent API's, not the operation's input. */
const SELECTORS: Record<"sandbox" | "machine", JsonSchema & { description: string }> = {
  sandbox: { type: "string", minLength: 1, description: "The sandbox the request is for: a name or id from sandbox.list. May be left out when the account has exactly one sandbox." },
  machine: { type: "string", minLength: 1, description: "The machine the request is for: a name or id from machine.list. sandbox.create puts the sandbox there; relay, skill and agent setup tools run there; a named sandbox's own machine wins. May be left out when the account has exactly one machine." },
};
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The catalog as MCP tools, each with the request selectors beside its input. The agent API finds the machine. */
export function mcpTools(): Array<{ name: string; description: string; inputSchema: JsonSchema }> {
  return helpSnapshot().map((tool) => ({ name: tool.id, description: tool.description, inputSchema: { ...tool.input_schema, properties: { ...tool.input_schema.properties, ...SELECTORS } } }));
}

/** Streamable HTTP MCP adapter over the agent API; every call acts as the signed-in account. */
export class McpAdapter {
  readonly endpoint: string;
  readonly protocolVersion: string;
  private readonly allowedOrigins: Set<string>;
  private readonly authenticate: McpAdapterOptions["authenticate"];
  private readonly ops: McpAdapterOptions["ops"];
  constructor(options: McpAdapterOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.authenticate = options.authenticate;
    this.ops = options.ops;
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.protocolVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION;
  }
  async handle(request: McpHttpRequest): Promise<McpHttpResponse> {
    const headers = request.headers ?? {};
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
      const { sandbox, machine, ...input } = isObject(rpc.params?.arguments) ? rpc.params.arguments : {};
      try { return this.rpcResponse(id, await this.call(principal, entry, { sandbox, machine }, input)); }
      catch (error) { return this.rpcResponse(id, this.toolError(error instanceof Error ? error.message : "the operation failed")); }
    }
    return this.rpcResponse(id, undefined, { code: -32601, message: `Method not found: ${rpc.method}` });
  }
  private async call(principal: Principal, entry: OperationCatalogEntry, target: { sandbox: unknown; machine: unknown }, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const operation = entry.id;
    // MCP has no idempotency key of its own: each tool call is one mutation.
    const mutationId = entry.idempotency === "required" ? `mcp_${crypto.randomUUID()}` : null;
    const where = Object.fromEntries(Object.entries(target).filter(([, value]) => typeof value === "string" && value));
    // A 30 s deadline ends inside one agent API wait (50 s), so the answer is final, never a continuation.
    const result = await this.ops(principal, { operation, input, ...where, request_id: `mcp_${crypto.randomUUID()}`, mutation_id: mutationId, deadline_ms: 30_000 });
    if (result.status !== 200) return this.toolError(String((result.body as { error?: string }).error ?? `the operation failed (${result.status})`));
    const envelope = (result.body as { response: ResponseEnvelope }).response;
    return envelope.ok ? this.toolResult(envelope.result) : { ...this.toolError(envelope.error.message), structuredContent: envelope.error };
  }
  private toolResult(value: unknown): Record<string, unknown> { return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isObject(value) ? { structuredContent: value } : {}) }; }
  private toolError(message: string): Record<string, unknown> { return { isError: true, content: [{ type: "text", text: message }] }; }
  private rpcResponse(id: string | number | null, result?: unknown, error?: { code: number; message: string }): any { return { jsonrpc: "2.0", id, ...(error ? { error } : { result }) }; }
  private unauthorized(): McpHttpResponse { return { status: 401, headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${this.endpoint}/.well-known/oauth-protected-resource"` }, body: { error: "unauthorized" } }; }
  private httpError(status: number, code: string, message: string): McpHttpResponse { return { status, headers: { "content-type": "application/json" }, body: { error: code, error_description: message } }; }
}
