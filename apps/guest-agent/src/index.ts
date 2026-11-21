import { stdin, stdout, stderr } from "node:process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { Resolver } from "node:dns/promises";
import { GuestControl, GuestGateway, linuxFreezeCommands, runGuestService, syncOnlyCommands } from "../../../packages/guest-gateway/src/index.js";
import { macChromeLauncher, productionDesktopHandlers } from "../../../packages/desktop/src/index.js";
import type { HandlerRegistry } from "../../../packages/runtime/src/index.js";
import { DUET_REQUIRED_TOOL_NAMES } from "../../../packages/vm-image/src/duet-inventory.js";
import { guardCapturePrompt, screenshotsAfter, settleCapturePrompt } from "./capture-prompt.js";
import { DesktopLink, serveDesktopLink } from "./desktop-link.js";
import { adoptSandboxIdentity, realSystem, setGuestClock, type GuestPlatform } from "./identity.js";
import { grantDarwinTcc } from "./tcc.js";
import { AGENT_VERSION } from "./version.js";

const numberEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
};

const log = (message: string) => { stderr.write(`[localbox-guest] ${message}\n`); };
const DESKTOP_SOCKET = () => process.env.LOCALBOX_DESKTOP_SOCKET ?? "/var/run/localbox/desktop.sock";
const DESKTOP_USER = () => process.env.LOCALBOX_DESKTOP_USER ?? "localbox";

/**
 * The guest agent, one binary per OS in up to two roles:
 *
 * - The system role (no flag) answers the host. In an image it is a long-lived service (systemd on Linux, a root
 *   LaunchDaemon on darwin) on the Unix socket `LOCALBOX_AGENT_SOCKET`, which socat (Linux) or `localbox-vsock`
 *   (darwin) forwards vsock port 1024 to: a dropped host connection (a daemon restart, a restore from hibernation)
 *   ends only that connection, never the agent, its job table or the processes it started. Without the variable it
 *   serves one connection on stdin/stdout (the process-fixture backend and CI). `LOCALBOX_CONTROL_SOCKET` is the
 *   control lane (freeze, thaw, agent update) on vsock port 1025; a built agent (with an embedded version) can replace
 *   its own executable there, one run from source cannot.
 * - `--desktop` (darwin) runs as a LaunchAgent in the auto-login session, where ScreenCaptureKit and CGEvent work, and
 *   answers the desktop and browser calls the system role forwards over `LOCALBOX_DESKTOP_SOCKET` (P4).
 *
 * `--grant-tcc` (darwin, as root) writes this binary's TCC rows and exits; an image build runs it once.
 */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--grant-tcc")) { log(`granted ${process.execPath} in ${grantDarwinTcc(process.execPath, DESKTOP_USER()).join(", ")}`); return; }
  if (args.includes("--desktop")) { desktopRole(); return; }
  await systemRole();
}

async function systemRole(): Promise<void> {
  const root = process.env.LOCALBOX_ROOT ?? "/";
  const channelEpoch = numberEnv("LOCALBOX_CHANNEL_EPOCH", 1);
  const readinessMarker = process.env.LOCALBOX_READINESS_MARKER ?? "/run/localbox/ready";
  const inventory = (process.env.LOCALBOX_INVENTORY ?? DUET_REQUIRED_TOOL_NAMES.join(",")).split(",").map((name) => name.trim()).filter(Boolean);
  // In the VM the agent runs as root and owns the whole system, so the host's hello steps the clock after a
  // restore and gives the system the sandbox's identity and name. A fixture guest (a local process) shares the host's
  // clock, identity and hostname, so it never touches them.
  const platform: GuestPlatform | undefined = root === "/" && (process.platform === "linux" || process.platform === "darwin") ? process.platform : undefined;
  // The mutation journal and job logs default to `<root>/.localbox`; macOS's root volume is sealed read-only.
  const state = platform === "darwin" ? { journalDirectory: "/var/db/localbox/mutations", jobLogDirectory: "/var/db/localbox/jobs" } : {};
  const gateway = new GuestGateway({ root, ...state, extraHandlers: await desktopBackend() });
  const system = platform && realSystem(platform);
  const setClock = system ? (wallClockMs: number) => setGuestClock(wallClockMs, system) : undefined;
  const adoptIdentity = system ? (sandboxId: string, hostname: string) => { adoptSandboxIdentity(sandboxId, hostname, system); } : undefined;
  // A restored VM gets a new NAT whose first packets are dropped for ~250 ms; a DNS query sent then costs the
  // resolver its 5 s timeout. So after a new-epoch hello, requests wait (at most 3 s) until the DHCP-provided DNS
  // server answers.
  const settle = system ? () => dnsAnswers(3_000) : undefined;
  const serve = (input: NodeJS.ReadableStream, output: NodeJS.WritableStream, epoch: number) => runGuestService({ input: input as never, output: output as never, gateway, channelEpoch: epoch, inventoryNames: inventory, readinessMarker, agentVersion: AGENT_VERSION, setClock, adoptIdentity, settle, onProtocolError: (error) => log(error.message) });
  const socketPath = process.env.LOCALBOX_AGENT_SOCKET;
  if (!socketPath) { await serve(stdin, stdout, channelEpoch); return; }
  const controlPath = process.env.LOCALBOX_CONTROL_SOCKET;
  if (controlPath) {
    const update = AGENT_VERSION === undefined ? undefined : {
      binary: process.execPath, runningJobs: () => gateway.runningJobs(), exit: () => process.exit(0),
      afterSwap: platform === "darwin" ? rewriteDarwinTccGrantsAfterSwap : undefined,
    };
    // Only a Linux guest that owns its root freezes it; darwin and a fixture guest flush only.
    const control = new GuestControl({ commands: platform === "linux" ? linuxFreezeCommands : syncOnlyCommands, update });
    mkdirSync(dirname(controlPath), { recursive: true }); rmSync(controlPath, { force: true });
    createServer((socket) => { socket.on("error", () => socket.destroy()); void control.serve(socket, socket); }).listen(controlPath);
  }
  // One connection at a time carries the host's frames; each starts at the epoch the last one ended on.
  let epoch = channelEpoch;
  mkdirSync(dirname(socketPath), { recursive: true }); rmSync(socketPath, { force: true });
  createServer((socket) => {
    socket.on("error", () => socket.destroy());
    void serve(socket, socket, epoch).then((service) => { epoch = Math.max(epoch, service.epoch); }, (error) => log(`connection failed: ${error instanceof Error ? error.message : String(error)}`));
  }).listen(socketPath);
}

