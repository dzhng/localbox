import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ContractError, type Json } from "../packages/contract/src/index.js";
import { DESKTOP_OPERATIONS, macChromeLauncher, productionDesktopHandlers, type DesktopCommandResult } from "../packages/desktop/src/index.js";
import type { DispatchContext, HandlerRegistry } from "../packages/runtime/src/index.js";
import { DesktopLink, serveDesktopLink } from "../apps/guest-agent/src/desktop-link.js";
import { grantDarwinTcc, SYSTEM_TCC_DATABASE, type CommandOutcome } from "../apps/guest-agent/src/tcc.js";

const HELPER = "/usr/local/localbox/localbox-desktop";
const context = (deadline_ms = 5_000, signal?: AbortSignal) => ({ request: { deadline_ms }, signal }) as unknown as DispatchContext;
const ok = (stdout: Buffer | string = ""): DesktopCommandResult => ({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), code: 0 });

/** A backend whose commands are recorded and answered by `answer`, with no browser behind it. */
function recorded(backend: "x11" | "macos", answer: (command: string, args: string[]) => DesktopCommandResult = () => ok()) {
  const calls: string[][] = [];
  const handlers = productionDesktopHandlers({
    backend, helper: HELPER,
    commandRunner: async (command, args) => { calls.push([command, ...args]); return answer(command, args); },
    fetchImpl: async () => new Response("[]", { status: 200 }),
  } as Parameters<typeof productionDesktopHandlers>[0]);
  const call = (operation: keyof HandlerRegistry, input: Json = {}) => handlers[operation]!(input, context()) as Promise<any>;
  return { calls, call, handlers };
}

test("the macOS backend maps each desktop operation onto one localbox-desktop call", async () => {
  const { calls, call } = recorded("macos");
  await call("desktop.move", { x: 10, y: 20 });
  await call("desktop.click", { x: 10, y: 20 });
  await call("desktop.click", { x: 5.5, y: 6, button: "right" });
  await call("desktop.scroll", { x: 1, y: 2, delta_y: 3 });
  await call("desktop.scroll", { x: 1, y: 2, delta_y: -0.4, delta_x: 2 });
  await call("desktop.key", { key: "Enter" });
  await call("desktop.key", { key: "ctrl+c" });
  await call("desktop.key", { key: "cmd+shift+t" });
  await call("desktop.key", { key: "A" });
  await call("desktop.key", { key: "Delete" });
  await call("desktop.type", { text: "héllo 👋" });
  assert.deepEqual(calls, [
    [HELPER, "move", "10", "20"],
    [HELPER, "click", "10", "20", "left"],
    [HELPER, "click", "5.5", "6", "right"],
    // CGEvent wheels scroll up for positive values: down 3 notches is -3.
    [HELPER, "scroll", "1", "2", "-3", "0"],
    // Any non-zero delta is at least one notch.
    [HELPER, "scroll", "1", "2", "1", "-2"],
    [HELPER, "key", "36"],
    [HELPER, "key", "8", "control"],
    [HELPER, "key", "17", "command,shift"],
    [HELPER, "key", "0", "shift"],
    [HELPER, "key", "117"],
    [HELPER, "type", "héllo 👋"],
  ]);
});

test("the macOS backend refuses keys it can't name instead of guessing", async () => {
  const { calls, call } = recorded("macos");
  await assert.rejects(call("desktop.key", { key: "hyper+a" }), (error: ContractError) => error.code === "invalid_input" && /modifier "hyper"/.test(error.message));
  await assert.rejects(call("desktop.key", { key: "!" }), (error: ContractError) => error.code === "invalid_input" && /desktop.type/.test(error.message));
  await assert.rejects(call("desktop.click", { x: 1, y: 1, button: "back" }), (error: ContractError) => error.code === "invalid_input");
  assert.deepEqual(calls, []);
});

test("the x11 backend keeps xdotool and ImageMagick", async () => {
  const { calls, call } = recorded("x11", (command, args) => command === "xdotool" && args[0] === "getdisplaygeometry" ? ok("1440 900\n") : command === "import" ? ok("png") : ok());
  await call("desktop.click", { x: 10, y: 20, button: "middle" });
  await call("desktop.scroll", { x: 1, y: 2, delta_y: 2, delta_x: -1 });
  await call("desktop.key", { key: "Enter" });
  await call("desktop.type", { text: "hi" });
  const shot = await call("desktop.screenshot");
  assert.deepEqual([shot.width, shot.height, shot.mime_type], [1440, 900, "image/png"]);
  assert.deepEqual(calls, [
    ["xdotool", "mousemove", "--sync", "10", "20"], ["xdotool", "click", "2"],
    ["xdotool", "mousemove", "--sync", "1", "2"], ["xdotool", "click", "--repeat", "2", "5"], ["xdotool", "click", "--repeat", "1", "6"],
    ["xdotool", "key", "Return"],
    ["xdotool", "type", "--clearmodifiers", "--delay", "0", "hi"],
    ["xdotool", "getdisplaygeometry"], ["import", "-window", "root", "png:-"],
  ]);
});

