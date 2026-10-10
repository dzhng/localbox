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
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readJson(request);
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

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; }
  catch { return text; }
}

/** Vercel can use this factory from an environment-specific entrypoint. */
export type VercelRelayHandler = ReturnType<typeof createVercelRelayHandler>;
