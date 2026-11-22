import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { compile, temporary } from "./driver.mjs";

// The driver serves the real AppSocket and AppControl on the path it is given, with a fake login item (registering
// lands in requires_approval when the second argument is "approval") and a daemon that is down and backing off, until
// its stdin closes. It prints "listening", or "refused <error>" if the socket could not be served.
const DRIVER = `
import Foundation
@main struct Driver {
  static func main() {
    signal(SIGPIPE, SIG_IGN)
    let args = CommandLine.arguments
    let flag = Flag()
    let loginItem = LoginItem(driver: FakeLoginItem(approval: args.count > 2 && args[2] == "approval"), remembered: { flag.value }, remember: { flag.value = true })
    let control = AppControl(identity: .init(version: "9.8.7", isRelease: false, inApplications: false),
                             children: { (.backingOff, .running) }, lifetime: { .stopping(reason: .quit, pending: ["alpha-otter"], quiet: false) }, loginItem: loginItem)
    let socket = AppSocket(path: args[1]) { operation, params in control.handle(operation, params) }
    do { try socket.start() } catch { print("refused \\(error)"); fflush(stdout); exit(3) }
    print("listening"); fflush(stdout)
    while FileHandle.standardInput.availableData.count > 0 {}
    socket.stop()
  }
}
final class Flag: @unchecked Sendable { var value = false }
`;

let driver;
const running = new Set();
before(() => { driver = compile(DRIVER); });
after(() => { for (const child of running) child.kill("SIGKILL"); });

/** Starts the driver on `path`; resolves with the child and its first line. */
function serve(path, ...extra) {
  const child = spawn(driver, [path, ...extra], { stdio: ["pipe", "pipe", "inherit"] });
  running.add(child);
  // Taken now: a refused driver exits as soon as it has printed its line.
  const exited = new Promise((resolve) => child.once("exit", () => { running.delete(child); resolve(); }));
  return new Promise((resolve) => child.stdout.once("data", (line) => resolve({ child, exited, line: String(line).trim() })));
}
const quit = ({ child, exited }) => { child.stdin.end(); return exited; };

/** Writes `bytes` and resolves with everything the socket sent back before closing. */
function exchange(path, bytes) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path, () => socket.write(bytes));
    let reply = "";
    socket.on("data", (chunk) => { reply += chunk; });
    socket.on("end", () => resolve(reply));
    socket.on("error", reject);
  });
}
const call = async (path, operation, params = {}, id = `t-${operation}`) => {
  const reply = await exchange(path, `${JSON.stringify({ id, operation, params })}\n`);
  assert.equal(reply.indexOf("\n"), reply.length - 1, `one line back: ${JSON.stringify(reply)}`);
  return JSON.parse(reply);
};

test("one JSON line in, one out, on a 0600 socket: app.info, login_item.*, update.* refused without an updater, and unsupported for anything else", async () => {
  const path = join(temporary(), "app.sock");
  const app = await serve(path);
  assert.equal(app.line, "listening");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(statSync(path).isSocket());

  // The daemon is down (backing off) and the app is stopping; the app answers regardless.
  assert.deepEqual(await call(path, "app.info", {}, "req-1"), {
    id: "req-1", ok: true,
    result: { version: "9.8.7", build: "dev", in_applications: false, children: { daemon: "backing_off", connector: "running" }, stopping: { reason: "quit", pending: ["alpha-otter"] }, update: null },
  });
  assert.deepEqual((await call(path, "login_item.get")).result, { state: "disabled" });
  assert.deepEqual((await call(path, "login_item.set", { enabled: true })).result, { state: "enabled" });
  assert.deepEqual((await call(path, "login_item.get")).result, { state: "enabled" });
  assert.deepEqual((await call(path, "login_item.set", { enabled: false })).result, { state: "disabled" });
  assert.deepEqual(await call(path, "login_item.set", {}, "req-2"), { id: "req-2", ok: false, error: { code: "invalid_input", message: 'login_item.set takes {"enabled": true|false}', retryable: false } });
  // A build without Sparkle has no updater: `update` is null and `update.*` is refused.
  assert.deepEqual(await call(path, "update.status", {}, "req-3"), { id: "req-3", ok: false, error: { code: "unsupported", message: "this Localbox (9.8.7, dev) does not update itself; install a new release to update it", retryable: false } });
  assert.equal((await call(path, "popover.open")).error.code, "unsupported");

  // A garbled request is answered, not left hanging; the second line of a request is never read.
  const garbled = JSON.parse(await exchange(path, "not json\n"));
  assert.deepEqual([garbled.id, garbled.ok, garbled.error.code], [null, false, "invalid_input"]);
  const twice = await exchange(path, `${JSON.stringify({ id: "a", operation: "login_item.get" })}\n${JSON.stringify({ id: "b", operation: "app.info" })}\n`);
  assert.deepEqual(twice.trim().split("\n").map((reply) => JSON.parse(reply).id), ["a"]);

  await quit(app);
  assert.equal(existsSync(path), false, "a stopped app removes its socket");
});

test("a requires_approval registration is a state the socket reports, not an error", async () => {
  const path = join(temporary(), "app.sock");
  const app = await serve(path, "approval");
  assert.deepEqual(await call(path, "login_item.set", { enabled: true }), { id: "t-login_item.set", ok: true, result: { state: "requires_approval" } });
  assert.deepEqual((await call(path, "login_item.get")).result, { state: "requires_approval" });
  assert.deepEqual((await call(path, "login_item.set", { enabled: false })).result, { state: "disabled" });
  await quit(app);
});

test("a socket file left by a dead app is replaced; a live app's socket is not taken over", async () => {
  const directory = temporary(), path = join(directory, "app.sock");
  // An app killed outright leaves its socket file behind with nothing listening.
  const dead = await serve(path);
  dead.child.kill("SIGKILL");
  await dead.exited;
  assert.ok(statSync(path).isSocket(), "the killed app left its socket file");
  await assert.rejects(exchange(path, "\n"), /ECONNREFUSED/);
  const first = await serve(path);
  assert.equal(first.line, "listening", "the dead app's socket file was replaced");
  assert.equal((await call(path, "login_item.get")).ok, true);

  const second = await serve(path);
  assert.match(second.line, /^refused another Localbox app already answers at /);
  assert.equal((await call(path, "login_item.get")).ok, true, "the first app still answers");
  await second.exited;

  await quit(first);
  writeFileSync(path, "not a socket");
  const third = await serve(path);
  assert.match(third.line, /^refused .* exists and is not a socket$/);
  await third.exited;
  assert.equal(existsSync(path), true, "a file the app never made is left alone");
});
