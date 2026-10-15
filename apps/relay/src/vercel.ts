import type { RelayStateRepository } from "../../../packages/state/src/index.js";
import { RelayHttpAdapter, type RelayHttpAdapterOptions } from "./http.js";

/**
 * Vercel's function boundary is deliberately a thin Web Request adapter. The
 * repository remains the only authority; a function instance never dispatches
 * guest operations or keeps queue state in module globals.
 */
export function createVercelRelayHandler(repository: RelayStateRepository, options: Pick<RelayHttpAdapterOptions, "resource" | "blobProvider" | "blobThresholdBytes" | "maxBodyBytes"> = {}) {
  const adapter = new RelayHttpAdapter({
    repository,
    resource: options.resource,
    blobProvider: options.blobProvider,
    blobThresholdBytes: options.blobThresholdBytes,
    maxBodyBytes: options.maxBodyBytes,
  });
  return async function handle(request: Request): Promise<Response> {
    let parsedBody: unknown;
    try { parsedBody = request.method === "GET" || request.method === "HEAD" ? undefined : await readJson(request, adapter.maxBodyBytes); }
    catch (error) {
      const status = error instanceof RequestBodyError ? error.status : 400;
      return new Response(JSON.stringify({ error: error instanceof RequestBodyError ? error.code : "invalid_json" }), { status, headers: { "content-type": "application/json" } });
    }
    const result = await adapter.handle({
      method: request.method,
      url: request.url,
      headers: requestHeaders(request.headers),
      body: parsedBody,
    });
    const responseBody: BodyInit | undefined = result.body === undefined ? undefined : result.body instanceof Uint8Array ? result.body as unknown as BodyInit : JSON.stringify(result.body);
    return new Response(responseBody, {
      status: result.status,
      headers: result.headers,
    });
  };
}

function requestHeaders(value: Headers | Record<string, string | string[]>): Record<string, string> {
  if (typeof (value as Headers).entries === "function") return Object.fromEntries((value as Headers).entries());
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), Array.isArray(item) ? item.join(", ") : item]));
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await request.text();
  if (!text) return undefined;
  if (Buffer.byteLength(text) > maxBytes) throw new RequestBodyError(413, "payload_too_large");
  try { return JSON.parse(text) as unknown; }
  catch { throw new RequestBodyError(400, "invalid_json"); }
}

class RequestBodyError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

/** Vercel can use this factory from an environment-specific entrypoint. */
export type VercelRelayHandler = ReturnType<typeof createVercelRelayHandler>;
