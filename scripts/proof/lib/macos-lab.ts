import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProofContext } from "../run.js";

/** Where tier `m` keeps its IPSW and installed macOS base between runs (vmlab reads the same variable). */
export const vmlabDir = () => process.env.LOCALBOX_VMLAB_DIR ?? join(homedir(), ".cache/localbox-vmlab");

/** The cached IPSW: `LOCALBOX_IPSW`, else the newest `.ipsw` in `<lab>/ipsw`. */
export function cachedIpsw(): string | undefined {
  if (process.env.LOCALBOX_IPSW) return process.env.LOCALBOX_IPSW;
  const directory = join(vmlabDir(), "ipsw");
  if (!existsSync(directory)) return undefined;
  const found = readdirSync(directory).filter((name) => name.endsWith(".ipsw")).sort().at(-1);
  return found && join(directory, found);
}

export const hasMacOSBase = () => existsSync(join(vmlabDir(), "macos-base", "disk.img"));

/** Build and sign vmlab, then run one of its commands; the last stdout line is its JSON verdict. */
export async function vmlab(ctx: ProofContext, args: string[]): Promise<{ verdict: Record<string, unknown>; stderr: string }> {
  const build = await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon"]);
  if (build.code !== 0) throw new Error(build.stderr.slice(-1500));
  if ((await ctx.exec("sh", ["scripts/proof/lib/sign-dev.sh"])).code !== 0) throw new Error("could not sign the dev build");
  const bin = (await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim();
  const result = await ctx.exec(join(bin, "localbox-vmlab"), args, { env: { LOCALBOX_VMLAB_DIR: vmlabDir() } });
  return { verdict: JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>, stderr: result.stderr };
}
