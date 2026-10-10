import { ConvexHttpClient } from "convex/browser";
import { AgentClient, RelayHttpTransport } from "../../../packages/client/src/index.js";
import { ConvexRelayStateRepository } from "../../../packages/state/src/index.js";
import { McpAdapter } from "../src/index.js";

const resource = process.env.AGENT_COMPUTER_RESOURCE ?? "https://relay.example.test/mcp";
const repository = process.env.CONVEX_URL ? new ConvexRelayStateRepository(new ConvexHttpClient(process.env.CONVEX_URL, { skipConvexDeploymentUrlCheck: true }), process.env.CONVEX_DEPLOYMENT ?? "convex") : undefined;

export default async function handle(request: Request): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const client = new AgentClient({ transport: new RelayHttpTransport({ baseUrl: process.env.AGENT_COMPUTER_RELAY_URL ?? resource, accessToken: token }) });
  const adapter = new McpAdapter({ client, endpoint: resource, accessTokenValidator: repository ? (access) => repository.validateAccessToken(access, resource).then((identity) => ({ vm_id: identity.vmId })) : undefined });
  const body = request.method === "GET" ? undefined : await request.text();
  const result = await adapter.handle({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers.entries()), body: body ? JSON.parse(body) : undefined });
  return new Response(result.body === undefined ? undefined : JSON.stringify(result.body), { status: result.status, headers: result.headers });
}
