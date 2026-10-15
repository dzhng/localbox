const apiOrigin = (process.env.LOCALBOX_API_ORIGIN ?? "https://api.localbox.sh").replace(/\/$/, "");

export const PUBLIC_API_ORIGIN = apiOrigin;
export const PUBLIC_MCP_RESOURCE = `${apiOrigin}/api/mcp`;
export const PUBLIC_RELAY_URL = `${apiOrigin}/api/relay`;
export { machinePaths, type MachinePaths } from "./machine-paths.js";
