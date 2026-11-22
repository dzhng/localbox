import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { machinePaths } from "../../../packages/config/src/index.js";
import { BUILT_IN_IMAGE, ContractError, HOST_OPERATION_KINDS, PROTOCOL_VERSION, type HostOperationRecord, type Json, type RequestEnvelope, type ResponseEnvelope } from "../../../packages/contract/src/index.js";
import { LocalIPCTransport } from "../../../packages/client/src/index.js";
import { readCredentials, type Credentials } from "../../../packages/credentials/src/index.js";
import { AgentSetup } from "./agent-setup.js";
import { askApp, type AppDeps } from "./app-socket.js";
import type { ImageProgress } from "./builtin-image.js";
import { checkHost, screenLockedNow, type HostCheck } from "./host-check.js";

/**
 * Everything Localbox.app shows, in one shape: the popover and Settings draw only this, and `warnings` are decided
 * here and nowhere else. The sandboxes and images are this Mac's, from its own daemon, never the account's catalog.
 */
export interface AppFacts {
  version: string;
  build: "release" | "dev";
  account: { email: string | null; machine_name: string } | null;
  daemon: "running" | "starting" | "stopped" | "backing_off";
  connector: { state: "connected" | "connecting" | "signed_out" | "down"; detail?: string };
  capacity: { cpus_free: number; cpus_total: number; memory_free_bytes: number; memory_total_bytes: number; disk_free_bytes: number | null } | null;
  /** Whether this Mac's daemon is holding off idle sleep (a sandbox or long host work is running); false without one. */
  keeping_awake: boolean;
  hibernate: HostCheck["hibernate"];
  /**
   * Whether the screen is locked at this moment. Saving a sandbox fails only while the screen is locked and the lock
   * asks for a password, so with `hibernate` this says whether hibernating would fail right now.
   */
  screen_locked_now: boolean;
  open_at_login: "enabled" | "disabled" | "requires_approval" | "not_found";
  agent_setup: { enabled: boolean; command: string; skill: string };
  sandboxes: SandboxFact[];
  images: ImageFact[];
  builtin_image: "ready" | "downloading" | "failed" | "missing";
  stopping: { reason: string; pending: string[] } | null;
  /** The app's updater, null in a build that cannot update itself; `status` is the line Settings shows. */
  update: UpdateFact | null;
  warnings: Warning[];
  /** A fingerprint of everything above: `--since` this value waits until any of it changes. */
  watch_version: number;
}
export interface UpdateFact { available: true; enabled: boolean; can_check: boolean; status?: string; version?: string }
export interface Progress { done_bytes: number; total_bytes: number }
export interface SandboxFact { sandbox_id: string; name: string; os: string; state: "running" | "asleep" | "paused" | "stopped" | "starting" | "copying" | "failed"; progress?: Progress; error?: string }
export interface ImageFact { name: string; state: "building" | "copying" | "downloading" | "failed"; phase?: string; progress?: Progress; error?: string }
export type WarningCode = "daemon_down" | "signed_out" | "connector_down" | "builtin_image_failed" | "builtin_image_missing" | "hibernate_blocked"
  | "not_in_applications" | "login_item_needs_approval" | "command_not_installed";
export interface Warning { code: WarningCode; message: string; fix?: string }

/** What `app image ensure` leaves in `<root>/builtin-image.json`: its latest progress line. */
type BuiltinImageProgress = Partial<ImageProgress> & Pick<ImageProgress, "phase">;

/** One `host.watch` answer, with the fields this command reads. */
interface Watch {
  version: number;
  capacity?: { cpus: number; total_bytes: number; room_bytes: number; free_disk_bytes?: number | null };
  sandboxes?: Array<{ sandbox_id: string; name: string; os: string; lifecycle: string; cpus: number }>;
  /** `image_name` is the account's name for the record's image, once the connector's mirror has given it. */
  operations?: Array<HostOperationRecord & { updated_at: number; image_name?: string; sandbox?: { sandbox_id: string; name: string } }>;
  keeping_awake?: boolean;
}
interface AppInfo {
  version: string; build: "release" | "dev"; in_applications: boolean; children: { daemon: AppFacts["daemon"]; connector: string }; stopping: AppFacts["stopping"];
  /** `UpdateCoordinator`'s snapshot; null in a build without Sparkle. */
  update: (Omit<UpdateFact, "status" | "version"> & { state: string; status: string | null; version: string | null }) | null;
}

