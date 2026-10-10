import assert from "node:assert/strict";
import { test } from "node:test";
import { collectEgressDiagnostics } from "../packages/guest-gateway/src/egress.js";

test("egress diagnostics report observed facts and actionable failures", async () => {
  const report = await collectEgressDiagnostics({ now: () => new Date("2026-01-01T00:00:00.000Z"), httpsProbe: async () => { throw new Error("captive portal"); }, dnsProbe: async () => { throw new Error("resolver down"); }, interfaceProbe: async () => ({ interface: "en0" }) });
  assert.equal(report.connected, false);
  assert.equal(report.interface, "en0");
  assert.match(report.diagnostics.join(" "), /captive portal|resolver/i);
});
