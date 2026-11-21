import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProofContext } from "../run.js";

/**
 * The dev `linux` image, laid out as `ImageStore` reads it (`image.json`, `disk.img`, `boot/efi-vars`): the minimal
 * profile, built by the same path as the release's (which ships `full`). An existing one is reused unless `fresh`
 * (which rebuilds when its inputs, the guest agent included, changed).
 */
export async function linuxImage(ctx: ProofContext, options: { fresh?: boolean } = {}): Promise<string> {
  const image = join(ctx.root, "dist/vm-image/images/linux");
  if (!options.fresh && existsSync(join(image, "image.json"))) return image;
  const built = await ctx.exec("npm", ["run", "-s", "image:boot", "--", "--profile", "minimal", "--out", image]);
  if (built.code !== 0) throw new Error(`blocked: could not build the dev linux image (Docker/colima running?): ${(built.stderr || built.stdout).slice(-600)}`);
  return image;
}
