import assert from "node:assert/strict";
import { test } from "node:test";
import { compile, run } from "./driver.mjs";

// Fake children log when each starts and stops; the fake daemon's stop lasts until the driver has fed the daemon's
// shutdown lines, as a real daemon's stop lasts until its sandboxes are saved.
const DRIVER = `
import Foundation
final class Log: @unchecked Sendable { private let lock = NSLock(); private var lines: [String] = []
  func add(_ line: String) { lock.withLock { lines.append(line) } }; var all: [String] { lock.withLock { lines } } }
final class Fake: Supervised, @unchecked Sendable {
  let name: String; let log: Log; let gate: DispatchSemaphore?
  init(_ name: String, _ log: Log, gate: DispatchSemaphore? = nil) { self.name = name; self.log = log; self.gate = gate }
  func start() { log.add("start \\(name)") }
  func stop() { log.add("stop \\(name) begins"); gate?.wait(); log.add("stop \\(name) ends") }
}
func describe(_ state: Lifetime.State) -> String {
  switch state { case .running: return "running"; case .stopped: return "stopped"
  case .stopping(let reason, let pending, let quiet): return "stopping \\(reason.rawValue) [\\(pending.joined(separator: ","))]\\(quiet ? " quiet" : "")" }
}
@main struct Driver {
  static func main() {
    let log = Log(), gate = DispatchSemaphore(value: 0), done = DispatchSemaphore(value: 0)
    let lifetime = Lifetime(connector: Fake("connector", log), daemon: Fake("daemon", log, gate: gate)) { state in
      log.add(describe(state)); if state == .stopped { done.signal() } }
    lifetime.start()
    lifetime.daemonSaid("localbox-hostd: hibernated alpha")   // not stopping yet: ignored
    lifetime.stop(.logout, running: ["alpha", "beta", "gamma"])
    lifetime.stop(.quit)                                       // a second request changes nothing
    while !log.all.contains("stop daemon begins") { Thread.sleep(forTimeInterval: 0.01) }
    lifetime.daemonSaid("localbox-hostd: stopping (stdin closed): hibernating running sandboxes")
    lifetime.daemonSaid("localbox-hostd: hibernated beta")
    lifetime.daemonSaid("localbox-hostd: stopped alpha: could not save its state: no room")
    lifetime.daemonSaid("localbox-hostd: hibernated someone-else")
    lifetime.daemonSaid("localbox-hostd: hibernated gamma")
    gate.signal()
    done.wait()
    for line in log.all { print(line) }
  }
}
`;

const WITH_IMAGE = DRIVER.replace(/@main struct Driver \{[\s\S]*$/, `
@main struct Driver {
  static func main() {
    let log = Log(), stopped = DispatchSemaphore(value: 0), gate = DispatchSemaphore(value: 0)
    let lifetime = Lifetime(connector: Fake("connector", log), daemon: Fake("daemon", log, gate: gate), image: Fake("image", log)) { state in
      log.add(describe(state)); if state == .stopped { stopped.signal() } }
    lifetime.start()
    lifetime.stop(.update)
    while !log.all.contains("stop daemon begins") { Thread.sleep(forTimeInterval: 0.01) }
    log.add("restart while stopping: \\(lifetime.restart())")
    gate.signal()
    stopped.wait()
    log.add("restart after the update's stop: \\(lifetime.restart())")
    lifetime.stop(.quit)
    gate.signal()
    stopped.wait()
    log.add("restart after a quit: \\(lifetime.restart())")
    for line in log.all { print(line) }
  }
}
`);

test("an update's stop can be undone once it is over, starting all three again; a quit's cannot; the image stops before the daemon", () => {
  assert.deepEqual(run(compile(WITH_IMAGE)).split("\n"), [
    "start daemon", "start connector", "start image",
    "stopping update []",
    "stop connector begins", "stop connector ends", "stop image begins", "stop image ends", "stop daemon begins", "restart while stopping: false", "stop daemon ends", "stopped",
    "running", "start daemon", "start connector", "start image", "restart after the update's stop: true",
    "stopping quit []",
    "stop connector begins", "stop connector ends", "stop image begins", "stop image ends", "stop daemon begins", "stop daemon ends", "stopped",
    "restart after a quit: false",
  ]);
});

test("the connector starts after the daemon and stops before it; pending empties as the daemon reports each sandbox; only the first stop counts", () => {
  const lines = run(compile(DRIVER)).split("\n");
  assert.deepEqual(lines, [
    "start daemon", "start connector",
    "stopping logout [alpha,beta,gamma]",
    "stop connector begins", "stop connector ends", "stop daemon begins",
    "stopping logout [alpha,gamma]",
    "stopping logout [gamma]",
    "stopping logout []",
    "stop daemon ends",
    "stopped",
  ]);
});

const QUIET = DRIVER.replace(/@main struct Driver \{[\s\S]*$/, `
@main struct Driver {
  static func main() {
    let log = Log(), gate = DispatchSemaphore(value: 0), done = DispatchSemaphore(value: 0)
    let lifetime = Lifetime(connector: Fake("connector", log), daemon: Fake("daemon", log, gate: gate), quietAfter: 0.3) { state in
      log.add(describe(state)); if state == .stopped { done.signal() } }
    func waitFor(_ line: String) { let end = Date().addingTimeInterval(10); while !log.all.contains(line) && Date() < end { Thread.sleep(forTimeInterval: 0.01) } }
    lifetime.start()
    lifetime.stop(.quit, running: ["alpha", "beta"])
    waitFor("stopping quit [alpha,beta] quiet")
    lifetime.daemonSaid("localbox-hostd: still saving alpha")   // any line: it is not wedged
    lifetime.daemonSaid("localbox-hostd: hibernated alpha")
    Thread.sleep(forTimeInterval: 0.1)
    log.add("--- talking again")
    waitFor("stopping quit [beta] quiet")
    gate.signal()
    done.wait()
    Thread.sleep(forTimeInterval: 0.5)                         // nothing more once stopped
    for line in log.all { print(line) }
  }
}
`);

test("a daemon silent for quietAfter while stopping is marked quiet and still waited for; any line clears it", () => {
  assert.deepEqual(run(compile(QUIET)).split("\n"), [
    "start daemon", "start connector",
    "stopping quit [alpha,beta]",
    "stop connector begins", "stop connector ends", "stop daemon begins",
    "stopping quit [alpha,beta] quiet",
    "stopping quit [alpha,beta]",
    "stopping quit [beta]",
    "--- talking again",
    "stopping quit [beta] quiet",
    "stop daemon ends",
    "stopped",
  ]);
});
