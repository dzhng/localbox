import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { vmlab, vmlabDir } from "../lib/macos-lab.js";

export const id = "19";
export const tiers = ["m"];

/** Confirm item 5: the darwin vsock forwarder carries framed traffic byte for byte on ports 1024 and 1025, survives
 * host reconnects, and refuses peers other than the host. */
export async function run(ctx: ProofContext): Promise<Check[]> {
  const directory = join(ctx.root, "specs/sandbox-images/evidence"); mkdirSync(directory, { recursive: true });
  let verdict: Record<string, unknown> = {};
  const checks = [await ctx.check("vsock forwarder: 10,016 echoed frames, reconnect, host-only peers", async () => {
    if (!existsSync(join(vmlabDir(), "macos-provisioned", "disk.img"))) throw new Error("blocked: no provisioned macOS base; run npm run proof -- 17 --tier m");
    const result = await vmlab(ctx, ["macos-vsock", "--json"]);
    verdict = result.verdict;
    assert.equal(verdict.ok, true, JSON.stringify(verdict).slice(0, 3000) + result.stderr.slice(-2000));
  })];
  writeFileSync(join(directory, "19-darwin-vsock.json"), `${JSON.stringify({ checks: checks.map(({ name, ok, detail }: Check) => ({ name, ok, detail })), ...verdict }, null, 2)}\n`);
  return checks;
}
