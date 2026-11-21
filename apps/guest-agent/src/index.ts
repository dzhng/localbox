import { stdin, stdout, stderr } from "node:process";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createServer } from "node:net";
import { Resolver } from "node:dns/promises";
import { GuestControl, GuestGateway, linuxFreezeCommands, runGuestService, syncOnlyCommands } from "../../../packages/guest-gateway/src/index.js";
import { productionDesktopHandlers } from "../../../packages/desktop/src/index.js";
import { DUET_REQUIRED_TOOL_NAMES } from "../../../packages/vm-image/src/duet-inventory.js";
import { adoptSandboxIdentity } from "./identity.js";
import { AGENT_VERSION } from "./version.js";

const numberEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
};

/**
 * Linux image entrypoint. In the image the agent is a long-lived service on the Unix socket
 * `LOCALBOX_AGENT_SOCKET`, and socat forwards each vsock connection from the host to it: a dropped host
 * connection (a daemon restart, a restore from hibernation) ends only that connection, never the agent, its job
 * table or the processes it started. Without the variable it serves one connection on stdin/stdout (the
 * process-fixture backend and CI).
 *
 * `LOCALBOX_CONTROL_SOCKET` is the control lane (freeze, thaw, agent update), forwarded by a second socat unit from
 * vsock port 1025. A built agent (with an embedded version) can replace its own executable there; one run from source
 * cannot.
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
  // restore and gives the system the sandbox's identity and name. A fixture guest (a local process) shares the host's
  // clock, machine-id and hostname, so it never touches them.
  const ownsSystem = root === "/" && process.platform === "linux";
  const setClock = ownsSystem ? (wallClockMs: number) => { spawnSync("date", ["-u", "-s", `@${(wallClockMs / 1000).toFixed(3)}`], { stdio: "ignore" }); } : undefined;
  const adoptIdentity = ownsSystem ? (sandboxId: string, hostname: string) => { adoptSandboxIdentity(sandboxId, hostname); } : undefined;
  // A restored VM gets a new NAT whose first packets are dropped for ~250 ms; a DNS query sent then costs glibc its
  // 5 s timeout. So after a new-epoch hello, requests wait (at most 3 s) until the DHCP-provided DNS server answers.
  const settle = ownsSystem ? () => dnsAnswers(3_000) : undefined;
  const serve = (input: NodeJS.ReadableStream, output: NodeJS.WritableStream, epoch: number) => runGuestService({ input: input as never, output: output as never, gateway, channelEpoch: epoch, inventoryNames: inventory, readinessMarker, agentVersion: AGENT_VERSION, setClock, adoptIdentity, settle, onProtocolError: (error) => stderr.write(`[localbox-guest] ${error.message}\n`) });
  const socketPath = process.env.LOCALBOX_AGENT_SOCKET;
  if (!socketPath) { await serve(stdin, stdout, channelEpoch); return; }
  const controlPath = process.env.LOCALBOX_CONTROL_SOCKET;
  if (controlPath) {
    // Only a Linux guest that owns its root freezes it; darwin and a fixture guest flush only.
    const update = AGENT_VERSION === undefined ? undefined : {
      binary: process.execPath, runningJobs: () => gateway.runningJobs(), exit: () => process.exit(0),
      afterSwap: process.platform === "darwin" ? rewriteDarwinTccGrantsAfterSwap : undefined,
    };
    const control = new GuestControl({ commands: ownsSystem ? linuxFreezeCommands : syncOnlyCommands, update });
    mkdirSync(dirname(controlPath), { recursive: true }); rmSync(controlPath, { force: true });
    createServer((socket) => { socket.on("error", () => socket.destroy()); void control.serve(socket, socket); }).listen(controlPath);
  }
  // One connection at a time carries the host's frames; each starts at the epoch the last one ended on.
  let epoch = channelEpoch;
  mkdirSync(dirname(socketPath), { recursive: true }); rmSync(socketPath, { force: true });
  createServer((socket) => {
    socket.on("error", () => socket.destroy());
    void serve(socket, socket, epoch).then((service) => { epoch = Math.max(epoch, service.epoch); }, (error) => stderr.write(`[localbox-guest] connection failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }).listen(socketPath);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { stderr.write(`[localbox-guest] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
}

/**
 * P6: TCC rows name the agent by its install path. If spike 18 shows that a replaced binary loses its grants, the darwin
 * agent rewrites its own rows here, as root, after every swap (SIP is off). Until spike 18 records its outcome this does
 * nothing; slice 33 fills it in or deletes it.
 */
async function rewriteDarwinTccGrantsAfterSwap(_binary: string): Promise<void> {}

/** Resolves once the nameserver in /etc/resolv.conf answers any query (an NXDOMAIN counts), or after `limitMs`. */
async function dnsAnswers(limitMs: number): Promise<void> {
  const server = readFileSync("/etc/resolv.conf", "utf8").match(/^nameserver\s+(\S+)/m)?.[1];
  if (!server) return;
  const resolver = new Resolver({ timeout: 150, tries: 1 }); resolver.setServers([server]);
  for (const deadline = Date.now() + limitMs; Date.now() < deadline;) {
    try { await resolver.resolve4("localbox-probe.invalid"); return; }
    catch (error) { if (["ENOTFOUND", "ENODATA", "ESERVFAIL", "EREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return; }
    await new Promise((resolve) => setTimeout(resolve, 50)); // an unreachable network can fail instantly; don't spin
  }
}
