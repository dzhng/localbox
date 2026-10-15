import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Check, ProofContext } from "../run.js";
import { calls } from "../../../tests/fixtures/convex-public-functions.js";

export const id = "05";
export const tiers = ["u", "l"];

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("every public function guarded; revocation per call", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/convex-auth.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2000));
    })];
  }
  const up = await ctx.stack("up");
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  try {
    const url = readFileSync(join(ctx.root, ".env.local"), "utf8").match(/^CONVEX_URL=(.*)$/m)?.[1]?.trim();
    assert.ok(url, "CONVEX_URL missing from .env.local");
    const call = (client: ConvexHttpClient, entry: (typeof calls)[number]) => {
      const ref = makeFunctionReference(entry.name) as any;
      return entry.mutation ? client.mutation(ref, entry.args) : client.query(ref, entry.args);
    };
    const checks = [await ctx.check(`anonymous client refused by all ${calls.length} public functions`, async () => {
      const anonymous = new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true });
      for (const entry of calls) await assert.rejects(() => call(anonymous, entry), /Unauthenticated/, entry.name);
    })];
    checks.push(await ctx.check("service JWT signed with the stack key is accepted", async () => {
      process.env.LOCALBOX_JWT_PRIVATE_KEY = readFileSync(join(ctx.root, ".localbox/proof/keys/jwt-private.pem"), "utf8");
      process.env.LOCALBOX_API_ORIGIN = "http://127.0.0.1:3000";
      const { signServiceToken } = await import("../../../packages/tokens/src/index.js");
      const service = new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true }); service.setAuth(signServiceToken());
      assert.equal(await service.query(makeFunctionReference("oauth:client") as any, { clientId: "client_none" }), null);
    }));
    return checks;
  } finally { if (!ctx.keep) await ctx.stack("down"); }
}
