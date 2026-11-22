import assert from "node:assert/strict";
import type { Check, ProofContext } from "../run.js";

export const id = "24";
export const tiers = ["s"];

/** Images live on a Mac as files under one owner, `ImageStore`, and sandboxes are provisioned from them. */
export async function run(ctx: ProofContext): Promise<Check[]> {
  return [
    await ctx.check("ImageStoreTests: an interrupted commit is swept, clones are thin, remove keeps clones whole, free bytes match statfs", async () => {
      const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "ImageStoreTests|testCapacityReportsFreeDiskAndTheMacOSVersion"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2000));
      // At least the six this probe was written with; the suite grows.
      const ran = Math.max(0, ...[...(result.stdout + result.stderr).matchAll(/Executed (\d+) tests, with 0 failures/g)].map((match) => Number(match[1])));
      assert.ok(ran >= 6, `ran ${ran} tests`);
    }),
    await ctx.check("machinePaths() names the images directory under the machine root", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/machine-paths.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2000));
    }),
  ];
}
