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
  case .stopping(let reason, let pending): return "stopping \\(reason.rawValue) [\\(pending.joined(separator: ","))]" }
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
