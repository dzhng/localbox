import assert from "node:assert/strict";
import type { Check, ProofContext } from "../run.js";

export const id = "04";
// Tier l (the same checks through fixture machine A's CLI) needs slice 03's fixture machine; it is added there.
export const tiers = ["u"];

export async function run(ctx: ProofContext): Promise<Check[]> {
  return [await ctx.check("900 KiB cap, fs.read and job.output paging, real background jobs", async () => {
    const result = await ctx.exec("npx", ["tsx", "--test", "tests/output-cap.test.ts", "tests/guest-jobs.test.ts", "tests/guest-gateway.test.ts"]);
    assert.equal(result.code, 0, result.stdout.slice(-2000));
  })];
}
