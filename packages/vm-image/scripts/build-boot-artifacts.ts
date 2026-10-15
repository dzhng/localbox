import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { artifactDigests, buildImageManifest, digestJson, type ImageBuildPins } from "../src/manifest.js";
import { DUET_REQUIRED_TOOL_INVENTORY } from "../src/duet-inventory.js";

type Profile = "minimal" | "full";
const root = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const profileArg = process.argv.slice(2).find((arg) => arg === "minimal" || arg === "full") ?? "minimal";
const profile = profileArg as Profile;
const baseImage = process.env.LOCALBOX_BASE_IMAGE ?? "ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55";
if (!/@sha256:[0-9a-f]{64}$/i.test(baseImage)) throw new Error("LOCALBOX_BASE_IMAGE must be an immutable @sha256:… reference");
const outputRoot = resolve(process.env.IMAGE_OUTPUT_DIR ?? "dist/vm-image");
const output = join(outputRoot, profile);
const buildVersion = process.env.IMAGE_BUILD_VERSION ?? "dev";
const substitutions = [
  { from: "Google Chrome", to: "Chromium", reason: "Google publishes no Linux ARM64 Chrome build; Ubuntu's pinned ARM64 Chromium package is used." },
  { from: "x86_64 release downloads", to: "ARM64 release downloads", reason: "Bun, static-web-server, and KasmVNC are fetched from their native ARM64 release assets at the Duet versions." },
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

async function inputDigest(): Promise<string> {
  const hash = createHash("sha256");
  for (const path of ["packages/vm-image/Dockerfile.arm64", "packages/vm-image/requirements-arm64.txt", "packages/vm-image/duet-reference/Dockerfile"]) {
    hash.update(path); hash.update(await readFile(join(root, path)));
  }
  hash.update(profile);
  hash.update(baseImage);
  return `sha256:${hash.digest("hex")}`;
}

async function extractTar(tarPath: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await run("tar", ["-xf", tarPath, "-C", destination]);
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
  const rootfsTar = join(staging, "rootfs.tar");
  await run("docker", ["export", "--output", rootfsTar, container]);
  const rootfs = join(staging, "rootfs");
  await extractTar(rootfsTar, rootfs);
  // Docker's pseudo-filesystem entries (notably /dev/void and proc symlinks)
  // are created by systemd at boot and cannot be represented by mke2fs -d.
  for (const path of ["dev", "proc", "sys", "run"]) {
    await rm(join(rootfs, path), { recursive: true, force: true });
    await mkdir(join(rootfs, path), { recursive: true });
  }
  // Docker's marker makes systemd treat the VM as a container and skip hardware setup.
  await rm(join(rootfs, ".dockerenv"), { force: true });
  await mkdir(join(staging, "boot"), { recursive: true });
  await run("docker", ["cp", `${container}:/boot/.`, join(staging, "boot")]);
  await extractKernel(container, staging, "vmlinuz");
  await extractKernel(container, staging, "initrd.img");
  const template = join(staging, "template.img");
  const helper = baseImage;
  await run("docker", ["run", "--rm", "--platform", "linux/arm64", "-v", `${rootfs}:/rootfs`, "-v", `${staging}:/out`, helper, "bash", "-lc", "apt-get update >/dev/null && apt-get install -y --no-install-recommends e2fsprogs >/dev/null && rm -rf /rootfs/var/lib/snapd /rootfs/dev /rootfs/proc /rootfs/sys /rootfs/run && mkdir -p /rootfs/dev /rootfs/proc /rootfs/sys /rootfs/run && truncate -s 8G /out/template.img && mke2fs -q -t ext4 -L localbox -d /rootfs /out/template.img"]);
  await mkdir(output, { recursive: true });
  await cp(join(staging, "vmlinuz"), join(output, "kernel"));
  await cp(join(staging, "initrd.img"), join(output, "initrd"));
  await cp(template, join(output, "template.img"));
  const pins: ImageBuildPins = {
    schemaVersion: "agent-computer-image-build.v1", architecture: "arm64", baseImage,
    baseSnapshot: "ubuntu-24.04-pinned", packages: { nodejs: "24.x", bun: "1.3.14", staticWebServer: "2.43.0", kasmvnc: "1.5.0" },
    pythonRequirementsSha256: `sha256:${createHash("sha256").update(await readFile(join(root, "packages/vm-image/requirements-arm64.txt"))).digest("hex")}`,
    buildVersion, display: { width: 1440, height: 900 }, loopbackBindings: ["127.0.0.1:9222", "127.0.0.1:5900"], readinessMarker: "/run/localbox/ready",
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