/**
 * Who answers `desktop.*` and `browser.*` in the system role (`LOCALBOX_DESKTOP_BACKEND`): `x11` drives the Linux
 * image's display in this process, `macos` forwards to the `--desktop` role, unset keeps the fixture desktop.
 */
async function desktopBackend(): Promise<HandlerRegistry | undefined> {
  switch (process.env.LOCALBOX_DESKTOP_BACKEND) {
    case undefined: case "": return undefined;
    case "x11": return productionDesktopHandlers({ backend: "x11", cdpUrl: process.env.LOCALBOX_CDP_URL, env: { DISPLAY: process.env.DISPLAY ?? ":0" } });
    case "macos": {
      const link = new DesktopLink({ path: DESKTOP_SOCKET(), user: DESKTOP_USER() });
      await link.listen();
      return link.handlers();
    }
    default: throw new Error(`LOCALBOX_DESKTOP_BACKEND must be x11 or macos, not ${process.env.LOCALBOX_DESKTOP_BACKEND}`);
  }
}

/**
 * The darwin desktop role: the macOS backend, with Chrome launched in this session on first use, and the guard that
 * answers macOS's window-picker bypass prompt (`guardCapturePrompt`); screenshots wait until the session's first
 * capture, which brings the prompt up, has been made and answered (`settleCapturePrompt`). An update renames a
 * new binary over this one (a new inode), so a changed inode at the next dial means this process is the old build.
 */
function desktopRole(): void {
  const cdpUrl = process.env.LOCALBOX_CDP_URL ?? "http://127.0.0.1:9222";
  const helper = process.env.LOCALBOX_DESKTOP_HELPER ?? join(dirname(process.execPath), "localbox-desktop");
  guardCapturePrompt(helper, (message) => log(`desktop: ${message}`));
  const settled = settleCapturePrompt(helper, (message) => log(`desktop: ${message}`));
  const handlers = screenshotsAfter(settled, productionDesktopHandlers({
    backend: "macos", cdpUrl,
    helper,
    launch: macChromeLauncher({ port: Number(new URL(cdpUrl).port || 9222), userDataDir: join(homedir(), "Library/Application Support/Localbox/Chrome") }),
  }));
  const inode = statSync(process.execPath).ino;
  serveDesktopLink(DESKTOP_SOCKET(), handlers, (message) => log(`desktop: ${message}`), () => { try { return statSync(process.execPath).ino !== inode; } catch { return true; } });
}

/**
 * P6: TCC rows name the agent by its install path, and a replaced binary loses its screen-capture grant (spike 18), so
 * after every swap the system role rewrites the rows as root (SIP is off) before answering `updated`. A failure is
 * logged, not raised: the new binary is already in place, and failing the update would leave the old agent running
 * from a replaced file; the desktop role's next capture then reports the missing grant.
 */
async function rewriteDarwinTccGrantsAfterSwap(binary: string): Promise<void> {
  try { grantDarwinTcc(binary, DESKTOP_USER()); }
  catch (error) { log(`could not re-grant TCC after the update: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Resolves once the nameserver in /etc/resolv.conf answers any query (an NXDOMAIN counts), or after `limitMs`. */
async function dnsAnswers(limitMs: number): Promise<void> {
  let server: string | undefined;
  try { server = readFileSync("/etc/resolv.conf", "utf8").match(/^nameserver\s+(\S+)/m)?.[1]; } catch { return; }
  if (!server) return;
  const resolver = new Resolver({ timeout: 150, tries: 1 }); resolver.setServers([server]);
  for (const deadline = Date.now() + limitMs; Date.now() < deadline;) {
    try { await resolver.resolve4("localbox-probe.invalid"); return; }
    catch (error) { if (["ENOTFOUND", "ENODATA", "ESERVFAIL", "EREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return; }
    await new Promise((resolve) => setTimeout(resolve, 50)); // an unreachable network can fail instantly; don't spin
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { log(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
}
