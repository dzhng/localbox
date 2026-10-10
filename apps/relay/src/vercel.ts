import type { RelayStateRepository } from "../../../packages/state/src/index.js";
import { RelayHttpAdapter } from "./http.js";

/**
 * Vercel's function boundary is deliberately a thin Web Request adapter. The
 * repository remains the only authority; a function instance never dispatches
 * guest operations or keeps queue state in module globals.
 */
export function createVercelRelayHandler(repository: RelayStateRepository, options: { resource?: string } = {}) {
  const adapter = new RelayHttpAdapter({ repository, resource: options.resource });
  return async function handle(request: Request): Promise<Response> {
    let body: unknown;
    try { body = request.method === "GET" || request.method === "HEAD" ? undefined : await readJson(request, adapter.maxFrameBytes); }
    catch (error) {
      const status = error instanceof RequestBodyError ? error.status : 400;
      return new Response(JSON.stringify({ error: error instanceof RequestBodyError ? error.code : "invalid_json" }), { status, headers: { "content-type": "application/json" } });
    }
    const result = await adapter.handle({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    });
    return new Response(result.body === undefined ? undefined : JSON.stringify(result.body), {
      status: result.status,
      headers: result.headers,
    });
  };
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
