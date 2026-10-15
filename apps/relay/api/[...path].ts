import { ConvexHttpClient } from "convex/browser";
import { VercelBlobProvider } from "../../../packages/blob/src/vercel.js";
import { InMemoryBlobProvider } from "../../../packages/blob/src/index.js";
import { ConvexRelayStateRepository, InMemoryRelayStateRepository } from "../../../packages/state/src/index.js";
import { createVercelRelayHandler } from "../src/vercel.js";
import { signServiceToken } from "../../../packages/tokens/src/index.js";
import { PUBLIC_MCP_RESOURCE } from "../../../packages/config/src/index.js";

// This module is the deployable adapter. Convex is selected whenever its URL is
// present; the explicit local-services flag only permits the local test doubles.
const localServices = process.env.LOCALBOX_LOCAL_SERVICES === "1";
if (process.env.VERCEL && !localServices && !process.env.CONVEX_URL) throw new Error("CONVEX_URL is required for the deployed relay");
if (process.env.VERCEL && process.env.CONVEX_URL && !process.env.LOCALBOX_JWT_PRIVATE_KEY) throw new Error("LOCALBOX_JWT_PRIVATE_KEY is required for the deployed relay");
if (process.env.VERCEL && !localServices && !process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is required for the deployed relay");
const repository = process.env.CONVEX_URL
  ? new ConvexRelayStateRepository(new ConvexHttpClient(process.env.CONVEX_URL, { skipConvexDeploymentUrlCheck: true }), "convex", signServiceToken)
  : new InMemoryRelayStateRepository({ deploymentId: "vercel-local" });
const blobProvider = process.env.BLOB_READ_WRITE_TOKEN ? new VercelBlobProvider({
  token: process.env.BLOB_READ_WRITE_TOKEN,
  maxBytes: numberEnv("LOCALBOX_BLOB_MAX_BYTES", 64 * 1024 * 1024),
  maxTtlMs: numberEnv("LOCALBOX_BLOB_TTL_MS", 15 * 60_000),
}) : localServices ? new InMemoryBlobProvider({ baseUrl: process.env.LOCALBOX_API_ORIGIN ?? "http://127.0.0.1:3000" }) : undefined;
const handle = createVercelRelayHandler(repository, {
  resource: PUBLIC_MCP_RESOURCE,
  blobProvider,
  blobThresholdBytes: numberEnv("LOCALBOX_BLOB_THRESHOLD_BYTES", 1024 * 1024),
  maxBodyBytes: numberEnv("LOCALBOX_RELAY_MAX_BODY_BYTES", 8 * 1024 * 1024),
});

export default handle;

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
