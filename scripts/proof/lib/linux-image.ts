import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BUILT_IN_IMAGE } from "../../../packages/contract/src/index.js";
import { IMAGE_FILES, replaceLinuxImage } from "../../release.js";
import type { ProofContext } from "../run.js";

const execFileAsync = promisify(execFile);

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

/**
 * Seeds a probe machine's `images/linux` from the image directory `image`: an APFS clone (sharing every block, so it
 * costs no space) assembled under a dot-prefixed name, which `ImageStore` sweeps if a crash leaves it, then swapped in
 * by `replaceLinuxImage`. On a real Mac `localbox app image ensure` is the only writer of `images/linux`.
 */
export async function installLinuxImage(image: string, imagesDir: string): Promise<void> {
  const temporary = join(imagesDir, `.${BUILT_IN_IMAGE}.installing-${process.pid}`);
  await rm(temporary, { recursive: true, force: true });
  await mkdir(join(temporary, dirname(IMAGE_FILES.bootStore)), { recursive: true });
  // `cp -c` is clonefile(2); Node's COPYFILE_FICLONE has no clone on macOS and its fallback writes out every hole. A
  // plain `cp` covers images on another volume, where nothing can be cloned.
  for (const file of Object.values(IMAGE_FILES)) {
    const [from, to] = [join(image, file), join(temporary, file)];
    await execFileAsync("cp", ["-c", from, to]).catch(() => execFileAsync("cp", [from, to]));
  }
  await replaceLinuxImage(temporary, imagesDir);
}
