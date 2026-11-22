import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { failure, success, type RequestEnvelope, type ResponseEnvelope } from "../packages/contract/src/index.js";
import type { Credentials } from "../packages/credentials/src/index.js";
import { appFacts, FAILURE_SHOWN_MS, MAX_WAIT_MS, type AppFacts, type FactsDeps } from "../apps/cli/src/app-facts.js";
import { NEEDS_APP } from "../apps/cli/src/app-socket.js";

// `localbox app status` composed from a fake app socket (as `AppControl` answers) and a scripted daemon (as
// `SandboxHost` answers `host.watch` and `relay.status`). Each scenario's facts are also written to the fixtures the
// app's Swift tests decode (apps/macos/App/tests/fixtures/facts), so the two sides read one shape.

const FIXTURES = new URL("../apps/macos/App/tests/fixtures/facts/", import.meta.url).pathname;
const NOW = Date.UTC(2026, 10, 22, 12);
const GIB = 1024 ** 3;
const scratch: string[] = [];
after(() => { for (const directory of scratch) rmSync(directory, { recursive: true, force: true }); });
// Socket paths are limited to 104 bytes, so not under the long per-user tmpdir.
const temporary = () => { const directory = mkdtempSync("/tmp/lb-facts-"); scratch.push(directory); return directory; };

