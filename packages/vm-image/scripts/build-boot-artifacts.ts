import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { artifactDigests, buildImageManifest, digestJson, type ImageBuildPins } from "../src/manifest.js";
import { DUET_REQUIRED_TOOL_INVENTORY } from "../src/duet-inventory.js";

type Profile = "minimal" | "full";
const root = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const profileArg = process.argv.slice(2).find((arg) => arg === "minimal" || arg === "full") ?? "minimal";
const profile = profileArg as Profile;
const baseImage = process.env.LOCALBOX_BASE_IMAGE ?? "ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55";
if (!/@sha256:[0-9a-f]{64}$/i.test(baseImage)) throw new Error("LOCALBOX_BASE_IMAGE must be an immutable @sha256:… reference");
// `--boot efi` writes a GPT disk (EFI system partition plus the ext4 root) that boots through GRUB, so the kernel lives
// on the disk; the default writes the bare ext4 root the host boots with its own kernel and initrd.
const bootArg = process.argv[process.argv.indexOf("--boot") + 1];
const boot = process.argv.includes("--boot") ? bootArg : "direct";
if (boot !== "direct" && boot !== "efi") throw new Error(`--boot must be direct or efi, not ${bootArg}`);
const outputRoot = resolve(process.env.IMAGE_OUTPUT_DIR ?? "dist/vm-image");
const output = join(outputRoot, boot === "efi" ? `${profile}-efi` : profile);
const buildVersion = process.env.IMAGE_BUILD_VERSION ?? "dev";
const substitutions = [
  { from: "x86_64 release downloads", to: "ARM64 release downloads", reason: "Bun, static-web-server, KasmVNC, and Google Chrome are fetched from their native ARM64 release assets at the Duet versions." },
  { from: "boldsoftware/exeuntu", to: "ubuntu:24.04 ARM64", reason: "The Duet base is private and has no published ARM64 image available to this build; Ubuntu is pinned by digest." },
  { from: "Duet gateway, Syncthing, Duet runtime, systemd units, branding", to: "omitted", reason: "These services belong to Duet; Localbox owns the guest agent and boot unit." },
];

function run(command: string, args: string[], options: { stdout?: "pipe" | "inherit" } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", options.stdout === "inherit" ? "inherit" : "pipe", "inherit"] });
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
  });
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

async function inputDigest(): Promise<string> {
  const hash = createHash("sha256");
  // Everything the Dockerfile COPYs is an input (a changed guest agent in dist/ must produce a new image), and so is
  // this script, which edits the root filesystem after the build. dist/vm-image and dist/release are outputs, kept out
  // of the image by .dockerignore.
  const copied = ["packages/vm-image/scripts/build-boot-artifacts.ts", "packages/vm-image/Dockerfile.arm64", "packages/vm-image/requirements-arm64.txt", "packages/vm-image/duet-reference/Dockerfile",
    ...await filesUnder("packages/vm-image/duet-reference/desktop"), ...await filesUnder("packages/vm-image/desktop"), ...(await filesUnder("dist")).filter((path) => !path.startsWith("dist/vm-image/") && !path.startsWith("dist/release/"))];
  for (const path of copied.sort()) { hash.update(path); hash.update(await readFile(join(root, path))); }
  hash.update(profile);
  hash.update(boot);
  hash.update(baseImage);
  return `sha256:${hash.digest("hex")}`;
}

async function extractKernel(container: string, destination: string, prefix: string): Promise<void> {
  const boot = join(destination, "boot");
  await mkdir(boot, { recursive: true });
  const copied = join(destination, `${prefix}.compressed`);
  const entries = await readdir(boot);
  const source = entries.filter((entry) => entry.startsWith(`${prefix}-`)).sort().at(-1);
  if (!source) throw new Error(`container has no ${prefix} artifact`);
  await cp(join(boot, source), copied);
  const bytes = await readFile(copied);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    await run("sh", ["-c", `gzip -dc ${JSON.stringify(copied)} > ${JSON.stringify(join(destination, prefix))}`]);
  } else {
    await cp(copied, join(destination, prefix));
  }
  await rm(copied, { force: true });
}

