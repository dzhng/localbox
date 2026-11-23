import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { IMAGE_FILES } from "../../release.js";
import type { machineAccess } from "./machine-access.js";

const MiB = 1024 ** 2;

/**
 * An image directory laid down as `ImageStore` keeps one: a disk of `bytes` (zeros, or random so a copy has real data
 * to move), an EFI variable store and the manifest naming `imageId`.
 */
export function writeImageFiles(dir: string, imageId: string, disk: { bytes: number; random?: boolean }, agentVersion = "probe"): void {
  mkdirSync(join(dir, dirname(IMAGE_FILES.bootStore)), { recursive: true });
  if (disk.random) {
    // Written a chunk at a time: a GiB of random data is more than one buffer should hold.
    const fd = openSync(join(dir, IMAGE_FILES.disk), "w");
    try { for (let written = 0; written < disk.bytes; written += 64 * MiB) writeSync(fd, randomBytes(Math.min(64 * MiB, disk.bytes - written))); } finally { closeSync(fd); }
  } else writeFileSync(join(dir, IMAGE_FILES.disk), Buffer.alloc(disk.bytes));
  writeFileSync(join(dir, IMAGE_FILES.bootStore), "efi");
  writeFileSync(join(dir, IMAGE_FILES.manifest), JSON.stringify({ image_id: imageId, os: "linux", size_bytes: disk.bytes, disk_bytes: disk.bytes, agent_version: agentVersion }));
}

/**
 * An image held ready on `access`'s machine, as a finished capture leaves it: reserved in Convex, its files in that
 * machine's image store, and its holding reported ready with `reportedBytes` (the disk's size unless given).
 */
export async function seedReadyImage(access: Awaited<ReturnType<typeof machineAccess>>, options: { name: string; createMutationId: string; disk: { bytes: number; random?: boolean }; reportedBytes?: number }): Promise<{ imageId: string; files: string }> {
  const image = await access.mutation("images:reserve", { machineId: access.machineId, name: options.name, os: "linux", source: { kind: "sandbox", sandboxName: "bold-otter" }, createMutationId: options.createMutationId });
  const files = join(access.paths.images, image.image_id);
  writeImageFiles(files, image.image_id, options.disk);
  await access.mutation("images:setHolder", { imageId: image.image_id, state: "ready", sizeBytes: options.reportedBytes ?? options.disk.bytes });
  return { imageId: image.image_id, files };
}
