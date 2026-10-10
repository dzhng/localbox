import { createHash } from "node:crypto";

export interface ImageManifest {
  architecture: "arm64" | "x86_64" | string;
  digest: string;
  display: { width: number; height: number };
  binaries: string[];
  loopbackBindings: string[];
  browserProfilePath?: string;
}
export interface ImageVerification { ok: boolean; checks: Record<string, { ok: boolean; detail: string }>; manifest: ImageManifest; }
export interface ImageVerifierOptions { expectedArchitecture?: string; expectedDigest?: string; expectedDisplay?: { width: number; height: number }; expectedBinaries?: string[]; expectedLoopbackBindings?: string[]; }

/** Deterministic image metadata verifier; it does not mutate the VM image. */
export function verifyImage(manifest: ImageManifest, options: ImageVerifierOptions = {}): ImageVerification {
  const checks: ImageVerification["checks"] = {};
  const check = (name: string, ok: boolean, detail: string) => { checks[name] = { ok, detail }; };
  check("architecture", !options.expectedArchitecture || manifest.architecture === options.expectedArchitecture, `${manifest.architecture}`);
  check("digest", !options.expectedDigest || manifest.digest === options.expectedDigest, `${manifest.digest}`);
  const display = options.expectedDisplay;
  check("display", !display || (manifest.display.width === display.width && manifest.display.height === display.height), `${manifest.display.width}x${manifest.display.height}`);
  check("binaries", !options.expectedBinaries || options.expectedBinaries.every((binary) => manifest.binaries.includes(binary)), manifest.binaries.join(","));
  check("loopback_bindings", !options.expectedLoopbackBindings || options.expectedLoopbackBindings.every((binding) => manifest.loopbackBindings.includes(binding)), manifest.loopbackBindings.join(","));
  return { ok: Object.values(checks).every((x) => x.ok), checks, manifest };
}
export function digestManifest(input: Omit<ImageManifest, "digest">): string { return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`; }
export const verifyImageManifest = verifyImage;
