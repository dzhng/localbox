import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { compile, run, swiftString, temporary } from "./driver.mjs";

// One peer plays every child: `crashy` exits at once four times, then stays up past the reset window, then waits for
// its stdin to close; `stubborn` ignores both stdin and SIGTERM and leaves a descendant in its process group;
// `saving` writes a progress line every 200 ms for 2 s after its stdin closes; `wedged` writes nothing after its
// stdin closes and exits 1.5 s later. Every peer records what happened to it in the events file, one line each.
const PEER = `
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const [mode, events] = process.argv.slice(2);
const note = (line) => appendFileSync(events, line + "\\n");
const count = () => { try { return readFileSync(events, "utf8").split("\\n").filter((line) => line.startsWith("start ")).length; } catch { return 0; } };
process.on("SIGTERM", () => { note("term " + process.pid); });
const run = count() + 1;
note("start " + run + " " + Date.now() + " " + process.pid);
const end = (code) => { note("exit " + run + " " + Date.now()); process.exit(code); };
if (mode === "crashy") {
  if (run <= 4) end(1);
  else if (run === 5) setTimeout(() => end(1), 1300);
  else { process.stdin.on("data", () => {}); process.stdin.on("end", () => end(0)); }
}
if (mode === "stubborn") {
  const descendant = spawn("/bin/sleep", ["3600"], { stdio: "ignore" });
  note("descendant " + descendant.pid);
  process.stdin.on("data", () => {});
  setInterval(() => {}, 1000);
}
if (mode === "saving") {
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => {
    let n = 0;
    const tick = setInterval(() => { console.log("localbox-hostd: hibernated sandbox-" + ++n); if (n === 10) { clearInterval(tick); note("exit"); process.exit(0); } }, 200);
  });
  console.log("ready");
}
if (mode === "wedged") { process.stdin.on("data", () => {}); process.stdin.on("end", () => setTimeout(() => { note("exit"); process.exit(0); }, 1500)); setInterval(() => {}, 1000); console.log("ready"); }
if (mode === "oneshot") end(run === 3 || run === 4 ? 0 : 1);
`;

// A one-shot (the built-in image's ensure) fails twice, succeeds, and is then left alone until started again.
const ONESHOT = `
import Foundation
@main struct Driver {
  static func main() {
    let a = CommandLine.arguments
    let (events, log, node, peer) = (a[1], a[2], a[3], a[4])
    let child = ChildProcess(name: "oneshot", launch: ChildLaunch(executable: URL(fileURLWithPath: node), arguments: [peer, "oneshot", events], environment: ProcessInfo.processInfo.environment, log: URL(fileURLWithPath: log)),
                             policy: .imageEnsure, backoff: Backoff(initial: 0.2, maximum: 0.8, resetAfter: 10), restart: .untilSuccess, diagnostic: { _ in })
    func count(_ prefix: String) -> Int { ((try? String(contentsOfFile: events, encoding: .utf8)) ?? "").split(separator: "\\n").filter { $0.hasPrefix(prefix) }.count }
    func wait(_ check: () -> Bool) { let end = Date().addingTimeInterval(15); while !check() && Date() < end { Thread.sleep(forTimeInterval: 0.01) }; precondition(check(), "timed out") }
    child.start()
    wait { count("exit ") == 3 }
    Thread.sleep(forTimeInterval: 1.5)
    print("after success: \\(count("start ")) starts, \\(child.state.rawValue)")
    child.start()
    wait { count("exit ") == 4 }
    Thread.sleep(forTimeInterval: 0.5)
    print("started again: \\(count("start ")) starts, \\(child.state.rawValue)")
  }
}
`;

const DRIVER = `
import Foundation
@main struct Driver {
  static func main() {
    let a = CommandLine.arguments
    let (mode, events, log, node, peer) = (a[1], a[2], a[3], a[4], a[5])
    let policy: StopPolicy = mode == "saving" || mode == "wedged" ? .patient : .bounded(eof: 0.3, signal: 0.3)
    let lines = Counter()
    let child = ChildProcess(name: mode, launch: ChildLaunch(executable: URL(fileURLWithPath: node), arguments: [peer, mode, events], environment: ProcessInfo.processInfo.environment, log: URL(fileURLWithPath: log)),
                             policy: policy, backoff: Backoff(initial: 0.2, maximum: 0.8, resetAfter: 1.0),
                             onLine: { line in if line.hasPrefix("localbox-hostd: ") { lines.add() } }, diagnostic: { _ in })
    func count(_ prefix: String) -> Int { ((try? String(contentsOfFile: events, encoding: .utf8)) ?? "").split(separator: "\\n").filter { $0.hasPrefix(prefix) }.count }
    func wait(_ check: () -> Bool) { let end = Date().addingTimeInterval(15); while !check() && Date() < end { Thread.sleep(forTimeInterval: 0.01) }; precondition(check(), "timed out") }
    child.start()
    switch mode {
    case "crashy": wait { count("start ") == 6 }
    case "stubborn": wait { count("descendant ") == 1 }
    default: wait { ((try? String(contentsOfFile: log, encoding: .utf8)) ?? "").contains("ready") }
    }
    let began = Date()
    child.stop()
    let took = Date().timeIntervalSince(began)
    Thread.sleep(forTimeInterval: 1.0)
    print("stopped after \\(took) heard \\(lines.value) running \\(child.pid.map(String.init) ?? "none")")
  }
}
final class Counter: @unchecked Sendable { private let lock = NSLock(); private var n = 0; func add() { lock.withLock { n += 1 } }; var value: Int { lock.withLock { n } } }
`;

