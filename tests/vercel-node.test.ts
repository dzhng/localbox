import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { serveWebRequest } from "../apps/relay/src/vercel-node.js";

/** Runs the adapter on a fake Node request and returns the path and query the Web handler saw. */
async function seen(url: string, prefixes: string[]): Promise<string> {
  const req = Object.assign(new PassThrough(), { url, method: "GET", headers: { host: "api.localbox.sh" } }) as unknown as IncomingMessage;
  (req as unknown as PassThrough).end();
  let got = "";
  const res = { statusCode: 0, setHeader() {}, end() {} } as unknown as ServerResponse;
  await serveWebRequest(async (request) => { const parsed = new URL(request.url); got = parsed.pathname + parsed.search; return new Response("ok"); }, req, res, prefixes);
  return got;
}

test("Vercel rewrites hand the rest of the path in __path; the handler sees it as the path", async () => {
  assert.equal(await seen("/api/relay?__path=auth/email/start", ["/api/relay", "/api"]), "/auth/email/start");
  assert.equal(await seen("/api/mcp?__path=metadata&metadata=oauth-protected-resource", ["/api/mcp"]), "/metadata?metadata=oauth-protected-resource");
  assert.equal(await seen("/api/mcp?__path=oauth/authorize&client_id=c", ["/api/mcp"]), "/oauth/authorize?client_id=c");
});

test("a request with its original path has the first matching prefix stripped", async () => {
  assert.equal(await seen("/api/relay/machine-token", ["/api/relay", "/api"]), "/machine-token");
  assert.equal(await seen("/api/v1/ops", ["/api/relay", "/api"]), "/v1/ops");
  assert.equal(await seen("/api/mcp", ["/api/mcp"]), "/");
  assert.equal(await seen("/api/mcpx", ["/api/mcp"]), "/api/mcpx");
});