/** The app's update snapshot as the facts carry it: its five fields, without nulls. */
function updateFact(update: AppInfo["update"]): UpdateFact | null {
  if (!update) return null;
  return { available: true, enabled: update.enabled, can_check: update.can_check, ...(update.status ? { status: update.status } : {}), ...(update.version ? { version: update.version } : {}) };
}

export interface FactsDeps {
  /** Where the app socket is; a fake app in tests. */
  app?: AppDeps;
  /** This Mac's daemon; a scripted transport in tests. */
  daemon?: { dispatch(request: RequestEnvelope): Promise<ResponseEnvelope> };
  credentials?: () => Promise<Credentials | undefined>;
  hostCheck?: () => Pick<HostCheck, "hibernate" | "fixes">;
  /** Whether the screen is locked now; read again at every recomposition, so locking or unlocking ends a wait. */
  screenLocked?: () => boolean;
  agentSetup?: () => Promise<AppFacts["agent_setup"]>;
  /** The built-in image's progress file (`builtin-image.json`) and the images folder. */
  builtinImage?: string;
  images?: string;
  /** The clock failures are aged by (the wait itself always uses the real one). */
  now?: () => number;
}

/** The longest one `--since` call waits, as the connector's long polls do. */
export const MAX_WAIT_MS = 25_000;
/**
 * While waiting, how often everything but the daemon (the app, credentials, the built-in image's progress, image
 * progress, which bumps no daemon version) is read again. The daemon's own changes end a wait at once.
 */
const RECHECK_MS = 2_000;
/** A failed image or sandbox copy stays in the lists this long after it ended, so it is seen and then goes. */
export const FAILURE_SHOWN_MS = 60 * 60_000;

/**
 * `localbox app status [--since N] [--timeout-ms M]`. Without `--since`, the facts now. With it, waits until the
 * facts' `watch_version` differs from N, or `--timeout-ms` (at most 25 s) passes, then answers. The host's settings
 * and agent setup are read once per call (they spawn several processes); everything else, whether the screen is
 * locked included, is read again while waiting.
 */
export async function appFacts(options: { since?: number; timeoutMs?: number } = {}, deps: FactsDeps = {}): Promise<AppFacts> {
  const now = deps.now ?? Date.now;
  const deadline = Date.now() + Math.min(Math.max(options.timeoutMs ?? MAX_WAIT_MS, 0), MAX_WAIT_MS);
  const paths = machinePaths();
  const progressFile = deps.builtinImage ?? paths.builtinImage, images = deps.images ?? paths.images;
  const daemon = deps.daemon ?? new LocalIPCTransport();
  const host = (deps.hostCheck ?? checkHost)();
  const setup = await (deps.agentSetup ?? defaultAgentSetup)();
  let watch = await hostWatch(daemon, 0, 0);
  for (;;) {
    const facts = await compose({ deps, daemon, watch, host, setup, progressFile, images, now: now() });
    const remaining = deadline - Date.now();
    if (options.since === undefined || facts.watch_version !== options.since || remaining <= 0) return facts;
    const wait = Math.min(remaining, RECHECK_MS);
    if (watch) watch = await hostWatch(daemon, watch.version, wait);
    else { await new Promise((resolve) => setTimeout(resolve, wait)); watch = await hostWatch(daemon, 0, 0); }
  }
}

/** `localbox app status`'s words after `status`: `--since N` and `--timeout-ms M`, each a whole number. */
export function appFactsCommand(words: string[]): Promise<AppFacts> {
  const options: { since?: number; timeoutMs?: number } = {};
  for (let index = 0; index < words.length; index += 2) {
    const [flag, value] = [words[index], words[index + 1]];
    const key = flag === "--since" ? "since" : flag === "--timeout-ms" ? "timeoutMs" : undefined;
    if (!key) throw new ContractError("invalid_input", `localbox app status takes --since N and --timeout-ms M, not ${flag}`);
    if (!/^\d+$/.test(value ?? "")) throw new ContractError("invalid_input", `${flag} takes a whole number`);
    options[key] = Number(value);
  }
  return appFacts(options);
}

