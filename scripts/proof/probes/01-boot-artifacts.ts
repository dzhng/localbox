import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";

export const id = "01";
export const tiers = ["u", "v"];

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("Duet package parity and manifest digests", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/vm-image-duet-parity.test.ts", "tests/vm-image-guest-protocol.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2000));
    })];
  }
  const artifacts = join(ctx.root, "dist/vm-image/minimal");
  const checks: Check[] = [];
  checks.push(await ctx.check("minimal boot artifacts exist", async () => {
    if (existsSync(join(artifacts, "template.img"))) return;
    const built = await ctx.exec("npm", ["run", "-s", "image:boot", "--", "--profile", "minimal"]);
    if (built.code !== 0) throw new Error(`blocked: could not build the minimal image (Docker/colima running?): ${(built.stderr || built.stdout).slice(-600)}`);
  }));
  checks.push(await ctx.check("a real VM boots, reports ready over vsock and runs uname", async () => {
    const build = await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon"]); assert.equal(build.code, 0, build.stderr.slice(-1500));
    const signed = await ctx.exec("sh", ["scripts/proof/lib/sign-dev.sh"]); assert.equal(signed.code, 0, signed.stderr);
    const bin = (await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim();
    const booted = await ctx.exec(join(bin, "localbox-vmlab"), ["boot", "--artifacts", artifacts, "--json"]);
    const verdict = JSON.parse(booted.stdout.trim().split("\n").at(-1) ?? "{}") as { ready?: boolean; uname?: string; error?: string };
    assert.equal(verdict.ready, true, verdict.error ?? booted.stderr.slice(-1500));
    assert.equal(verdict.uname, "aarch64");
  }));
  return checks;
}
