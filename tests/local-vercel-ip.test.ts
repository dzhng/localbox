import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardedHeaders } from "../scripts/local-vercel-ip.js";

test("local Vercel rewrites spoofable forwarding headers to the socket address", () => {
  assert.deepEqual(forwardedHeaders({ "x-forwarded-for": "192.0.2.9", "x-real-ip": "192.0.2.9", "x-vercel-forwarded-for": "192.0.2.9" }, "127.0.0.1"), { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1", "x-vercel-forwarded-for": "127.0.0.1" });
});

test("the explicit dev knob preserves a probe client IP", () => {
  const headers = forwardedHeaders({ "x-forwarded-for": "192.0.2.9" }, "127.0.0.1", true);
  assert.equal(headers["x-forwarded-for"], "192.0.2.9"); assert.equal(headers["x-real-ip"], "192.0.2.9"); assert.equal(headers["x-vercel-forwarded-for"], "192.0.2.9");
});
