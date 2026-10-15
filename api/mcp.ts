import type { IncomingMessage, ServerResponse } from "node:http";
import handler from "../apps/mcp/api/[...path].js";
import { serveWebRequest } from "../apps/relay/src/vercel-node.js";

/** The MCP endpoint and its OAuth routes: /api/mcp and /api/mcp/* (see vercel.json). */
export default async function vercelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await serveWebRequest(handler, req, res, ["/api/mcp"]);
}