// Reads `docker export` on stdin and writes /out/template.img. Docker's pseudo-filesystem entries (/dev, /proc, /sys,
// /run) are created by systemd at boot and cannot be represented by mke2fs -d; .dockerenv would make systemd treat the
// VM as a container; firmware is for hardware a VM does not have. Docker owns /etc/resolv.conf during a build. In the
// VM it lists the NAT's DHCP-provided DNS server directly (resolved's uplink file), not resolved's stub: after a
// restore networkd reports no carrier for ~5 s, and the stub refuses every lookup until it clears, although the
// network itself answers within ~250 ms.
const TEMPLATE_SCRIPT = [
  "set -euo pipefail",
  "apt-get update >/dev/null </dev/null && apt-get install -y --no-install-recommends e2fsprogs >/dev/null </dev/null",
  "mkdir /rootfs && tar -xpf - -C /rootfs --numeric-owner",
  "rm -rf /rootfs/var/lib/snapd /rootfs/dev /rootfs/proc /rootfs/sys /rootfs/run /rootfs/.dockerenv /rootfs/usr/lib/firmware",
  "mkdir -p /rootfs/dev /rootfs/proc /rootfs/sys /rootfs/run /rootfs/usr/lib/firmware",
  "rm -f /rootfs/etc/resolv.conf && ln -s ../run/systemd/resolve/resolv.conf /rootfs/etc/resolv.conf",
  "truncate -s 8G /out/template.img && mke2fs -q -t ext4 -L localbox -d /rootfs /out/template.img",
].join("; ");

// The EFI layout: GRUB on the EFI system partition at the removable path (the variable store starts empty, so firmware
// boots /EFI/BOOT/BOOTAA64.EFI) finds the root by its label and loads /boot/vmlinuz and /boot/initrd.img. Those are the
// symlinks the kernel packages repoint on every install, so `apt install` of a kernel takes effect on the next boot
// without regenerating any GRUB config; update-grub is disabled because grub-mkconfig would replace this file.
// The root is partition 2 at 101 MiB, written into the GPT disk sparsely; the disk is assembled in the container and
// copied out with its holes. sgdisk has no quiet flag: an unknown one makes it exit 0 having written an empty table,
// hence the EF00 check.
const GRUB_CONFIG = "set timeout=0\\nlinux /boot/vmlinuz root=LABEL=localbox rw console=hvc0\\ninitrd /boot/initrd.img\\nboot\\n";
// No `$` anywhere: the script reaches bash inside an outer double-quoted `sh -c`, which would expand it.
const GRUB_EMBEDDED = "search --no-floppy --label localbox --set root\\nconfigfile /boot/grub/grub.cfg\\n";
const EFI_TEMPLATE_SCRIPT = [
  "set -euo pipefail",
  "apt-get update >/dev/null </dev/null && apt-get install -y --no-install-recommends e2fsprogs dosfstools mtools gdisk grub-efi-arm64-bin >/dev/null </dev/null",
  "mkdir /rootfs && tar -xpf - -C /rootfs --numeric-owner",
  "rm -rf /rootfs/var/lib/snapd /rootfs/dev /rootfs/proc /rootfs/sys /rootfs/run /rootfs/.dockerenv /rootfs/usr/lib/firmware",
  "mkdir -p /rootfs/dev /rootfs/proc /rootfs/sys /rootfs/run /rootfs/usr/lib/firmware /rootfs/boot/grub",
  "rm -f /rootfs/etc/resolv.conf && ln -s ../run/systemd/resolve/resolv.conf /rootfs/etc/resolv.conf",
  `printf '${GRUB_CONFIG}' > /rootfs/boot/grub/grub.cfg`,
  "if [ -e /rootfs/usr/sbin/update-grub ]; then ln -sf /bin/true /rootfs/usr/sbin/update-grub; fi",
  `printf '${GRUB_EMBEDDED}' > /tmp/embed.cfg`,
  "grub-mkimage -O arm64-efi -o /tmp/BOOTAA64.EFI -c /tmp/embed.cfg -p /boot/grub part_gpt ext2 fat normal linux search search_label configfile echo gzio boot",
  "truncate -s 100M /tmp/esp.img && mkfs.vfat -F 32 -n EFI /tmp/esp.img >/dev/null && mmd -i /tmp/esp.img ::/EFI ::/EFI/BOOT && mcopy -i /tmp/esp.img /tmp/BOOTAA64.EFI ::/EFI/BOOT/BOOTAA64.EFI",
  "truncate -s 8G /tmp/root.img && mke2fs -q -t ext4 -L localbox -d /rootfs /tmp/root.img",
  "truncate -s 8294M /tmp/disk.img",
  "sgdisk -n1:2048:+100M -t1:ef00 -c1:esp -n2:206848:+8192M -t2:8300 -c2:root /tmp/disk.img >/dev/null",
  "dd if=/tmp/esp.img of=/tmp/disk.img bs=1M seek=1 conv=notrunc status=none",
  "dd if=/tmp/root.img of=/tmp/disk.img bs=1M seek=101 conv=notrunc,sparse status=none",
  "sgdisk -p /tmp/disk.img | grep -q ' EF00 '",
  "cp --sparse=always /tmp/disk.img /out/template.img",
].join("; ");