interface AppState { version?: string; build?: "release" | "dev"; in_applications?: boolean; daemon?: string; connector?: string; stopping?: AppFacts["stopping"]; login?: AppFacts["open_at_login"] }
function fakeApp(path: string, state: AppState): Promise<Server> {
  const server = createServer((connection) => {
    let buffered = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffered += chunk;
      if (!buffered.includes("\n")) return;
      const { id, operation } = JSON.parse(buffered.split("\n")[0]);
      const result = operation === "app.info"
        ? { version: state.version ?? "0.2.0", build: state.build ?? "release", in_applications: state.in_applications ?? true, children: { daemon: state.daemon ?? "running", connector: state.connector ?? "running" }, stopping: state.stopping ?? null }
        : { state: state.login ?? "enabled" };
      connection.end(`${JSON.stringify({ id, ok: true, result })}\n`);
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

type Row = { sandbox_id: string; name: string; os?: string; lifecycle: string; cpus?: number; memory_bytes?: number };
interface DaemonState { down?: boolean; version: number; rows: Row[]; operations: unknown[]; relay?: { connector: string; detail: string | null; reported_at: string | null }; capacity?: Record<string, unknown> }

/** A daemon that answers as SandboxHost does: `host.watch` waits for a version past `since`; `changed` bumps it. */
function scriptedDaemon(state: DaemonState) {
  const waiters = new Set<() => void>();
  const watches: Array<{ since: number; timeout_ms: number }> = [];
  return {
    watches,
    changed(change: (state: DaemonState) => void) { change(state); state.version++; for (const wake of waiters) wake(); },
    async dispatch(request: RequestEnvelope): Promise<ResponseEnvelope> {
      if (state.down) return failure(request, { code: "guest_unreachable", message: "HostDaemon socket is unavailable", retryable: true });
      const input = request.input as { since: number; timeout_ms: number };
      if (request.operation === "relay.status") return success(request, state.relay ?? { connector: "connected", connected: true, detail: null, reported_at: "2026-11-22T11:59:00Z" });
      if (request.operation !== "host.watch") return failure(request, { code: "unsupported", message: request.operation, retryable: false });
      watches.push(input);
      if (state.version <= input.since && input.timeout_ms > 0) await new Promise<void>((resolve) => {
        const wake = () => { waiters.delete(wake); clearTimeout(timer); resolve(); };
        const timer = setTimeout(wake, input.timeout_ms); waiters.add(wake);
      });
      return success(request, {
        version: state.version,
        capacity: state.capacity ?? { cpus: 10, total_bytes: 32 * GIB, reserved_bytes: 0, room_bytes: 24 * GIB, running: 0, revision: 1, free_disk_bytes: 210 * 10 ** 9, macos_version: "26.1.0" },
        sandboxes: state.rows.map((row) => ({ os: "linux", cpus: 2, memory_bytes: 2 * GIB, state: "", ...row })),
        deleted: [], operations: state.operations,
      } as never);
    },
  };
}

const CREDENTIALS: Credentials = { api_origin: "https://localbox.sh", convex_url: "https://x.convex.cloud", account_id: "account_1", account_name: "brave-otter", machine_id: "machine_1", machine_name: "studio", secret: "s", email: "dev@example.com" };
const UNLOCKED = { hibernate: "available" as const, fixes: [] };
const SETUP = { enabled: true, command: "installed", skill: "installed" };

interface Scenario {
  app?: AppState; daemon?: Partial<DaemonState>; signedIn?: boolean; host?: FactsDeps["hostCheck"]; setup?: FactsDeps["agentSetup"];
  linux?: boolean; images?: string[]; builtin?: Record<string, unknown>;
}

/** Runs `body` with the scenario's app, daemon and files in place. */
async function withScenario<T>(scenario: Scenario, body: (deps: FactsDeps, daemon: ReturnType<typeof scriptedDaemon>, app: AppState) => Promise<T>): Promise<T> {
  const directory = temporary(), root = join(directory, "root"), images = join(root, "images"), appSocket = join(directory, "app.sock");
  mkdirSync(images, { recursive: true });
  if (scenario.linux ?? true) mkdirSync(join(images, "linux"));
  for (const image of scenario.images ?? []) mkdirSync(join(images, image));
  if (scenario.builtin) writeFileSync(join(root, "builtin-image.json"), JSON.stringify(scenario.builtin));
  const app = { ...scenario.app };
  const server = await fakeApp(appSocket, app);
  const daemon = scriptedDaemon({ version: 7, rows: [], operations: [], ...scenario.daemon });
  const deps: FactsDeps = {
    app: { layout: { app: "/Applications/Localbox.app" }, paths: { appSocket }, launch: { env: { LOCALBOX_MACHINE_ROOT: root } } },
    daemon, root, images, now: () => NOW,
    credentials: async () => scenario.signedIn === false ? undefined : CREDENTIALS,
    hostCheck: scenario.host ?? (() => UNLOCKED), agentSetup: scenario.setup ?? (async () => SETUP),
  };
  try { return await body(deps, daemon, app); } finally { server.close(); }
}

const facts = (scenario: Scenario, options: { since?: number; timeoutMs?: number } = {}) => withScenario(scenario, (deps) => appFacts(options, deps));
const codes = (value: AppFacts) => value.warnings.map((warning) => warning.code);

/** Writes the facts as a shared fixture and returns them. */
function fixture(name: string, value: AppFacts): AppFacts {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(join(FIXTURES, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

const copying = () => ({
  key: "create_1", kind: "sandbox.create_after_copy", subject: "img_ubuntu", state: "running", progress: { phase: "receiving", completed: 461_708_984, total: GIB },
  started_at: NOW - 60_000, updated_at: NOW - 1_000, sandbox: { sandbox_id: "sandbox_3", name: "copy-crane" },
});

test("idle and connected: the account, capacity, nothing listed and no warnings", async () => {
  const value = fixture("idle", await facts({}));
  assert.ok(Number.isSafeInteger(value.watch_version) && value.watch_version > 0);
  assert.deepEqual({ ...value, watch_version: 0 }, {
    version: "0.2.0", build: "release", account: { email: "dev@example.com", machine_name: "studio" }, daemon: "running", connector: { state: "connected" },
    capacity: { cpus_free: 10, cpus_total: 10, memory_free_bytes: 24 * GIB, memory_total_bytes: 32 * GIB, disk_free_bytes: 210 * 10 ** 9 },
    hibernate: "available", open_at_login: "enabled", agent_setup: SETUP, sandboxes: [], images: [], builtin_image: "ready", stopping: null, update: null, warnings: [], watch_version: 0,
  });
});

test("this Mac's sandboxes by name, with the daemon's lifecycle, and one still copying its image with progress", async () => {
  const value = fixture("three-sandboxes", await facts({ daemon: {
    rows: [{ sandbox_id: "sandbox_1", name: "quiet-otter", lifecycle: "ready", cpus: 4 }, { sandbox_id: "sandbox_2", name: "calm-heron", lifecycle: "asleep" }],
    operations: [copying(), { key: "copy_1", kind: "image.copy", subject: "img_ubuntu", state: "running", progress: { phase: "receiving", completed: 461_708_984, total: GIB }, started_at: NOW - 61_000, updated_at: NOW - 1_000 }],
  } }));
  assert.deepEqual(value.sandboxes, [
    { sandbox_id: "sandbox_2", name: "calm-heron", os: "linux", state: "asleep" },
    { sandbox_id: "sandbox_3", name: "copy-crane", os: "linux", state: "copying", progress: { done_bytes: 461_708_984, total_bytes: GIB } },
    { sandbox_id: "sandbox_1", name: "quiet-otter", os: "linux", state: "running" },
  ]);
  assert.equal(value.capacity?.cpus_free, 6, "a running sandbox's CPUs are not free");
  assert.deepEqual(value.images, [{ name: "img_ubuntu", state: "copying", phase: "receiving", progress: { done_bytes: 461_708_984, total_bytes: GIB } }]);
});

test("paused and asleep stay apart; a stopping or errored sandbox reads stopped or failed", async () => {
  const value = await facts({ daemon: { rows: ["paused", "asleep", "starting", "stopping", "stopped", "error", "freezing"].map((lifecycle, index) => ({ sandbox_id: `s${index}`, name: `n${index}`, lifecycle })) } });
  assert.deepEqual(value.sandboxes.map((row) => row.state), ["paused", "asleep", "starting", "stopped", "stopped", "failed", "running"]);
});

test("twelve sandboxes", async () => {
  const lifecycles = ["ready", "asleep", "paused", "stopped"];
  const rows = Array.from({ length: 12 }, (_, index) => ({ sandbox_id: `sandbox_${index + 1}`, name: `sandbox-${String(index + 1).padStart(2, "0")}`, lifecycle: lifecycles[index % 4], os: index === 11 ? "macos" : "linux" }));
  const value = fixture("twelve-sandboxes", await facts({ daemon: { rows } }));
  assert.equal(value.sandboxes.length, 12);
  assert.equal(value.sandboxes.at(-1)?.os, "macos");
});

test("an image building and the built-in image downloading; the sending side of a copy is left out", async () => {
  const value = fixture("images-in-progress", await facts({ linux: false, images: ["img_sent"], builtin: { phase: "downloading", done_bytes: 300 * 1024 ** 2, total_bytes: 1200 * 1024 ** 2 }, daemon: { operations: [
    { key: "build_1", kind: "macos.build", subject: "img_macos", state: "running", progress: { phase: "install" }, started_at: NOW - 600_000, updated_at: NOW - 5_000 },
    { key: "send_1", kind: "image.copy", subject: "img_sent", state: "running", progress: { phase: "sending" }, started_at: NOW - 9_000, updated_at: NOW - 1_000 },
  ] } }));
  assert.equal(value.builtin_image, "downloading");
  assert.deepEqual(value.images, [
    { name: "linux", state: "downloading", phase: "downloading", progress: { done_bytes: 300 * 1024 ** 2, total_bytes: 1200 * 1024 ** 2 } },
    { name: "img_macos", state: "building", phase: "install" },
  ]);
  assert.deepEqual(codes(value), [], "a download in progress is not a warning");
});

test("a failed image or copy shows for an hour, with why; a cancelled create never does", async () => {
  const failed = (key: string, ageMs: number, code = "internal") => ({ key, kind: key.startsWith("create") ? "sandbox.create_after_copy" : "image.capture", subject: `img_${key}`, state: "failed",
    error: { code, message: `${key} failed` }, started_at: NOW - ageMs - 1_000, updated_at: NOW - ageMs, ...(key.startsWith("create") ? { sandbox: { sandbox_id: `sandbox_${key}`, name: key } } : {}) });
  const value = await facts({ daemon: { operations: [failed("capture_new", 60_000), failed("capture_old", FAILURE_SHOWN_MS + 1), failed("create_new", 60_000), failed("create_cancelled", 60_000, "operation_cancelled")] } });
  assert.deepEqual(value.images, [{ name: "img_capture_new", state: "failed", error: "capture_new failed" }]);
  assert.deepEqual(value.sandboxes, [{ sandbox_id: "sandbox_create_new", name: "create_new", os: "linux", state: "failed", error: "create_new failed" }]);
});

test("signed out", async () => {
  const value = fixture("signed-out", await facts({ signedIn: false }));
  assert.equal(value.account, null);
  assert.deepEqual(value.connector, { state: "signed_out" });
  assert.deepEqual(codes(value), ["signed_out"]);
  assert.match(value.warnings[0].fix ?? "", /localbox login --email/);
});

test("a revoked machine reads signed out, with its account still named", async () => {
  const value = await facts({ daemon: { relay: { connector: "revoked", detail: null, reported_at: "2026-11-22T11:59:00Z" } } });
  assert.deepEqual(value.connector, { state: "signed_out", detail: "this Mac was removed from the account" });
  assert.match(value.warnings[0].message, /removed from your Localbox account/);
});

test("connector down: the app's child backing off, or a report gone stale; one not reported yet is still connecting", async () => {
  const backingOff = fixture("connector-down", await facts({ app: { connector: "backing_off" } }));
  assert.equal(backingOff.connector.state, "down"); assert.deepEqual(codes(backingOff), ["connector_down"]);
  const stale = await facts({ daemon: { relay: { connector: "not_running", detail: "last connector report is older than 120 s", reported_at: "2026-11-22T11:00:00Z" } } });
  assert.deepEqual(stale.connector, { state: "down", detail: "last connector report is older than 120 s" });
  const fresh = await facts({ daemon: { relay: { connector: "not_running", detail: null, reported_at: null } } });
  assert.deepEqual(fresh.connector, { state: "connecting" }); assert.deepEqual(codes(fresh), []);
});

test("hibernation blocked: the fix is the System Settings changes host check names", async () => {
  const fixes = ['System Settings > Lock Screen: set "Require password after screen saver begins or display is turned off" to Never', "System Settings > Users & Groups: turn on automatic login"];
  const value = fixture("hibernate-blocked", await facts({ host: () => ({ hibernate: "only_while_unlocked", fixes }) }));
  assert.equal(value.hibernate, "only_while_unlocked");
  assert.deepEqual(value.warnings, [{ code: "hibernate_blocked", message: "While this Mac is locked, idle sandboxes can't free their memory, because the lock screen asks for a password.", fix: fixes.join("; then ") }]);
});

test("daemon down: it still answers from the app and the sign-in, with no capacity and empty lists", async () => {
  const value = fixture("daemon-down", await facts({ app: { daemon: "backing_off" }, daemon: { down: true, rows: [{ sandbox_id: "s", name: "n", lifecycle: "ready" }] } }));
  assert.equal(value.daemon, "backing_off");
  assert.equal(value.capacity, null); assert.deepEqual(value.sandboxes, []); assert.deepEqual(value.images, []);
  assert.deepEqual(value.connector, { state: "connecting", detail: "waiting for this Mac's sandbox service" });
  assert.deepEqual(codes(value), ["daemon_down"]);
  const starting = await facts({ daemon: { down: true } });
  assert.equal(starting.daemon, "starting", "the app runs it but it does not answer yet"); assert.deepEqual(codes(starting), []);
});

test("stopping: the reason and the names still being saved, and no daemon warning as it goes", async () => {
  const value = fixture("stopping", await facts({ app: { stopping: { reason: "quit", pending: ["calm-heron", "quiet-otter"] } }, daemon: { down: true } }));
  assert.deepEqual(value.stopping, { reason: "quit", pending: ["calm-heron", "quiet-otter"] });
  assert.deepEqual(codes(value), []);
});

test("every warning from its cause, most severe first, each one sentence", async () => {
  const value = fixture("all-warnings", await facts({
    app: { daemon: "stopped", in_applications: false, login: "requires_approval" }, daemon: { down: true }, signedIn: false, linux: false,
    host: () => ({ hibernate: "only_while_unlocked", fixes: ['System Settings > Lock Screen: set "Require password after screen saver begins or display is turned off" to Never'] }),
    setup: async () => ({ enabled: true, command: "missing", skill: "installed" }),
  }));
  assert.deepEqual(codes(value), ["daemon_down", "signed_out", "builtin_image_missing", "hibernate_blocked", "not_in_applications", "login_item_needs_approval", "command_not_installed"]);
  for (const warning of value.warnings) assert.match(warning.message, /^[A-Z][^]*\.$/, warning.code), assert.ok(!/\. [A-Z]/.test(warning.message), `${warning.code}: one sentence`);
});

test("the remaining causes: connector down, a failed built-in image, a foreign localbox command", async () => {
  const value = await facts({ app: { connector: "backing_off" }, builtin: { phase: "failed", error: "a part's digest did not match" }, setup: async () => ({ enabled: true, command: "different", skill: "installed" }) });
  assert.deepEqual(codes(value), ["connector_down", "builtin_image_failed", "command_not_installed"]);
  assert.match(value.warnings[1].message, /a part's digest did not match/);
  assert.deepEqual(value.images, [{ name: "linux", state: "failed", phase: "failed", error: "a part's digest did not match" }]);
  assert.match(value.warnings[2].message, /Another program/);
});

test("what does not warn: a dev build outside Applications, setup turned off, a command for an app outside Applications", async () => {
  assert.deepEqual(codes(await facts({ app: { build: "dev", in_applications: false } })), []);
  assert.deepEqual(codes(await facts({ setup: async () => ({ enabled: false, command: "missing", skill: "missing" }) })), []);
  assert.deepEqual(codes(await facts({ setup: async () => ({ enabled: true, command: "not_in_applications", skill: "installed" }) })), []);
  assert.equal((await facts({ builtin: { phase: "ready" }, linux: false })).builtin_image, "missing", "ready on paper but not on disk");
});

test("--since answers at once when the facts differ, early when the daemon changes, and at the timeout otherwise", async () => {
  await withScenario({}, async (deps, daemon) => {
    const first = await appFacts({}, deps);
    assert.equal((await appFacts({ since: first.watch_version + 1 }, deps)).watch_version, first.watch_version, "a stale version answers at once");

    let started = Date.now();
    const unchanged = await appFacts({ since: first.watch_version, timeoutMs: 300 }, deps);
    assert.equal(unchanged.watch_version, first.watch_version);
    assert.ok(Date.now() - started >= 290, `held until the timeout (${Date.now() - started} ms)`);
    assert.ok(daemon.watches.some((watch) => watch.since === 7 && watch.timeout_ms > 0), "waited on the daemon's own version");

    started = Date.now();
    setTimeout(() => daemon.changed((state) => { state.rows = [{ sandbox_id: "sandbox_1", name: "quiet-otter", lifecycle: "asleep" }]; }), 100);
    const changed = await appFacts({ since: first.watch_version, timeoutMs: 10_000 }, deps);
    assert.ok(Date.now() - started < 1_500, `answered when the daemon changed (${Date.now() - started} ms)`);
    assert.notEqual(changed.watch_version, first.watch_version);
    assert.deepEqual(changed.sandboxes.map((row) => row.state), ["asleep"]);
  });
});

test("--since also ends on a change the daemon does not announce: the app's own state", async () => {
  await withScenario({}, async (deps, _daemon, app) => {
    const first = await appFacts({}, deps);
    const started = Date.now();
    setTimeout(() => { app.login = "requires_approval"; }, 100);
    const changed = await appFacts({ since: first.watch_version, timeoutMs: 10_000 }, deps);
    assert.equal(changed.open_at_login, "requires_approval");
    assert.ok(Date.now() - started < 3_500, `noticed within one recheck (${Date.now() - started} ms)`);
  });
});

test("the wait is capped at 25 s; a CLI outside Localbox.app refuses as login-item does", async () => {
  assert.equal(MAX_WAIT_MS, 25_000);
  await withScenario({}, async (deps) => {
    await assert.rejects(appFacts({}, { ...deps, app: { ...deps.app, layout: { app: null } } }), (error: Error) => error.message === NEEDS_APP);
  });
});

test("the shared fixtures are exactly the ones these tests write", () => {
  assert.deepEqual(readdirSync(FIXTURES).sort(), ["all-warnings.json", "connector-down.json", "daemon-down.json", "hibernate-blocked.json", "idle.json", "images-in-progress.json", "signed-out.json", "stopping.json", "three-sandboxes.json", "twelve-sandboxes.json"]);
});
