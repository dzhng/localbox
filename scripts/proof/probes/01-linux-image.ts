import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { linuxImage } from "../lib/linux-image.js";
import { expandImage, IMAGE_PATH, makeManifest, packImage, sha256, verifyRelease } from "../../release.js";
import { pinnedKernelRelease } from "../../../packages/vm-image/src/pins.js";

export const id = "01";
export const tiers = ["u", "v"];

/** The GPT partition type of an EFI system partition, as stored on disk (mixed-endian GUID C12A7328-F81F-11D2-BA4B-00A0C93EC93B). */
const EFI_SYSTEM_PARTITION = Buffer.from("28732ac11ff8d211ba4b00a0c93ec93b", "hex");

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(directory, join(entry.parentPath, entry.name))).sort();
}

/** The built-in linux image: built by the one EFI path, shipped as release artifacts, expanded as an install does, and booted on its pinned kernel. */
export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("Duet package parity, manifest digests, and the release's image packaging", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/vm-image-duet-parity.test.ts", "tests/vm-image-guest-protocol.test.ts", "tests/release.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2000));
    })];
  }
  let image = "";
  const work = mkdtempSync(join(tmpdir(), "localbox-proof-01-"));
  const installed = join(work, "release", IMAGE_PATH);
  const checks: Check[] = [];
  try {
    checks.push(await ctx.check("the image directory holds image.json, disk.img and boot/efi-vars, and no kernel or initrd", async () => {
      image = await linuxImage(ctx, { fresh: true });
      assert.deepEqual(filesUnder(image), ["boot/efi-vars", "disk.img", "image.json"]);
      const manifest = JSON.parse(readFileSync(join(image, "image.json"), "utf8"));
      const agent = JSON.parse(readFileSync(join(ctx.root, "dist/guest-agent/agent-version.json"), "utf8"));
      assert.deepEqual({ image_id: manifest.image_id, os: manifest.os, agent_version: manifest.agent_version }, { image_id: "linux", os: "linux", agent_version: agent.version });
      assert.ok(manifest.size_bytes > 0 && manifest.size_bytes < statSync(join(image, "disk.img")).size, "size_bytes counts allocated bytes of a sparse disk");
    }));
    checks.push(await ctx.check("the disk is GPT with an EFI system partition first", async () => {
      const disk = await open(join(image, "disk.img"), "r");
      try {
        const header = Buffer.alloc(512 + 128); await disk.read(header, 0, header.length, 512);
        assert.equal(header.subarray(0, 8).toString("latin1"), "EFI PART");
        const entries = Number(header.readBigUInt64LE(72));
        const entry = Buffer.alloc(16); await disk.read(entry, 0, 16, entries * 512);
        assert.ok(entry.equals(EFI_SYSTEM_PARTITION), `partition 1 type ${entry.toString("hex")}`);
      } finally { await disk.close(); }
    }));
    checks.push(await ctx.check("packed as release artifacts and expanded as an install does, the image is byte-identical and stays sparse", async () => {
      const download = join(work, "download");
      mkdirSync(download); mkdirSync(join(work, "release", "images"), { recursive: true });
      const shipped = await packImage(image, download, "localbox-linux-proof", { level: 3 });
      const manifest = await makeManifest(download, "0.0.0-proof", `sha256:${"0".repeat(64)}`, undefined, shipped);
      await verifyRelease(download, manifest);
      await expandImage(download, manifest, installed);
      assert.deepEqual(filesUnder(installed), ["boot/efi-vars", "disk.img", "image.json"]);
      for (const file of filesUnder(image)) assert.equal(await sha256(join(installed, file)), await sha256(join(image, file)), file);
      const disk = statSync(join(installed, "disk.img"));
      assert.ok(disk.blocks * 512 < disk.size / 2, `the expanded disk allocates ${disk.blocks * 512} of ${disk.size} bytes`);
    }));
    checks.push(await ctx.check(`the expanded image boots a real VM through EFI on the pinned kernel (${pinnedKernelRelease()}) and the agent answers over vsock`, async () => {
      const build = await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon"]); assert.equal(build.code, 0, build.stderr.slice(-1500));
      const signed = await ctx.exec("sh", ["scripts/proof/lib/sign-dev.sh"]); assert.equal(signed.code, 0, signed.stderr);
      const bin = (await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim();
      const booted = await ctx.exec(join(bin, "localbox-vmlab"), ["boot", "--image", installed, "--json"]);
      const verdict = JSON.parse(booted.stdout.trim().split("\n").at(-1) ?? "{}") as { ready?: boolean; uname?: string; kernel?: string; error?: string };
      assert.equal(verdict.ready, true, verdict.error ?? booted.stderr.slice(-1500));
      assert.equal(verdict.uname, "aarch64");
      assert.equal(verdict.kernel, pinnedKernelRelease());
    }));
  } finally { rmSync(work, { recursive: true, force: true }); }
  return checks;
}
