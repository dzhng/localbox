import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Adapts Vercel's Node request to the Web handler. Vercel's file routes here match a single path segment, so
 * vercel.json rewrites every deeper path to the one function with the rest of the path in `__path`; the handler
 * sees `/<__path>`. A request that arrives with its original path instead has the first matching prefix stripped.
 */
export async function serveWebRequest(
  handler: (request: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
  pathPrefixes: string[] = [],
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const protocol = header(req, "x-forwarded-proto") ?? "https";
  const host = header(req, "host") ?? "localhost";
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
  const incomingUrl = new URL(req.url ?? "/", `${protocol}://${host}`);
  const rest = incomingUrl.searchParams.get("__path");
  if (rest !== null) { incomingUrl.searchParams.delete("__path"); incomingUrl.pathname = `/${rest}`; }
  else {
    const prefix = pathPrefixes.find((candidate) => incomingUrl.pathname === candidate || incomingUrl.pathname.startsWith(`${candidate}/`));
    if (prefix) incomingUrl.pathname = incomingUrl.pathname.slice(prefix.length) || "/";
  }
  const request = new Request(incomingUrl, {
    method: req.method ?? "GET",
    headers: Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""])),
    body: body?.byteLength ? body : undefined,
  });
  const response = await handler(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