let driver, oneshot, directory;
before(() => {
  directory = temporary();
  writeFileSync(join(directory, "peer.mjs"), PEER);
  driver = compile(DRIVER, directory);
  oneshot = compile(ONESHOT);
});

test("a one-shot child is retried with backoff until it exits 0, then not restarted until it is started again", () => {
  const events = join(directory, "oneshot.events");
  const output = run(oneshot, [events, join(directory, "oneshot.log"), process.execPath, join(directory, "peer.mjs")]);
  assert.deepEqual(output.split("\n"), ["after success: 3 starts, stopped", "started again: 4 starts, stopped"]);
});

function supervise(mode) {
  const events = join(directory, `${mode}.events`), log = join(directory, `${mode}.log`);
  const output = run(driver, [mode, events, log, process.execPath, join(directory, "peer.mjs")]);
  const [, took, heard, running] = /^stopped after ([\d.]+) heard (\d+) running (\S+)$/.exec(output) ?? assert.fail(output);
  return { took: Number(took), heard: Number(heard), running, events: readFileSync(events, "utf8").trim().split("\n") };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a child that keeps exiting is restarted after 0.2, 0.4, 0.8, 0.8 s, and after one that stayed up past the reset window, 0.2 s again", () => {
  const { events, running } = supervise("crashy");
  const starts = events.filter((line) => line.startsWith("start ")).map((line) => Number(line.split(" ")[2]));
  const exits = events.filter((line) => line.startsWith("exit ")).map((line) => Number(line.split(" ")[2]));
  assert.equal(starts.length, 6, "stop cancels any further restart");
  const delays = exits.slice(0, 5).map((exit, index) => (starts[index + 1] - exit) / 1000);
  // Each delay is the backoff plus the time to start a Node process, which is well under 0.35 s here.
  [0.2, 0.4, 0.8, 0.8, 0.2].forEach((expected, index) => assert.ok(delays[index] >= expected && delays[index] < expected + 0.35, `restart ${index + 1} after ${delays[index]} s, expected ${expected} s: ${delays}`));
  assert.ok(events.at(-1).startsWith("exit 6"), "the last child exited on its own when its stdin closed");
  assert.equal(running, "none");
});

test("a bounded child that ignores its stdin closing and SIGTERM is killed with its whole process group", () => {
  const { events, took } = supervise("stubborn");
  const peer = Number(events.find((line) => line.startsWith("start ")).split(" ")[3]);
  const descendant = Number(events.find((line) => line.startsWith("descendant ")).split(" ")[1]);
  try {
    assert.ok(events.includes(`term ${peer}`), "SIGTERM came first");
    assert.ok(took >= 0.6 && took < 2, `stdin, 0.3 s, SIGTERM, 0.3 s, SIGKILL: took ${took} s`);
    assert.equal(alive(peer), false, "the child is gone");
    assert.equal(alive(descendant), false, "its descendant went with its process group");
  } finally { for (const pid of [peer, descendant]) { try { process.kill(pid, "SIGKILL"); } catch {} } }
});

test("a patient child that keeps writing progress after its stdin closes is waited for and never signalled", () => {
  const { events, took, heard } = supervise("saving");
  assert.ok(!events.some((line) => line.startsWith("term")), `no SIGTERM: ${events}`);
  assert.ok(events.includes("exit"), "it exited on its own, unkilled");
  assert.ok(took >= 1.9, `stop waited for all 2 s of progress (${took} s)`);
  assert.equal(heard, 10, "every progress line reached onLine");
});

test("a patient child silent after its stdin closes is waited for until it exits, with no signal", () => {
  const { events, took } = supervise("wedged");
  assert.ok(!events.some((line) => line.startsWith("term")), `no SIGTERM: ${events}`);
  assert.ok(events.includes("exit"), "it exited on its own");
  assert.ok(took >= 1.4, `waited out its 1.5 s of silence: ${took} s`);
});