const defaultAgentSetup = async (): Promise<AppFacts["agent_setup"]> => {
  const status = await new AgentSetup().status() as { enabled: boolean; command: string; skill: string };
  return { enabled: status.enabled, command: status.command, skill: status.skill };
};

let requests = 0;
const local = (operation: string, input: Json, deadlineMs: number): RequestEnvelope =>
  ({ protocol_version: PROTOCOL_VERSION, request_id: `app-facts-${process.pid}-${++requests}`, operation, sandbox_id: null, deadline_ms: deadlineMs, mutation_id: null, input });

/** The daemon's `host.watch` (after waiting up to `timeoutMs` for a version past `since`), or undefined when it does not answer. */
async function hostWatch(daemon: NonNullable<FactsDeps["daemon"]>, since: number, timeoutMs: number): Promise<Watch | undefined> {
  const response = await daemon.dispatch(local("host.watch", { since, timeout_ms: timeoutMs }, timeoutMs + 10_000)).catch(() => undefined);
  return response?.ok ? response.result as unknown as Watch : undefined;
}

interface Inputs {
  deps: FactsDeps; daemon: NonNullable<FactsDeps["daemon"]>; watch: Watch | undefined;
  host: Pick<HostCheck, "hibernate" | "fixes">; setup: AppFacts["agent_setup"]; progressFile: string; images: string; now: number;
}

async function compose({ deps, daemon, watch, host, setup, progressFile, images, now }: Inputs): Promise<AppFacts> {
  const [info, loginItem, signedIn, relay, builtin] = await Promise.all([
    askApp("app.info", {}, deps.app) as Promise<unknown> as Promise<AppInfo>,
    askApp("login_item.get", {}, deps.app) as Promise<unknown> as Promise<{ state: AppFacts["open_at_login"] }>,
    (deps.credentials ?? (() => readCredentials(machinePaths().credentials)))().then((credentials) => ({ credentials }), (error: Error) => ({ credentials: undefined, error: error.message })),
    watch ? daemon.dispatch(local("relay.status", {}, 10_000)).then((response) => response.ok ? response.result as { connector: string; detail: string | null; reported_at: string | null } : undefined, () => undefined) : undefined,
    readFile(progressFile, "utf8").then((text) => JSON.parse(text) as BuiltinImageProgress, () => undefined),
  ]);
  const { credentials } = signedIn;
  const daemonState: AppFacts["daemon"] = watch ? "running" : info.children.daemon === "running" ? "starting" : info.children.daemon;
  const connector = connectorFact(credentials, "error" in signedIn ? signedIn.error : undefined, info.children.connector, relay, !!watch);
  const recent = (watch?.operations ?? []).filter((record) => record.state === "running" || (now - record.updated_at < FAILURE_SHOWN_MS && record.error?.code !== "operation_cancelled"));
  const linuxHere = existsSync(join(images, BUILT_IN_IMAGE));
  const builtinImage: AppFacts["builtin_image"] = !builtin ? (linuxHere ? "ready" : "missing")
    : builtin.phase === "ready" ? (linuxHere ? "ready" : "missing") : builtin.phase === "failed" ? "failed" : "downloading";
  const facts: Omit<AppFacts, "watch_version"> = {
    version: info.version, build: info.build,
    account: credentials ? { email: credentials.email ?? null, machine_name: credentials.machine_name } : null,
    daemon: daemonState, connector,
    capacity: watch?.capacity ? capacityFact(watch) : null, keeping_awake: watch?.keeping_awake ?? false,
    hibernate: host.hibernate, screen_locked_now: (deps.screenLocked ?? screenLockedNow)(), open_at_login: loginItem.state, agent_setup: setup,
    sandboxes: sandboxFacts(watch, recent),
    images: [...builtinRow(builtinImage, builtin), ...imageFacts(recent, images)],
    builtin_image: builtinImage,
    stopping: info.stopping, update: updateFact(info.update),
    warnings: [],
  };
  facts.warnings = warnings(facts, { inApplications: info.in_applications, hostFixes: host.fixes, builtinError: builtin?.error });
  return { ...facts, watch_version: fingerprint(facts) };
}

