import assert from "node:assert/strict";
import { test } from "node:test";
import { ConvexError } from "convex/values";
import { contractError } from "../apps/relay/src/ops.js";

test("a Convex refusal carrying a contract code becomes that code", () => {
  const error = contractError(new ConvexError({ code: "name_conflict", message: "taken" }));
  assert.equal(error.code, "name_conflict"); assert.equal(error.retryable, false);
});

test("a Convex platform limit (TooManyWrites) is a retryable internal error, not the caller's input", () => {
  const error = contractError(new ConvexError({ code: "TooManyWrites", message: "Too many writes per second." }));
  assert.equal(error.code, "internal"); assert.equal(error.retryable, true); assert.match(error.message, /Too many writes/);
});
