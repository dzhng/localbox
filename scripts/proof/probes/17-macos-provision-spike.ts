import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { hasMacOSBase, vmlab } from "../lib/macos-lab.js";

export const id = "17";
export const tiers = ["m"];

/** Confirm item 3: provisioning options instead of Setup Assistant, code in over SSH, SIP disabled through one
 * scripted Recovery session, Remote Login turned off afterwards. No human input at any step. */
export async function run(ctx: ProofContext): Promise<Check[]> {
  const directory = join(ctx.root, "specs/done/sandbox-images/evidence"); mkdirSync(directory, { recursive: true });
  let verdict: Record<string, unknown> = {};
  const checks = [await ctx.check("provisioned, SSH bootstrap ran, SIP disabled in Recovery, Remote Login turns off", async () => {
    if (!hasMacOSBase()) throw new Error("blocked: no cached macOS base; run npm run proof -- 16 --tier m");
    const result = await vmlab(ctx, ["macos-provision", "--evidence", directory, "--json"]);
    verdict = result.verdict;
    assert.equal(verdict.ok, true, JSON.stringify(verdict).slice(0, 3000) + result.stderr.slice(-2000));
  })];
  writeFileSync(join(directory, "17-macos-provision.json"), `${JSON.stringify({ checks: checks.map(({ name, ok, detail }: Check) => ({ name, ok, detail })), ...verdict }, null, 2)}\n`);
  return checks;
}