function connectorFact(credentials: Credentials | undefined, unreadable: string | undefined, child: string, relay: { connector: string; detail: string | null; reported_at: string | null } | undefined, daemonUp: boolean): AppFacts["connector"] {
  if (!credentials) return unreadable ? { state: "signed_out", detail: `this Mac's sign-in could not be read: ${unreadable}` } : { state: "signed_out" };
  if (child !== "running") return { state: "down", detail: child === "backing_off" ? "it stopped and Localbox is restarting it" : `it is ${child}` };
  if (!daemonUp || !relay) return { state: "connecting", detail: "waiting for this Mac's sandbox service" };
  if (relay.connector === "connected") return { state: "connected" };
  if (relay.connector === "revoked") return { state: "signed_out", detail: "this Mac was removed from the account" };
  // A connector that has not reported yet is still starting, not down.
  if (relay.connector === "connecting" || relay.reported_at === null) return { state: "connecting", ...(relay.detail ? { detail: relay.detail } : {}) };
  return { state: "down", ...(relay.detail ? { detail: relay.detail } : {}) };
}

/** CPUs are not reserved by the daemon, so "free" is the host's cores minus what running sandboxes were given. */
function capacityFact(watch: Watch): NonNullable<AppFacts["capacity"]> {
  const capacity = watch.capacity!;
  const busy = (watch.sandboxes ?? []).filter((row) => ["ready", "freezing", "starting"].includes(row.lifecycle)).reduce((sum, row) => sum + row.cpus, 0);
  return { cpus_free: Math.max(0, capacity.cpus - busy), cpus_total: capacity.cpus, memory_free_bytes: capacity.room_bytes, memory_total_bytes: capacity.total_bytes, disk_free_bytes: capacity.free_disk_bytes ?? null };
}

const LIFECYCLE_STATE: Record<string, SandboxFact["state"]> = { ready: "running", freezing: "running", paused: "paused", asleep: "asleep", starting: "starting", stopping: "stopped", stopped: "stopped", error: "failed" };

const progressOf = (record: HostOperationRecord): { progress?: Progress } =>
  typeof record.progress?.completed === "number" && typeof record.progress?.total === "number" && record.progress.total > 0 ? { progress: { done_bytes: record.progress.completed, total_bytes: record.progress.total } } : {};

