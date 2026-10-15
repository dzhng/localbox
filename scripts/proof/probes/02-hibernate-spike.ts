import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { checkHost } from "../../../apps/cli/src/host-check.js";

export const id = "02";
export const tiers = ["u", "v"];

/** Apple's VM service creates the saved-state key in the keychain, which refuses while the console is locked. */
const screenLocked = () => { const host = checkHost(); return host.hibernate !== "available" && host.screen_locked_now; };

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [
      await ctx.check("guest adopts newer epoch from hello, rejects older", async () => {
        const result = await ctx.exec("npx", ["tsx", "--test", "tests/guest-service.test.ts"]);
        assert.equal(result.code, 0, result.stdout.slice(-2000));
      }),
      await ctx.check("host sends hello one epoch past the guest's (Swift)", async () => {
        const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "testFramedGuestChannelSpeaksTheGuestFrameProtocol"]);
        assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2000));
      }),
    ];
  }
  const artifacts = join(ctx.root, "dist/vm-image/minimal");
  const build = await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon"]); assert.equal(build.code, 0, build.stderr.slice(-1500));
  assert.equal((await ctx.exec("sh", ["scripts/proof/lib/sign-dev.sh"])).code, 0);
  const bin = (await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim();
  const hibernate = async () => {
    const result = await ctx.exec(join(bin, "localbox-vmlab"), ["hibernate", "--artifacts", artifacts, "--json"]);
    const verdict = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    writeFileSync(join(ctx.evidence, `02-hibernate-${screenLocked() ? "locked" : "unlocked"}.json`), `${JSON.stringify(verdict, null, 2)}\n`);
    return verdict;
  };
  const locked = screenLocked();
  return [
    await ctx.check("with the screen locked, save fails on the keychain (the recorded constraint)", async () => {
      if (!locked) return; // only observable while locked; the run below covers the unlocked Mac
      const verdict = await hibernate();
      assert.equal(verdict.ok, false); assert.match(String(verdict.error), /permission denied/);
    }),
    await ctx.check("unlocked: hibernate, restore in a new process, same PID, counter running, NAT and clock within 2 s", async () => {
      if (locked) throw new Error("blocked: the Mac's screen is locked; unlock it to run the save/restore scenario");
      const verdict = await hibernate();
      assert.equal(verdict.ok, true, verdict.error ?? JSON.stringify(verdict).slice(0, 1500));
      assert.equal(verdict.process_survived, true); assert.equal(verdict.mac_matches, true); assert.equal(verdict.nat_ok, true);
      const before = Number(([] as unknown[]).concat(verdict.phase1.counter_before).at(-1));
      assert.ok(verdict.phase2.counter_after > before, `the counter keeps counting after restore (${before} -> ${verdict.phase2.counter_after})`);
      assert.equal(verdict.phase2.nat_http_code_after, "200");
      assert.ok(Math.abs(verdict.phase2.clock_skew_ms) < 2000, `clock skew ${verdict.phase2.clock_skew_ms} ms`);
    }),
  ];
}