const digest = await inputDigest();
const existing = join(output, "manifest.json");
try {
  const cached = JSON.parse(await readFile(existing, "utf8")) as { buildInputsDigest?: string; profile?: string };
  if (cached.buildInputsDigest === digestJson({ profile, baseImage, inputDigest: digest }) && cached.profile === profile) {
    console.log(JSON.stringify({ cached: true, profile, output }));
    process.exit(0);
  }
} catch { /* no cache */ }

await run("npm", ["run", "build"]);
const tag = `localbox-vm:${profile}-${digest.slice(-12)}`;
await run("docker", ["build", "--platform", "linux/arm64", "--file", join(root, "packages/vm-image/Dockerfile.arm64"), "--build-arg", `PROFILE=${profile}`, "--build-arg", `BASE_IMAGE=${baseImage}`, "--build-arg", `IMAGE_BUILD_VERSION=${buildVersion}`, "--tag", tag, root], { stdout: "inherit" });
const container = (await run("docker", ["create", "--platform", "linux/arm64", tag])).trim();
const staging = join(outputRoot, `.staging-${profile}-${process.pid}`);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
try {
  await mkdir(join(staging, "boot"), { recursive: true });
  await run("docker", ["cp", `${container}:/boot/.`, join(staging, "boot")]);
  await extractKernel(container, staging, "vmlinuz");
  await extractKernel(container, staging, "initrd.img");
  const template = join(staging, "template.img");
  // The root filesystem is unpacked inside Linux, never on the Mac: a macOS checkout is case-insensitive and
  // unprivileged, so it would merge case-distinct paths (kernel headers have them) and drop ownership and setuid bits.
  await run("sh", ["-c", `docker export ${container} | docker run -i --rm --platform linux/arm64 -v ${JSON.stringify(`${staging}:/out`)} ${baseImage} bash -c ${JSON.stringify(boot === "efi" ? EFI_TEMPLATE_SCRIPT : TEMPLATE_SCRIPT)}`]);
  await mkdir(output, { recursive: true });
  await cp(join(staging, "vmlinuz"), join(output, "kernel"));
  await cp(join(staging, "initrd.img"), join(output, "initrd"));
  // A move, not a copy: copying would write out the sparse disk's unused 8 GiB.
  await rename(template, join(output, "template.img"));
  const pins: ImageBuildPins = {
    schemaVersion: "agent-computer-image-build.v1", architecture: "arm64", baseImage,
    baseSnapshot: "ubuntu-24.04-pinned", packages: { nodejs: "24.x", bun: "1.3.14", staticWebServer: "2.43.0", kasmvnc: "1.5.0" },
    pythonRequirementsSha256: `sha256:${createHash("sha256").update(await readFile(join(root, "packages/vm-image/requirements-arm64.txt"))).digest("hex")}`,
    buildVersion, display: { width: 1440, height: 900 }, loopbackBindings: ["127.0.0.1:9222", "127.0.0.1:6901"], readinessMarker: "/run/localbox/ready",
  };
  const artifacts = await artifactDigests(output);
  const manifest = buildImageManifest({ pins, artifacts, profile, substitutions, tools: DUET_REQUIRED_TOOL_INVENTORY });
  const withInput = { ...manifest, buildInputsDigest: digestJson({ profile, baseImage, inputDigest: digest }) };
  await writeFile(join(output, "manifest.json"), `${JSON.stringify({ ...withInput, digest: digestJson({ ...withInput, digest: undefined }) }, null, 2)}\n`);
  console.log(JSON.stringify({ cached: false, profile, output, manifest: join(output, "manifest.json"), artifactDigests: artifacts }));
} finally {
  await run("docker", ["rm", "-f", container]).catch(() => undefined);
  await rm(staging, { recursive: true, force: true });
}
