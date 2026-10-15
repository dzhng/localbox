import type { IncomingMessage, ServerResponse } from "node:http";

export async function serveWebRequest(
  handler: (request: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
  pathPrefix = "",
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const protocol = header(req, "x-forwarded-proto") ?? "https";
  const host = header(req, "host") ?? "localhost";
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
  const incomingUrl = new URL(req.url ?? "/", `${protocol}://${host}`);
  if (pathPrefix && incomingUrl.pathname.startsWith(pathPrefix)) {
    incomingUrl.pathname = incomingUrl.pathname.slice(pathPrefix.length) || "/";
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
