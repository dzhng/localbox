/** The production API, which the CLI and connector talk to unless `LOCALBOX_API_ORIGIN` names another. */
export const DEFAULT_API_ORIGIN = "https://api.localbox.sh";

/**
 * The public API origin: `LOCALBOX_API_ORIGIN`, else the production API. A deployed function (`VERCEL` set) fails
 * closed without it, since the origin is also the issuer Convex verifies its tokens against.
 */
export function apiOrigin(): string {
  const configured = process.env.LOCALBOX_API_ORIGIN;
  if (!configured && process.env.VERCEL) throw new Error("LOCALBOX_API_ORIGIN is required for deployed functions");
  return (configured || DEFAULT_API_ORIGIN).replace(/\/$/, "");
}

export const PUBLIC_API_ORIGIN = apiOrigin();
export const PUBLIC_MCP_RESOURCE = `${PUBLIC_API_ORIGIN}/api/mcp`;
export const PUBLIC_RELAY_URL = `${PUBLIC_API_ORIGIN}/api/relay`;
export { machinePaths, type MachinePaths } from "./machine-paths.js";
