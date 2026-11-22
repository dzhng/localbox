import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { buildRealVMs } from "../lib/real-daemon.js";
import { linuxImage } from "../lib/linux-image.js";

export const id = "27";
export const tiers = ["u", "s", "v"];

/** The control lane (vsock 1025) and the `.freezing` lifecycle: freeze never queues behind a request, and a guest thaws itself. */
export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("guest control: self-thaw fires, freeze answers while a request is in flight", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/guest-control.test.ts"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2000));
    })];
  }
  if (ctx.tier === "s") {
    return [await ctx.check("FreezeLockTests: requests wait, idle tick and admission pass a freezing sandbox, shutdown thaws then saves", async () => {
      const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "FreezeLockTests"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2000));
      assert.match(result.stdout + result.stderr, /Executed 7 tests, with 0 failures/);
    })];
  }
  const bin = await buildRealVMs(ctx);
  const image = await linuxImage(ctx);
  let verdict: Record<string, any> = {};
  const checks: Check[] = [];
  checks.push(await ctx.check("freezeAndClone stalls a guest writer, clones the disk, and the writer continues; a freeze whose host never thaws thaws itself", async () => {
    const result = await ctx.exec(join(bin, "localbox-vmlab"), ["freeze", "--image", image, "--json"]);
    verdict = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    assert.equal(verdict.writer_stalled, true, JSON.stringify(verdict) + result.stderr.slice(-2000));
    assert.equal(verdict.phase1?.lifecycle_after, "ready");
    assert.equal(verdict.phase1?.clone, "cloned");
    assert.equal(verdict.writer_continued, true, "the writer continues after the thaw");
    assert.equal(verdict.self_thawed, true, JSON.stringify(verdict.phase2));
    assert.equal(verdict.ok, true);
  }));
  const directory = join(ctx.root, "specs/done/sandbox-images/evidence"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "27-control-lane.json"), `${JSON.stringify({ checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })), vmlab: verdict }, null, 2)}\n`);
  return checks;
}