/** The daemon's sandboxes, and the ones still waiting for their image's copy (only a journaled create so far), by name. */
function sandboxFacts(watch: Watch | undefined, operations: NonNullable<Watch["operations"]>): SandboxFact[] {
  const rows: SandboxFact[] = (watch?.sandboxes ?? []).map((row) => ({ sandbox_id: row.sandbox_id, name: row.name, os: row.os, state: LIFECYCLE_STATE[row.lifecycle] ?? "stopped" }));
  for (const record of operations) {
    if (record.kind !== HOST_OPERATION_KINDS.createAfterCopy || !record.sandbox || rows.some((row) => row.sandbox_id === record.sandbox!.sandbox_id)) continue;
    const base = { sandbox_id: record.sandbox.sandbox_id, name: record.sandbox.name, os: "linux" };
    if (record.state === "failed") rows.push({ ...base, state: "failed", ...(record.error ? { error: record.error.message } : {}) });
    else rows.push({ ...base, state: record.progress?.phase === "creating" ? "starting" : "copying", ...progressOf(record) });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

const IMAGE_STATE: Record<string, ImageFact["state"]> = { [HOST_OPERATION_KINDS.capture]: "building", [HOST_OPERATION_KINDS.macosBuild]: "building", [HOST_OPERATION_KINDS.copy]: "copying" };

/**
 * Image work on this Mac. An image already in the images folder is not in progress here, which also leaves out the
 * sending side of a copy. Each is called by the account's name, which the daemon has from the connector's mirror; the
 * id stands in only until the mirror has named it (after a daemon restart, before the connector reaches the account).
 */
function imageFacts(operations: NonNullable<Watch["operations"]>, images: string): ImageFact[] {
  return operations.filter((record) => IMAGE_STATE[record.kind] && !existsSync(join(images, record.subject))).map((record) => ({
    name: record.image_name ?? record.subject, state: record.state === "failed" ? "failed" : IMAGE_STATE[record.kind],
    ...(record.progress?.phase ? { phase: record.progress.phase } : {}), ...progressOf(record),
    ...(record.state === "failed" && record.error ? { error: record.error.message } : {}),
  }));
}

/** The built-in image's download, shown with the other image work as `linux`. */
function builtinRow(state: AppFacts["builtin_image"], builtin: BuiltinImageProgress | undefined): ImageFact[] {
  if (!builtin || (state !== "downloading" && state !== "failed")) return [];
  const progress = typeof builtin.done_bytes === "number" && typeof builtin.total_bytes === "number" && builtin.total_bytes > 0 ? { progress: { done_bytes: builtin.done_bytes, total_bytes: builtin.total_bytes } } : {};
  return [{ name: BUILT_IN_IMAGE, state, phase: builtin.phase, ...progress, ...(state === "failed" && builtin.error ? { error: builtin.error } : {}) }];
}

/**
 * The one place warnings are decided, most severe first: nothing runs without the daemon; then whether other computers
 * can reach this Mac; then whether new Linux sandboxes can start; then what costs memory or convenience.
 */
export function warnings(facts: Omit<AppFacts, "watch_version" | "warnings">, context: { inApplications: boolean; hostFixes: string[]; builtinError?: string }): Warning[] {
  const out: Warning[] = [];
  // While Localbox quits, the daemon going away is the point, not a fault.
  if (!facts.stopping && (facts.daemon === "stopped" || facts.daemon === "backing_off"))
    out.push({ code: "daemon_down", message: "Localbox's sandbox service isn't running, so sandboxes on this Mac can't start or answer.", fix: "Localbox keeps restarting it; if this lasts, quit Localbox and open it again." });
  if (facts.connector.state === "signed_out")
    out.push({ code: "signed_out", message: facts.account ? "This Mac was removed from your Localbox account, so other computers can't reach its sandboxes." : "This Mac isn't signed in, so other computers and cloud agents can't reach its sandboxes.", fix: "Sign in from Settings, or run localbox login --email you@example.com." });
  else if (facts.connector.state === "down")
    out.push({ code: "connector_down", message: "This Mac can't reach your Localbox account, so other computers can't reach its sandboxes.", fix: "Localbox keeps retrying; if this lasts, quit Localbox and open it again." });
  if (facts.builtin_image === "failed")
    out.push({ code: "builtin_image_failed", message: `The built-in Linux image didn't download${context.builtinError ? ` (${context.builtinError})` : ""}, so new Linux sandboxes can't start.`, fix: "Localbox keeps trying; check this Mac's internet connection." });
  else if (facts.builtin_image === "missing")
    out.push({ code: "builtin_image_missing", message: "The built-in Linux image isn't on this Mac, so new Linux sandboxes can't start.", fix: "Quit Localbox and open it again to download it, or run localbox app image ensure." });
  if (facts.hibernate === "only_while_unlocked")
    out.push({ code: "hibernate_blocked", message: "While this Mac is locked, idle sandboxes can't free their memory, because the lock screen asks for a password.", ...(context.hostFixes.length ? { fix: context.hostFixes.join("; then ") } : {}) });
  // A development build runs from wherever it was built; only a release is meant to live in Applications.
  if (facts.build === "release" && !context.inApplications)
    out.push({ code: "not_in_applications", message: "Localbox isn't in your Applications folder, so it can't open at login or install the localbox command.", fix: "Move Localbox to the Applications folder and open it from there." });
  if (facts.open_at_login === "requires_approval")
    out.push({ code: "login_item_needs_approval", message: "Localbox won't open at login until you allow it.", fix: "In System Settings > General > Login Items, turn on Localbox." });
  if (facts.agent_setup.enabled && facts.agent_setup.command === "missing")
    out.push({ code: "command_not_installed", message: "The localbox command isn't installed, so agents on this Mac can't run it.", fix: "Quit Localbox and open it again to install it." });
  else if (facts.agent_setup.enabled && facts.agent_setup.command === "different")
    out.push({ code: "command_not_installed", message: "Another program is installed as ~/.local/bin/localbox, so agents on this Mac can't run Localbox's command.", fix: "Remove ~/.local/bin/localbox, then quit Localbox and open it again." });
  return out;
}

/** 48 bits of the facts' SHA-256: a whole number JSON and Swift both carry exactly. */
function fingerprint(facts: Omit<AppFacts, "watch_version">): number {
  return parseInt(createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 12), 16);
}
