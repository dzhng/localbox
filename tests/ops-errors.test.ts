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

test("an IPv6 address keys its /64; IPv4 and IPv4-mapped addresses key themselves", async () => {
  const { ipKey } = await import("../packages/state/convex/lib/relay.js");
  assert.equal(ipKey("2001:db8:0:1:aaaa::1"), "2001:db8:0:1::/64");
  assert.equal(ipKey("2001:0DB8:0000:0001:ffff:ffff:ffff:ffff"), "2001:db8:0:1::/64");
  assert.equal(ipKey("::1"), "0:0:0:0::/64");
  assert.equal(ipKey("::ffff:198.51.100.7"), "198.51.100.7");
  assert.equal(ipKey("198.51.100.7"), "198.51.100.7");
});
