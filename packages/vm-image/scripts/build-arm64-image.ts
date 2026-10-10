import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { buildImageManifest, type ImageBuildPins } from "../src/manifest.js";
import { DUET_REQUIRED_TOOL_INVENTORY } from "../src/duet-inventory.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise(output) : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
  });
}

const root = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const imageRef = process.env.IMAGE_REF ?? "agent-computer-vm:arm64-dev";
const baseImage = required("AGENT_COMPUTER_BASE_IMAGE");
if (!/@sha256:[0-9a-f]{64}$/i.test(baseImage)) throw new Error("AGENT_COMPUTER_BASE_IMAGE must be an immutable @sha256:… reference");
const buildVersion = process.env.IMAGE_BUILD_VERSION ?? "dev";
const snapshot = process.env.DEBIAN_SNAPSHOT ?? "20250929T000000Z";
const requirements = await readFile(join(root, "packages/vm-image/requirements-arm64.txt"));
const pins: ImageBuildPins = {
  schemaVersion: "agent-computer-image-build.v1",
  architecture: "arm64",
  baseImage,
  baseSnapshot: snapshot,
  packages: { python3: "3.11", nodejs: "20", chromium: process.env.CHROMIUM_VERSION ?? "guest-agent-managed" },
  pythonRequirementsSha256: `sha256:${createHash("sha256").update(requirements).digest("hex")}`,
  buildVersion,
  display: { width: 1440, height: 900 },
  loopbackBindings: ["127.0.0.1:9222", "127.0.0.1:5900"],
  readinessMarker: "/run/agent-computer/ready",
};
const output = resolve(process.env.IMAGE_OUTPUT_DIR ?? "dist/vm-image");
await mkdir(output, { recursive: true });
await writeFile(join(output, "build-inputs.json"), `${JSON.stringify(pins, null, 2)}\n`);
const buildArgs = [
  "buildx", "build", "--platform", "linux/arm64", "--provenance=false", "--sbom=false",
  "--file", join(root, "packages/vm-image/Dockerfile.arm64"),
  "--build-arg", `BASE_IMAGE=${baseImage}`,
  "--build-arg", `DEBIAN_SNAPSHOT=${snapshot}`,
  "--build-arg", `IMAGE_BUILD_VERSION=${buildVersion}`,
  "--tag", imageRef,
  process.env.IMAGE_PUSH === "1" ? "--push" : "--load",
  root,
];
await run("docker", buildArgs);
if (process.env.IMAGE_SKIP_PROBE !== "1") {
  await run("tsx", [join(root, "packages/vm-image/scripts/verify-arm64-image.ts")]);
}
const manifest = buildImageManifest({ pins, tools: DUET_REQUIRED_TOOL_INVENTORY });
// The verifier writes the complete probe-backed manifest. This placeholder is
// useful when the caller intentionally skips probes during an offline rebuild.
await writeFile(join(output, "manifest.inputs.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built ${imageRef}; inputs ${join(output, "build-inputs.json")}`);
