import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { machinePaths } from "../../../packages/config/src/machine-paths.js";
import type { Check, ProofContext } from "../run.js";
import { forwardedHeaders } from "../../local-vercel-ip.js";

export const id = "00";
export const tiers = ["u", "l"];
export async function run(ctx: ProofContext): Promise<Check[]> {
  const checks: Check[] = [];
  if (ctx.tier === "u") {
    checks.push(await ctx.check("machine paths default", () => {
      const paths = machinePaths({ HOME: "/tmp/ignored" });
      assert.match(paths.credentials, /\.config\/localbox\/credentials\.json$/);
      assert.match(paths.root, /Library\/Application Support\/Localbox$/);
      assert.equal(paths.socket, `${paths.root}/agent.sock`);
    }));
    checks.push(await ctx.check("machine paths relocation", () => {
      const paths = machinePaths({ LOCALBOX_MACHINE_ROOT: "/tmp/proof-machine" });
      assert.deepEqual(paths, { root: "/tmp/proof-machine", credentials: "/tmp/proof-machine/credentials.json", ipcToken: "/tmp/proof-machine/ipc-token", socket: "/tmp/proof-machine/agent.sock", sandboxes: "/tmp/proof-machine/sandboxes", logs: "/tmp/proof-machine/logs" });
    }));
    checks.push(await ctx.check("verdict evidence directory", () => assert.equal(existsSync(ctx.evidence), true)));
  } else if (ctx.tier === "l") {
    const stack = await ctx.stack("up", ["a", "b"]);
    if (stack.code !== 0) throw new Error(`blocked: local Convex could not start: ${stack.stderr.trim() || stack.stdout.trim()}`);
    try {
      checks.push(await ctx.check("relay fails closed", async () => { const response = await fetch("http://127.0.0.1:3000/api/relay/status"); assert.equal(response.status, 401); }));
      checks.push(await ctx.check("forwarded headers use socket address", async () => {
        const response = await fetch("http://127.0.0.1:3000/api/relay/status", { headers: { "x-forwarded-for": "192.0.2.44", "x-real-ip": "192.0.2.44", "x-vercel-forwarded-for": "192.0.2.44" } }); assert.equal(response.status, 401);
        assert.equal(forwardedHeaders({ "x-forwarded-for": "192.0.2.44" }, "127.0.0.1")["x-forwarded-for"], "127.0.0.1");
      }));
    } finally { if (!ctx.keep) await ctx.stack("down"); }
    checks.push(await ctx.check("stack teardown", async () => { const status = await ctx.stack("status"); assert.match(status.stdout, /"convex":false/); assert.match(status.stdout, /"devLocal":false/); }));
  }
  return checks;
}
