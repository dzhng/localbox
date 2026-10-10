import assert from "node:assert/strict";
import { test } from "node:test";
import { VercelBlobProvider, type VercelBlobSdk } from "../packages/blob/src/vercel.js";

test("Vercel blob provider maps private objects to expiring blob references", async () => {
  let now = 10_000;
  const objects = new Map<string, Buffer>();
  const sdk: VercelBlobSdk = {
    async put(pathname, body) { objects.set(pathname, Buffer.from(body as Uint8Array)); return {} as never; },
    async get(pathname) {
      const body = objects.get(pathname as string);
      if (!body) return null;
      return { statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }), headers: new Headers(), blob: { url: "", downloadUrl: "", pathname: pathname as string, contentDisposition: "", cacheControl: "", uploadedAt: new Date(), etag: "etag", contentType: "application/json", size: body.byteLength } } as never;
    },
    async del(pathname) { objects.delete(pathname as string); },
    async issueSignedToken(options) { return { delegationToken: "delegation", clientSigningToken: "client", validUntil: options.validUntil ?? now + 1000 }; },
    async presignUrl(_token, options) { return { presignedUrl: `https://blob.test/${encodeURIComponent(options.pathname)}?expires=${options.validUntil}` }; },
  };
  const provider = new VercelBlobProvider({ token: "token", basePath: "agent", now: () => now, maxTtlMs: 1000, sdk });
  const reference = await provider.put({ body: JSON.stringify({ ok: true }), contentType: "application/json" });
  assert.equal(reference.kind, "agent-computer/blob-reference-v1");
  assert.equal(reference.size_bytes, 11);
  assert.match(reference.sha256, /^sha256:[0-9a-f]{64}$/);
  const stored = await provider.get(reference);
  assert.deepEqual(Buffer.from(stored.body).toString(), JSON.stringify({ ok: true }));
  await provider.delete(reference);
  assert.equal(objects.size, 0);
  now += 1;
});
