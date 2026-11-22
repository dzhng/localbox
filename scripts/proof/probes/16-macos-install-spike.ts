import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { cachedIpsw, hasMacOSBase, vmlab } from "../lib/macos-lab.js";

export const id = "16";
export const tiers = ["m"];

/** Confirm item 2: a macOS guest installs from an IPSW, clones with new identifiers run side by side, the suspendable
 * device set saves and restores, and a third concurrent macOS VM is refused. */
export async function run(ctx: ProofContext): Promise<Check[]> {
  const evidence: Record<string, unknown> = {};
  const checks: Check[] = [];
  checks.push(await ctx.check("macOS base installed from the IPSW (cached after the first run)", async () => {
    if (hasMacOSBase()) { evidence.install = "cached"; return; }
    const ipsw = cachedIpsw();
    if (!ipsw) throw new Error("blocked: no IPSW; set LOCALBOX_IPSW or put one in <lab>/ipsw");
    const { verdict, stderr } = await vmlab(ctx, ["macos-install", "--ipsw", ipsw, "--json"]);
    evidence.install = verdict;
    assert.equal(verdict.ok, true, String(verdict.error ?? stderr.slice(-2000)));
  }));
  checks.push(await ctx.check("two clones with new identifiers run at once; a third is refused by the system limit", async () => {
    const { verdict, stderr } = await vmlab(ctx, ["macos-clones", "--json"]);
    evidence.clones = verdict;
    assert.equal(verdict.ok, true, JSON.stringify(verdict) + stderr.slice(-2000));
  }));
  checks.push(await ctx.check("save in one process, restore in another, still running", async () => {
    const { verdict, stderr } = await vmlab(ctx, ["macos-hibernate", "--json"]);
    evidence.hibernate = verdict;
    assert.equal(verdict.ok, true, JSON.stringify(verdict) + stderr.slice(-2000));
  }));
  const directory = join(ctx.root, "specs/done/sandbox-images/evidence"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "16-macos-install.json"), `${JSON.stringify({ checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })), ...evidence }, null, 2)}\n`);
  return checks;
}
