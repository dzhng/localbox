import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { vmlab, vmlabDir } from "../lib/macos-lab.js";

export const id = "18";
export const tiers = ["m"];

/** Confirm item 4: with SIP off, TCC rows written for the agent's path let its desktop role capture the screen and
 * post a click with no prompt; whether the grant survives a replaced binary decides P6's fallback (recorded, not gated). */
export async function run(ctx: ProofContext): Promise<Check[]> {
  const directory = join(ctx.root, "specs/sandbox-images/evidence"); mkdirSync(directory, { recursive: true });
  let verdict: Record<string, unknown> = {};
  const checks = [await ctx.check("TCC rows grant screen capture, accessibility and event posting to the desktop role", async () => {
    if (!existsSync(join(vmlabDir(), "macos-provisioned", "disk.img"))) throw new Error("blocked: no provisioned macOS base; run npm run proof -- 17 --tier m");
    const result = await vmlab(ctx, ["macos-tcc", "--evidence", directory, "--json"]);
    verdict = result.verdict;
    assert.equal(verdict.ok, true, JSON.stringify(verdict).slice(0, 3000) + result.stderr.slice(-2000));
  })];
  writeFileSync(join(directory, "18-macos-tcc.json"), `${JSON.stringify({ checks: checks.map(({ name, ok, detail }: Check) => ({ name, ok, detail })), ...verdict }, null, 2)}\n`);
  return checks;
}
