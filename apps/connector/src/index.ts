import { ConvexClient } from "convex/browser";
import { LocalIPCTransport } from "../../../packages/client/src/index.js";
import { machinePaths } from "../../../packages/config/src/machine-paths.js";
import { readCredentials } from "../../../packages/credentials/src/index.js";
import { Connector, hostRequest } from "./connector.js";
import { MachineTokenSource, RevokedError } from "./token.js";

export { Connector } from "./connector.js";
export { MachineTokenSource, RevokedError } from "./token.js";

const WATCH_TIMEOUT_MS = 25_000;

/**
 * Runs the connector until it is revoked, stopped by a signal, or fails.
 * Returns the process exit code: 0 for a clean stop (including a removed
 * machine, so launchd's KeepAlive does not restart it), 1 for a failure.
 */
export async function runConnector(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} connector: ${line}\n`);
  try {
    const paths = machinePaths(env);
    const credentials = await readCredentials(paths.credentials);
    if (!credentials) { log("not signed in; nothing to connect"); return 0; }
    const tokens = new MachineTokenSource({ apiOrigin: env.LOCALBOX_API_ORIGIN || credentials.api_origin, secret: credentials.secret });
    const first = await tokens.get();
    const convex = new ConvexClient(first.convexUrl ?? credentials.convex_url);
    const daemon = new LocalIPCTransport({ socketPath: paths.socket, tokenFile: paths.ipcToken });
    const watcher = new LocalIPCTransport({ socketPath: paths.socket, tokenFile: paths.ipcToken, timeoutMs: WATCH_TIMEOUT_MS + 15_000 });
    let watchSeq = 0;
    const connector = new Connector({
      convex, daemon, log,
      fetchToken: async (force) => (await tokens.get(force)).token,
      hostWatch: async (since) => {
        const response = await watcher.dispatch(hostRequest("host.watch", { since, timeout_ms: WATCH_TIMEOUT_MS }, `host-watch-${++watchSeq}`, WATCH_TIMEOUT_MS + 10_000));
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
        return response.result as { version: number; capacity?: unknown };
      },
    });
    const stop = () => { log("stopping on signal"); void connector.stop(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    connector.start();
    log(`started for machine ${credentials.machine_id}`);
    const state = await connector.finished;
    log(`ended: ${state}`);
    return 0;
  } catch (error) {
    if (error instanceof RevokedError) { log(`machine credential revoked: ${error.message}; stopping`); return 0; }
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
