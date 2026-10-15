import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const CONNECTOR_LABEL = "com.localbox.connector";
export type ConnectorJobState = "started" | "not_installed" | "skipped" | "failed";

/**
 * Restarts the installed connector's launchd job so a new sign-in connects now. The job exits 0 when the Mac is
 * not signed in (or was removed), and launchd keeps a cleanly exited job down, so a login must start it again.
 * A relocated machine root (a simulated or fixture machine) or `LOCALBOX_SKIP_LAUNCHD=1` (fixture installs) means
 * the connector is not this user's launchd job, so it is left alone.
 */
export async function restartConnectorJob(env: NodeJS.ProcessEnv = process.env): Promise<{ state: ConnectorJobState; detail?: string }> {
  if (env.LOCALBOX_MACHINE_ROOT || env.LOCALBOX_SKIP_LAUNCHD === "1") return { state: "skipped" };
  const plist = join(env.LOCALBOX_LAUNCH_AGENTS_DIR ?? join(env.HOME || homedir(), "Library", "LaunchAgents"), `${CONNECTOR_LABEL}.plist`);
  if (!existsSync(plist)) return { state: "not_installed" };
  try {
    await promisify(execFile)("launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/${CONNECTOR_LABEL}`], { timeout: 15_000 });
    return { state: "started" };
  } catch (error) {
    return { state: "failed", detail: (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error)) };
  }
}
