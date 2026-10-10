import { ConvexHttpClient } from "convex/browser";
import { VercelBlobProvider } from "../../../packages/blob/src/vercel.js";
import { InMemoryBlobProvider } from "../../../packages/blob/src/index.js";
import { ConvexRelayStateRepository, InMemoryRelayStateRepository } from "../../../packages/state/src/index.js";
import { createVercelRelayHandler } from "../src/vercel.js";

// This module is the deployable adapter. Convex is selected whenever its URL is
// present; the explicit local-services flag only permits the local test doubles.
const localServices = process.env.AGENT_COMPUTER_LOCAL_SERVICES === "1";
if (process.env.VERCEL && !localServices && !process.env.CONVEX_URL) throw new Error("CONVEX_URL is required for the deployed relay");
if (process.env.VERCEL && !localServices && !process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is required for the deployed relay");
if (process.env.VERCEL && !process.env.AGENT_COMPUTER_RESOURCE) throw new Error("AGENT_COMPUTER_RESOURCE is required for the deployed relay");
const repository = process.env.CONVEX_URL
  ? new ConvexRelayStateRepository(new ConvexHttpClient(process.env.CONVEX_URL, { skipConvexDeploymentUrlCheck: true }), process.env.CONVEX_DEPLOYMENT ?? "convex")
  : new InMemoryRelayStateRepository({ deploymentId: process.env.CONVEX_DEPLOYMENT ?? "vercel-local" });
const blobProvider = process.env.BLOB_READ_WRITE_TOKEN ? new VercelBlobProvider({
  token: process.env.BLOB_READ_WRITE_TOKEN,
  maxBytes: numberEnv("AGENT_COMPUTER_BLOB_MAX_BYTES", 64 * 1024 * 1024),
  maxTtlMs: numberEnv("AGENT_COMPUTER_BLOB_TTL_MS", 15 * 60_000),
}) : localServices ? new InMemoryBlobProvider({ baseUrl: process.env.AGENT_COMPUTER_RESOURCE ?? "http://127.0.0.1:3000" }) : undefined;
const handle = createVercelRelayHandler(repository, {
  resource: process.env.AGENT_COMPUTER_RESOURCE,
  blobProvider,
  blobThresholdBytes: numberEnv("AGENT_COMPUTER_BLOB_THRESHOLD_BYTES", 1024 * 1024),
  maxBodyBytes: numberEnv("AGENT_COMPUTER_RELAY_MAX_BODY_BYTES", 8 * 1024 * 1024),
});

export default handle;

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

