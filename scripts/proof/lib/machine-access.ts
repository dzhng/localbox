import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { LocalIPCTransport } from "../../../packages/client/src/index.js";
import { machinePaths } from "../../../packages/config/src/machine-paths.js";
import { PROTOCOL_VERSION, type Json, type ResponseEnvelope } from "../../../packages/contract/src/index.js";
import { readCredentials } from "../../../packages/credentials/src/index.js";
import { signMachineToken } from "../../../packages/tokens/src/index.js";
import { API_ORIGIN, machineRoot } from "./login.js";

/**
 * A signed-in proof machine as its own processes see it: Convex as that machine (what its connector may call, signed
 * with the stack's dev key) and its daemon's socket. For proofs that stand in for a later slice's caller.
 */
export async function machineAccess(root: string, machine: string) {
  const paths = machinePaths({ LOCALBOX_MACHINE_ROOT: machineRoot(root, machine) });
  const credentials = await readCredentials(paths.credentials);
  if (!credentials) throw new Error(`machine ${machine} is not signed in`);
  process.env.LOCALBOX_JWT_PRIVATE_KEY = readFileSync(join(root, ".localbox/proof/keys/jwt-private.pem"), "utf8");
  process.env.LOCALBOX_API_ORIGIN = API_ORIGIN;
  const convex = () => { const client = new ConvexHttpClient(credentials.convex_url, { skipConvexDeploymentUrlCheck: true }); client.setAuth(signMachineToken(credentials.machine_id, credentials.account_id)); return client; };
  const daemon = new LocalIPCTransport({ socketPath: paths.socket, tokenFile: paths.ipcToken });
  let calls = 0;
  return {
    machineId: credentials.machine_id, paths,
    mutation: async (name: string, args: Record<string, unknown>): Promise<any> => await convex().mutation(makeFunctionReference<"mutation">(name) as any, args),
    query: async (name: string, args: Record<string, unknown>): Promise<any> => await convex().query(makeFunctionReference<"query">(name) as any, args),
    /** One request on the daemon's socket, as the connector sends its own (machine-level, no mutation id). */
    daemon: async (operation: string, input: Json, deadlineMs = 30_000): Promise<ResponseEnvelope> => await daemon.dispatch({ protocol_version: PROTOCOL_VERSION, request_id: `proof-${machine}-${Date.now()}-${calls++}`, operation, sandbox_id: null, deadline_ms: deadlineMs, mutation_id: null, input } as any),
  };
}
