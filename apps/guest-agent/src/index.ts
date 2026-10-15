import { stdin, stdout, stderr } from "node:process";
import { spawnSync } from "node:child_process";
import { GuestGateway, runGuestService } from "../../../packages/guest-gateway/src/index.js";
import { productionDesktopHandlers } from "../../../packages/desktop/src/index.js";
import { DUET_REQUIRED_TOOL_NAMES } from "../../../packages/vm-image/src/duet-inventory.js";
import { adoptSandboxIdentity } from "./identity.js";

const numberEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
};

/**
 * Linux image entrypoint. Production images connect stdin/stdout to virtio
 * serial; using standard streams also makes the guest protocol probeable in CI.
 */
export async function main(): Promise<void> {
  const root = process.env.LOCALBOX_ROOT ?? "/";
  const channelEpoch = numberEnv("LOCALBOX_CHANNEL_EPOCH", 1);
  const readinessMarker = process.env.LOCALBOX_READINESS_MARKER ?? "/run/localbox/ready";
  const inventory = (process.env.LOCALBOX_INVENTORY ?? DUET_REQUIRED_TOOL_NAMES.join(",")).split(",").map((name) => name.trim()).filter(Boolean);
  const extraHandlers = process.env.LOCALBOX_DESKTOP_BACKEND === "production"
    ? productionDesktopHandlers({ cdpUrl: process.env.LOCALBOX_CDP_URL, env: { DISPLAY: process.env.DISPLAY ?? ":0" } })
    : undefined;
  const gateway = new GuestGateway({ root, extraHandlers });
  // In the VM the agent runs as root and owns the whole system, so the host's hello steps the clock after a
  // restore and gives the system the sandbox's identity and name. A fixture guest (slice 03) shares the host's
  // clock, machine-id and hostname, so it never touches them.
  const ownsSystem = root === "/" && process.platform === "linux";
  const setClock = ownsSystem ? (wallClockMs: number) => { spawnSync("date", ["-u", "-s", `@${(wallClockMs / 1000).toFixed(3)}`], { stdio: "ignore" }); } : undefined;
  const adoptIdentity = ownsSystem ? (sandboxId: string, hostname: string) => { adoptSandboxIdentity(sandboxId, hostname); } : undefined;
  await runGuestService({ input: stdin, output: stdout, gateway, channelEpoch, inventoryNames: inventory, readinessMarker, setClock, adoptIdentity, onProtocolError: (error) => stderr.write(`[localbox-guest] ${error.message}\n`) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { stderr.write(`[localbox-guest] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
}
