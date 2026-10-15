import type { IncomingMessage, ServerResponse } from "node:http";
import handler from "../apps/relay/api/[...path].js";
import { serveWebRequest } from "../apps/relay/src/vercel-node.js";

/** The relay function: /api/relay/*, plus /api/auth/* and /api/v1/* (see vercel.json). */
export default async function vercelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await serveWebRequest(handler, req, res, ["/api/relay", "/api"]);
}