test("a macOS screenshot reports the display's real size and re-encodes through the helper when the PNG is too big", async () => {
  const { calls, call } = recorded("macos", (_command, args) => {
    if (args[0] === "geometry") return ok("1920 1200\n");
    return ok(Buffer.alloc(args[1] === "png" ? 2 * 1024 * 1024 : 1024, 1));
  });
  const shot = await call("desktop.screenshot");
  assert.deepEqual([shot.width, shot.height, shot.mime_type], [1920, 1200, "image/jpeg"]);
  assert.deepEqual(shot.reencoded, { from: "image/png", original_bytes: shot.reencoded.original_bytes, quality: 80, scale: 1 });
  assert.deepEqual(calls, [[HELPER, "geometry"], [HELPER, "capture", "png"], [HELPER, "capture", "jpeg", "80", "1"]]);
  const status = await call("desktop.status");
  assert.deepEqual([status.width, status.height], [1920, 1200]);
});

test("a failing helper surfaces its stderr; a missing one is unsupported", async () => {
  const failing = recorded("macos", () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from("localbox-desktop: no frame within 10 s\n"), code: 1 }));
  await assert.rejects(failing.call("desktop.screenshot"), (error: ContractError) => error.code === "internal" && error.message === "localbox-desktop: no frame within 10 s");
  const missing = productionDesktopHandlers({ backend: "macos", helper: "/nonexistent/localbox-desktop" });
  await assert.rejects(Promise.resolve(missing["desktop.move"]!({ x: 1, y: 1 }, context())), (error: ContractError) => error.code === "unsupported");
});

test("on macOS the browser is launched in the session when CDP doesn't answer, once for concurrent calls", async () => {
  const opened: string[][] = [];
  let up = false;
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    if (!up) throw new TypeError("fetch failed: ECONNREFUSED");
    return String(input).endsWith("/json/list") ? new Response("[]", { status: 200 }) : new Response("{}", { status: 200 });
  };
  const launch = macChromeLauncher({ port: 9222, userDataDir: "/Users/localbox/Library/Application Support/Localbox/Chrome", commandRunner: async (command, args) => { opened.push([command, ...args]); up = true; return ok(); } });
  const handlers = productionDesktopHandlers({ backend: "macos", helper: HELPER, fetchImpl, launch, launchTimeoutMs: 1_000 });
  const [first, second] = await Promise.all([handlers["browser.list_tabs"]!({}, context()), handlers["browser.list_tabs"]!({}, context())]);
  assert.deepEqual([first, second], [{ tabs: [] }, { tabs: [] }]);
  assert.deepEqual(opened, [["/usr/bin/open", "-n", "-a", "Google Chrome", "--args", "--remote-debugging-port=9222", "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=/Users/localbox/Library/Application Support/Localbox/Chrome", "--no-first-run", "--no-default-browser-check", "about:blank"]]);
});

test("desktop status never starts a browser: with CDP down it reports no tabs", async () => {
  let launched = 0;
  const handlers = productionDesktopHandlers({ backend: "macos", helper: HELPER, commandRunner: async () => ok("1440 900\n"), fetchImpl: async () => { throw new TypeError("fetch failed"); }, launch: async () => { launched += 1; } });
  const status = await handlers["desktop.status"]!({}, context()) as any;
  assert.deepEqual([status.width, status.height, status.browser_tabs, launched], [1440, 900, [], 0]);
});

