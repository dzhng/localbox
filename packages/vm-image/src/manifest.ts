import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, join } from "node:path";
import type { ImageManifest, ToolInventoryEntry } from "./index.js";

export interface ImageBuildPins {
  schemaVersion: "agent-computer-image-build.v1";
  architecture: "arm64";
  baseImage: string;
  baseSnapshot: string;
  packages: Record<string, string>;
  pythonRequirementsSha256: string;
  buildVersion: string;
  display: { width: number; height: number };
  loopbackBindings: string[];
  readinessMarker: string;
}

export interface BuildManifestOptions {
  pins: ImageBuildPins;
  artifacts?: Record<string, string>;
  tools: ToolInventoryEntry[];
  digest?: string;
  profile?: "minimal" | "full";
  substitutions?: Array<{ from: string; to: string; reason: string }>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Stable digest of the complete (versioned) inventory, including versions and substitutions. */
export function inventoryDigestForTools(tools: readonly ToolInventoryEntry[]): string {
  return digestJson(tools.map(({ name, kind, version, path, architecture, source, sha256, substituteFor, license }) => ({
    name, kind, version, path, architecture, source, sha256, substituteFor, license,
  })));
}

/** Build an image manifest from pinned inputs and the image's tool inventory. */
export function buildImageManifest(options: BuildManifestOptions): ImageManifest {
  const { tools } = options;
  const inventoryDigest = inventoryDigestForTools(tools);
  const unsigned = {
    architecture: "arm64" as const,
    schemaVersion: "agent-computer-image.v1" as const,
    baseSnapshot: options.pins.baseSnapshot,
    buildInputsDigest: digestJson(options.pins),
    inventoryDigest,
    tools,
    display: options.pins.display,
    binaries: tools.filter((tool) => tool.kind === "binary").map((tool) => tool.name),
    loopbackBindings: options.pins.loopbackBindings,
    readinessMarker: options.pins.readinessMarker,
    artifactDigests: options.artifacts ?? {},
    profile: options.profile,
    substitutions: options.substitutions ?? [],
  } satisfies Omit<ImageManifest, "digest">;
  return { ...unsigned, digest: options.digest ?? digestJson(unsigned) };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return `sha256:${hash.digest("hex")}`;
}

export async function artifactDigests(directory: string): Promise<Record<string, string>> {
  const { readdir } = await import("node:fs/promises");
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));
  const result: Record<string, string> = {};
  for (const entry of entries) result[basename(entry.name)] = await sha256File(join(directory, entry.name));
  return result;
}
