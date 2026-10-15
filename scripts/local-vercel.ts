import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { forwardedHeaders } from "./local-vercel-ip.js";

function loadEnvFile(path: string): void {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch { /* local env files are optional when variables are exported */ }
}

loadEnvFile(".env.local");
if (!process.env.CONVEX_URL) throw new Error("CONVEX_URL is required; start `npx convex dev` before `npm run dev:local`");
process.env.VERCEL ??= "1";
process.env.LOCALBOX_LOCAL_SERVICES ??= "1";
process.env.LOCALBOX_API_ORIGIN ??= "http://127.0.0.1:3000";
process.env.LOCALBOX_OWNER_SUBJECT ??= "local-owner";
process.env.LOCALBOX_VM_ID ??= "vm_local";

const relay = (await import("../apps/relay/api/[...path].js")).default as (request: Request) => Promise<Response>;
const mcp = (await import("../apps/mcp/api/[...path].js")).default as (request: Request) => Promise<Response>;
const configuredPort = process.env.LOCAL_VERCEL_PORT ?? (new URL(process.env.LOCALBOX_API_ORIGIN).port || "3000");
const port = Number(configuredPort);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("LOCAL_VERCEL_PORT must be a valid TCP port");

const server = createServer(async (incoming, outgoing) => {
  try {
    const body = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : await readBody(incoming);
    const original = new URL(incoming.url ?? "/", `http://127.0.0.1:${port}`);
    const isRelay = original.pathname === "/api/relay" || original.pathname.startsWith("/api/relay/");
    const isMcp = original.pathname === "/api/mcp" || original.pathname.startsWith("/api/mcp/");
    if (!isRelay && !isMcp) { outgoing.statusCode = 404; outgoing.end(JSON.stringify({ error: "not_found" })); return; }
    const prefix = isRelay ? "/api/relay" : "/api/mcp";
    original.pathname = original.pathname.slice(prefix.length) || "/";
    const request = new Request(original, { method: incoming.method, headers: forwardedHeaders(incoming.headers, incoming.socket.remoteAddress ?? "127.0.0.1", process.env.LOCAL_VERCEL_TRUST_CLIENT_IP === "1"), body: body === undefined ? undefined : new Uint8Array(body) });
    const response = await (isRelay ? relay : mcp)(request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ error: "local_function_error", error_description: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, "127.0.0.1", () => console.log(`local Vercel handlers listening on http://127.0.0.1:${port}/api/{relay,mcp}`));

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > 16 * 1024 * 1024) { reject(new Error("request body exceeds local limit")); request.destroy(); return; } chunks.push(chunk); });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
