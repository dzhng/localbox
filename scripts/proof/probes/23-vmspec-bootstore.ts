import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { checkHost } from "../../../apps/cli/src/host-check.js";

export const id = "23";
export const tiers = ["s", "v"];

/** One pure `VMSpec` per sandbox and one translator to a Virtualization configuration. */
export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "s") {
    return [await ctx.check("VMSpecTests: Linux EFI has no command line, macOS has no entropy, restore inputs come from the record and its directory", async () => {
      const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "VMSpecTests"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2000));
      assert.match(result.stdout + result.stderr, /Executed \d+ tests, with 0 failures/);
    })];
  }
  const artifacts = join(ctx.root, "dist/vm-image/minimal-efi");
  const checks: Check[] = [];
  checks.push(await ctx.check("minimal EFI disk exists", async () => {
    if (existsSync(join(artifacts, "template.img"))) return;
    const built = await ctx.exec("npm", ["run", "-s", "image:boot", "--", "--profile", "minimal", "--boot", "efi"]);
    if (built.code !== 0) throw new Error(`blocked: could not build the minimal EFI image (Docker/colima running?): ${(built.stderr || built.stdout).slice(-600)}`);
  }));
  const build = await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon"]); assert.equal(build.code, 0, build.stderr.slice(-1500));
  assert.equal((await ctx.exec("sh", ["scripts/proof/lib/sign-dev.sh"])).code, 0);
  const bin = (await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim();
  const vmlab = async (command: string) => {
    const result = await ctx.exec(join(bin, "localbox-vmlab"), [command, "--artifacts", artifacts, "--efi", "--json"]);
    return { verdict: JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, any>, stderr: result.stderr };
  };
  checks.push(await ctx.check("the EFI disk boots through the production translator", async () => {
    const { verdict, stderr } = await vmlab("boot");
    assert.equal(verdict.ready, true, String(verdict.error ?? stderr.slice(-3000)));
    assert.equal(verdict.uname, "aarch64");
  }));
  checks.push(await ctx.check("it hibernates and restores in a new process; restore refuses a changed CPU count, MAC or machine identifier", async () => {
    const host = checkHost();
    if (host.hibernate !== "available" && host.screen_locked_now) throw new Error("blocked: the Mac's screen is locked; unlock it to run the save/restore scenario");
    const { verdict, stderr } = await vmlab("hibernate");
    assert.equal(verdict.process_survived, true, JSON.stringify(verdict).slice(0, 1500) + stderr.slice(-1500));
    assert.equal(verdict.mac_matches, true); assert.equal(verdict.nat_ok, true);
    const sweep = verdict.phase2?.identity_sweep ?? {};
    for (const field of ["cpu_count", "mac_address", "machine_identifier"]) assert.match(String(sweep[field]), /^refused/, `${field}: ${sweep[field]}`);
  }));
  return checks;
}
