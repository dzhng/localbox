import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { checkHost } from "../../../apps/cli/src/host-check.js";
import { linuxImage } from "../lib/linux-image.js";

export const id = "15";
export const tiers = ["v"];

/** L1's go/no-go: a Linux guest booting from its own GPT disk through EFI firmware (GRUB, kernel on the disk). */
export async function run(ctx: ProofContext): Promise<Check[]> {
  let image = "";
  const evidence: Record<string, unknown> = {};
  const checks: Check[] = [];
  checks.push(await ctx.check("the dev linux image (an EFI disk) exists", async () => { image = await linuxImage(ctx); }));
  const build = await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon"]); assert.equal(build.code, 0, build.stderr.slice(-1500));
  assert.equal((await ctx.exec("sh", ["scripts/proof/lib/sign-dev.sh"])).code, 0);
  const bin = (await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim();
  const vmlab = async (command: string) => {
    const result = await ctx.exec(join(bin, "localbox-vmlab"), [command, "--image", image, "--json"]);
    const verdict = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    evidence[command] = verdict;
    return { verdict, stderr: result.stderr };
  };
  checks.push(await ctx.check("EFI configuration validates for save/restore and boots to the guest agent", async () => {
    const { verdict, stderr } = await vmlab("boot");
    assert.equal(verdict.ready, true, String(verdict.error ?? stderr.slice(-3000)));
    assert.equal(verdict.uname, "aarch64");
  }));
  checks.push(await ctx.check("hibernate, restore in a new process: same PID, counter running, NAT", async () => {
    const host = checkHost();
    if (host.hibernate !== "available" && host.screen_locked_now) throw new Error("blocked: the Mac's screen is locked; unlock it to run the save/restore scenario");
    const { verdict, stderr } = await vmlab("hibernate");
    assert.equal(verdict.process_survived, true, JSON.stringify(verdict).slice(0, 1500) + stderr.slice(-1500));
    assert.equal(verdict.nat_ok, true);
  }));
  checks.push(await ctx.check("apt-installing another kernel takes effect on reboot and vsock still answers", async () => {
    const { verdict, stderr } = await vmlab("efi-kernel");
    assert.equal(verdict.ok, true, JSON.stringify(verdict) + stderr.slice(-2000));
  }));
  checks.push(await ctx.check("two clones with copies of one variable store boot at once", async () => {
    const { verdict, stderr } = await vmlab("efi-clones");
    assert.equal(verdict.ok, true, JSON.stringify(verdict) + stderr.slice(-2000));
  }));
  const directory = join(ctx.root, "specs/sandbox-images/evidence"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "15-efi.json"), `${JSON.stringify({ checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })), ...evidence }, null, 2)}\n`);
  return checks;
}
