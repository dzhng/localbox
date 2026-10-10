import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { DUET_REQUIRED_TOOL_NAMES, DUET_TOOL_PROBES } from "../src/duet-inventory.js";
import { buildImageManifest, type ImageProbeReport } from "../src/manifest.js";
import type { ImageBuildPins } from "../src/manifest.js";

function run(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`docker ${args.join(" ")} exited ${code}: ${stderr}`)));
  });
}
const root = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const imageRef = process.env.IMAGE_REF;
if (!imageRef) throw new Error("IMAGE_REF is required");
const pinsInput = process.env.IMAGE_INPUTS ?? process.env.IMAGE_OUTPUT_DIR ?? "dist/vm-image";
const pinsPath = pinsInput.endsWith(".json") ? resolve(pinsInput) : resolve(pinsInput, "build-inputs.json");
const pins = JSON.parse(await (await import("node:fs/promises")).readFile(pinsPath, "utf8")) as ImageBuildPins;
const report: ImageProbeReport = { architecture: "", binaries: {}, pythonModules: {}, loopbackBindings: [], readinessMarker: false };
const identity = await run(["run", "--rm", "--platform", "linux/arm64", "--entrypoint", "/bin/sh", imageRef, "-lc", "printf '%s|%s|%s|%s\\n' \"$(dpkg --print-architecture 2>/dev/null || uname -m)\" \"${AGENT_COMPUTER_IMAGE_VERSION:-unknown}\" \"${AGENT_COMPUTER_LOOPBACK_BINDINGS:-}\" \"$(test -e /run/agent-computer/ready && echo ready || echo absent)\""]);
const [architecture, _version, bindings, readiness] = identity.trim().split("|");
report.architecture = architecture;
report.loopbackBindings = bindings ? bindings.split(",").filter(Boolean) : [];
report.readinessMarker = readiness === "ready";
if (architecture !== "arm64") throw new Error(`image architecture probe failed: ${architecture}`);
for (const name of DUET_REQUIRED_TOOL_NAMES) {
  const spec = DUET_TOOL_PROBES[name];
  const command = spec.kind === "python"
    ? `python3 -c 'import ${spec.importName} as module; print(getattr(module, "__version__", "ok"))'`
    : `command -v ${name} && ${spec.probe}`;
  try {
    const output = await run(["run", "--rm", "--platform", "linux/arm64", "--entrypoint", "/bin/sh", imageRef, "-lc", `set -eu; ${command}`]);
    if (spec.kind === "python") report.pythonModules[name] = { ok: true, version: output.trim().split("\n").at(-1) };
    else report.binaries[name] = { ok: true, path: output.trim().split("\n")[0], version: output.trim().split("\n").at(-1), machine: "aarch64" };
  } catch (error) {
    if (spec.kind === "python") report.pythonModules[name] = { ok: false };
    else report.binaries[name] = { ok: false };
    throw new Error(`required ${name} probe failed: ${String(error)}`);
  }
}
if (!report.readinessMarker) throw new Error("guest readiness marker is absent; guest service image layer is required");
const manifest = buildImageManifest({ pins, probe: report });
const outputDir = resolve(process.env.IMAGE_OUTPUT_DIR ?? "dist/vm-image");
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "probe-report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, digest: manifest.digest, inventoryDigest: manifest.inventoryDigest, output: outputDir }));
