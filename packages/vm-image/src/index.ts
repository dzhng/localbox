import { createHash } from "node:crypto";

export type ToolSource = "native" | "upstream" | "built" | "substituted";
export interface ToolInventoryEntry {
  name: string;
  kind: "binary" | "python";
  version?: string;
  path?: string;
  architecture: "arm64" | "noarch" | string;
  source: ToolSource;
  sha256?: string;
  substituteFor?: string;
  license?: string;
}

export interface ImageManifest {
  architecture: "arm64" | "x86_64" | string;
  digest: string;
  display: { width: number; height: number };
  binaries: string[];
  loopbackBindings: string[];
  browserProfilePath?: string;
  /** Immutable build inputs and the audited Duet-compatible tool inventory. */
  schemaVersion?: "agent-computer-image.v1" | string;
  baseSnapshot?: string;
  buildInputsDigest?: string;
  inventoryDigest?: string;
  tools?: ToolInventoryEntry[];
  readinessMarker?: string;
  artifactDigests?: Record<string, string>;
  profile?: "minimal" | "full";
  substitutions?: Array<{ from: string; to: string; reason: string }>;
}
export interface ImageVerification { ok: boolean; checks: Record<string, { ok: boolean; detail: string }>; manifest: ImageManifest; }
export interface ImageVerifierOptions {
  expectedArchitecture?: string;
  expectedDigest?: string;
  expectedDisplay?: { width: number; height: number };
  expectedBinaries?: string[];
  expectedLoopbackBindings?: string[];
  expectedInventoryDigest?: string;
  expectedReadinessMarker?: string;
  expectedArtifactDigests?: Record<string, string>;
}

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
  check("inventory_digest", !options.expectedInventoryDigest || manifest.inventoryDigest === options.expectedInventoryDigest, manifest.inventoryDigest ?? "missing");
  check("readiness_marker", !options.expectedReadinessMarker || manifest.readinessMarker === options.expectedReadinessMarker, manifest.readinessMarker ?? "missing");
  if (options.expectedArtifactDigests) {
    const actual = manifest.artifactDigests ?? {};
    check("artifacts", Object.entries(options.expectedArtifactDigests).every(([name, digest]) => actual[name] === digest), JSON.stringify(actual));
  }
  return { ok: Object.values(checks).every((x) => x.ok), checks, manifest };
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  return value;
}
export function canonicalManifest(input: Omit<ImageManifest, "digest">): string {
  return JSON.stringify(canonicalize(input));
}
export function digestManifest(input: Omit<ImageManifest, "digest">): string {
  return `sha256:${createHash("sha256").update(canonicalManifest(input)).digest("hex")}`;
}

/** Verify the machine-readable inventory, including architecture substitutions. */
export function verifyToolInventory(tools: readonly ToolInventoryEntry[], expected: readonly string[]): { ok: boolean; missing: string[]; invalid: string[] } {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const missing = expected.filter((name) => !byName.has(name));
  const invalid = tools.filter((tool) => tool.architecture === "x86_64" || (tool.source === "substituted" && !tool.substituteFor)).map((tool) => tool.name);
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

export const verifyImageManifest = verifyImage;