test("without a launcher (Linux: systemd runs Chrome) a dead CDP is guest_unreachable", async () => {
  const handlers = productionDesktopHandlers({ backend: "x11", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(Promise.resolve(handlers["browser.list_tabs"]!({}, context())), (error: ContractError) => error.code === "guest_unreachable" && error.retryable);
});

/** A short socket path: macOS caps Unix socket paths at 104 bytes, and the default tmpdir is long. */
async function socketDirectory(): Promise<string> { return mkdtemp("/tmp/lb-link-"); }

test("the root role forwards every desktop and browser call to the desktop role and hands back its answers and errors", async (t) => {
  const directory = await socketDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "desktop.sock");
  const link = new DesktopLink({ path, user: "localbox", grantUser: () => undefined }); t.after(() => link.close());
  await link.listen();
  const root = link.handlers();
  assert.deepEqual(Object.keys(root).sort(), [...DESKTOP_OPERATIONS].sort());
  await assert.rejects(Promise.resolve(root["desktop.screenshot"]!({}, context())), (error: ContractError) => error.code === "guest_unreachable" && /not connected/.test(error.message));
  const seen: Array<[string, Json]> = [];
  const desktop: HandlerRegistry = Object.fromEntries(DESKTOP_OPERATIONS.map((operation) => [operation, async (input: Json) => {
    seen.push([operation, input]);
    if (operation === "desktop.key") throw new ContractError("invalid_input", "unknown key \"!\"");
    if (operation === "desktop.type") throw new Error("helper crashed");
    if (operation === "desktop.move") await new Promise((resolve) => setTimeout(resolve, 2_000));
    return { operation, echoed: input };
  }]));
  serveDesktopLink(path, desktop, () => undefined);
  for (let tries = 0; ; tries++) {
    try { await root["desktop.status"]!({}, context()); break; } catch (error) { if (tries > 50) throw error; await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  assert.deepEqual(await root["desktop.click"]!({ x: 1, y: 2 }, context()), { operation: "desktop.click", echoed: { x: 1, y: 2 } });
  assert.deepEqual(await root["browser.open"]!({ url: "https://example.test" }, context()), { operation: "browser.open", echoed: { url: "https://example.test" } });
  await assert.rejects(Promise.resolve(root["desktop.key"]!({ key: "!" }, context())), (error: ContractError) => error.code === "invalid_input" && error.message === "unknown key \"!\"");
  await assert.rejects(Promise.resolve(root["desktop.type"]!({ text: "x" }, context())), (error: ContractError) => error.code === "internal" && error.message === "helper crashed");
  await assert.rejects(Promise.resolve(root["desktop.move"]!({ x: 0, y: 0 }, context(100))), (error: ContractError) => error.code === "operation_timeout");
  const aborted = new AbortController();
  const cancelled = Promise.resolve(root["desktop.move"]!({ x: 0, y: 0 }, context(5_000, aborted.signal)));
  aborted.abort();
  await assert.rejects(cancelled, (error: ContractError) => error.code === "operation_cancelled");
  assert.deepEqual(seen.slice(1, 3), [["desktop.click", { x: 1, y: 2 }], ["browser.open", { url: "https://example.test" }]]);
});

test("the socket is root's alone until the desktop user is let in", async (t) => {
  const directory = await socketDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "desktop.sock");
  const granted: Array<[string, string, number]> = [];
  const { statSync } = await import("node:fs");
  const link = new DesktopLink({ path, user: "localbox", grantUser: (socket, user) => { granted.push([socket, user, statSync(socket).mode & 0o777]); } }); t.after(() => link.close());
  await link.listen();
  assert.deepEqual(granted, [[path, "localbox", 0o600]]);
});

test("TCC grants name the binary in the system database and the desktop user's live one", () => {
  const ran: string[][] = [];
  const userDatabase = "/private/var/containers/Data/ProtectedSystem/5D1A/Library/Application Support/com.apple.TCC/TCC.db";
  const run = (command: string, args: string[]): CommandOutcome => {
    ran.push([command, ...args]);
    if (command === "/usr/bin/id") return { status: 0, stdout: "501\n", stderr: "" };
    if (command === "/usr/sbin/lsof") return { status: 0, stdout: `p412\nfcwd\nn/\nn/private/var/db/other.db\nn${userDatabase}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.deepEqual(grantDarwinTcc("/usr/local/localbox/localbox-agent", "localbox", run), [SYSTEM_TCC_DATABASE, userDatabase]);
  const insert = "INSERT OR REPLACE INTO access (service, client_type, client, auth_value, auth_reason, auth_version, indirect_object_identifier_type, indirect_object_identifier) VALUES "
    + ["kTCCServiceScreenCapture", "kTCCServiceAccessibility", "kTCCServicePostEvent"].map((service) => `('${service}', 1, '/usr/local/localbox/localbox-agent', 2, 0, 1, NULL, 'UNUSED')`).join(", ") + ";";
  assert.deepEqual(ran, [
    ["/usr/bin/id", "-u", "localbox"],
    ["/usr/sbin/lsof", "-a", "-u", "501", "-c", "tccd", "-Fn"],
    ["/usr/bin/sqlite3", SYSTEM_TCC_DATABASE, insert],
    ["/usr/bin/sqlite3", userDatabase, insert],
  ]);
});

test("TCC grants fail loudly when the desktop session isn't up or a write fails", () => {
  const noSession = (command: string): CommandOutcome => command === "/usr/bin/id" ? { status: 0, stdout: "501\n", stderr: "" } : { status: 1, stdout: "", stderr: "" };
  assert.throws(() => grantDarwinTcc("/usr/local/localbox/localbox-agent", "localbox", noSession), /no live TCC database for localbox \(uid 501\)/);
  const locked = (command: string): CommandOutcome => command === "/usr/bin/id" ? { status: 0, stdout: "501\n", stderr: "" }
    : command === "/usr/sbin/lsof" ? { status: 0, stdout: "n/private/var/containers/Data/ProtectedSystem/X/com.apple.TCC/TCC.db\n", stderr: "" }
    : { status: 1, stdout: "", stderr: "Error: attempt to write a readonly database" };
  assert.throws(() => grantDarwinTcc("/usr/local/localbox/localbox-agent", "localbox", locked), /writing \/Library\/Application Support\/com.apple.TCC\/TCC.db failed \(1\): Error: attempt to write a readonly database/);
});
