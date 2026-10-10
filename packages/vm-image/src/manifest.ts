import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ImageManifest, ToolInventoryEntry } from "./index.js";
import { DUET_REQUIRED_TOOL_NAMES, DUET_TOOL_PROBES } from "./duet-inventory.js";

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

export interface ImageProbeReport {
  architecture: string;
  binaries: Record<string, { ok: boolean; path?: string; version?: string; machine?: string }>;
  pythonModules: Record<string, { ok: boolean; version?: string }>;
  loopbackBindings: string[];
  readinessMarker: boolean;
  guestIdentity?: string;
}

export interface BuildManifestOptions {
  pins: ImageBuildPins;
  artifacts?: Record<string, string>;
  probe?: ImageProbeReport;
  tools?: ToolInventoryEntry[];
  digest?: string;
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

function inventoryFromProbe(probe: ImageProbeReport): ToolInventoryEntry[] {
  return DUET_REQUIRED_TOOL_NAMES.map((name) => {
    const binary = DUET_TOOL_PROBES[name];
    const result = binary.kind === "python" ? probe.pythonModules[name] : probe.binaries[name];
    const architecture = binary.kind === "python" ? "noarch" : "arm64";
    return {
      name,
      kind: binary.kind,
      version: result?.version,
      path: binary.kind === "binary" ? (result as { path?: string }).path : undefined,
      architecture,
      source: "native",
    } satisfies ToolInventoryEntry;
  });
}

/** Build an image manifest from pinned inputs and an optional in-image probe report. */
export function buildImageManifest(options: BuildManifestOptions): ImageManifest {
  const tools = options.tools ?? (options.probe ? inventoryFromProbe(options.probe) : undefined);
  if (!tools) throw new Error("a tool inventory or in-image probe report is required");
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
    loopbackBindings: options.probe?.loopbackBindings ?? options.pins.loopbackBindings,
    readinessMarker: options.pins.readinessMarker,
    artifactDigests: options.artifacts ?? {},
  } satisfies Omit<ImageManifest, "digest">;
  return { ...unsigned, digest: options.digest ?? digestJson(unsigned) };
}

export async function sha256File(path: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

export async function artifactDigests(directory: string): Promise<Record<string, string>> {
  const { readdir } = await import("node:fs/promises");
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));
  const result: Record<string, string> = {};
  for (const entry of entries) result[basename(entry.name)] = await sha256File(join(directory, entry.name));
  return result;
}
