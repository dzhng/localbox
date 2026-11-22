import type { Readable } from "node:stream";
import { ConvexClient } from "convex/browser";
import { LocalIPCTransport } from "../../../packages/client/src/index.js";
import { machinePaths } from "../../../packages/config/src/machine-paths.js";
import { readCredentials, type Credentials } from "../../../packages/credentials/src/index.js";
import { Connector, hostRequest, type HostChange } from "./connector.js";
import { MachineTokenSource, RevokedError } from "./token.js";

export { Connector } from "./connector.js";
export { MachineTokenSource, RevokedError } from "./token.js";

const WATCH_TIMEOUT_MS = 25_000;
const CREDENTIALS_POLL_MS = 2_000;

export interface RunConnectorOptions {
  /** The supervisor's pipe; `process.stdin` by default. Its end is the stop. */
  input?: Readable;
  /** How often the connector looks for credentials while signed out. */
  pollMs?: number;
}

/**
 * Runs the connector as Localbox.app's child: it waits for a sign-in when there is none, and for the next one after a
 * revoke, and stops on a signal or when its stdin closes (the app quit or died). Returns the process exit code: 0 for
 * a clean stop, 1 for a failure (the app restarts it).
 */
export async function runConnector(env: NodeJS.ProcessEnv = process.env, options: RunConnectorOptions = {}): Promise<number> {
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} connector: ${line}\n`);
  const paths = machinePaths(env);
  let stopping = false, current: Connector | undefined, wake: (() => void) | undefined;
  const stop = (why: string) => { if (stopping) return; stopping = true; log(`stopping: ${why}`); wake?.(); void current?.stop(); };
  const onSignal = () => stop("signal");
  process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
  const input: Readable = options.input ?? process.stdin;
  // Bytes are dropped (the app never writes); the end of the pipe is the stop.
  input.on("data", () => {}); input.once("end", () => stop("stdin closed")); input.once("error", () => stop("stdin closed"));
  input.resume();
  /** Credentials to connect with, or undefined once stopping; waits for ones whose secret was not revoked. */
  const signedIn = async (revoked: string | undefined): Promise<Credentials | undefined> => {
    for (let waiting = false; !stopping; waiting = true) {
      const credentials = await readCredentials(paths.credentials);
      if (credentials && credentials.secret !== revoked) return credentials;
      if (!waiting) log(revoked ? "waiting for this Mac to be signed in again" : "not signed in; waiting for localbox login");
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, options.pollMs ?? CREDENTIALS_POLL_MS); wake = () => { clearTimeout(timer); resolve(); }; });
    }
    return undefined;
  };
  try {
    for (let revoked: string | undefined; ;) {
      const credentials = await signedIn(revoked);
      if (!credentials) return 0;
      try {
        const state = await connect(env, credentials, paths, log, (connector) => { current = connector; if (stopping) void connector.stop(); });
        log(`ended: ${state}`);
        if (state !== "revoked") return 0;
      } catch (error) {
        if (!(error instanceof RevokedError)) throw error;
        log(`machine credential revoked: ${error.message}; waiting for a new sign-in`);
      }
      revoked = credentials.secret; current = undefined;
    }
  } catch (error) {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
  }
}

/** One connection for one credential: resolves with how it ended ("stopped" or "revoked"); a refused first token throws RevokedError. */
async function connect(env: NodeJS.ProcessEnv, credentials: Credentials, paths: ReturnType<typeof machinePaths>, log: (line: string) => void, started: (connector: Connector) => void): Promise<string> {
  const tokens = new MachineTokenSource({ apiOrigin: env.LOCALBOX_API_ORIGIN || credentials.api_origin, secret: credentials.secret });
  const first = await tokens.get();
  const convex = new ConvexClient(first.convexUrl ?? credentials.convex_url);
  const daemon = new LocalIPCTransport({ socketPath: paths.socket, tokenFile: paths.ipcToken });
  const watcher = new LocalIPCTransport({ socketPath: paths.socket, tokenFile: paths.ipcToken, timeoutMs: WATCH_TIMEOUT_MS + 15_000 });
  let watchSeq = 0;
  const connector = new Connector({
    machineId: credentials.machine_id, convex, daemon, log,
    fetchToken: async (force) => (await tokens.get(force)).token,
    hostWatch: async (since) => {
      const response = await watcher.dispatch(hostRequest("host.watch", { since, timeout_ms: WATCH_TIMEOUT_MS }, `host-watch-${++watchSeq}`, WATCH_TIMEOUT_MS + 10_000));
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
      return response.result as unknown as HostChange;
    },
  });
  connector.start();
  started(connector);
  log(`started for machine ${credentials.machine_id}`);
  return await connector.finished;
}
