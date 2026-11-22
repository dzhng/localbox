import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, run, swiftString } from "./driver.mjs";

// Localbox's update gate: the real
// UpdateCoordinator with fake steps, driven as Sparkle drives it. Each scenario prints what happened, in order.
const facts = new URL("./fixtures/facts/three-sandboxes.json", import.meta.url).pathname;
const DRIVER = `
import Foundation
@MainActor final class Log { var lines: [String] = []; func add(_ line: String) { lines.append(line) } }
func makeFacts(hibernate: String = "available", locked: Bool = false, running: Bool = true, imagePhase: String? = nil) throws -> AppFacts {
  var object = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: ${swiftString(facts)}))) as! [String: Any]
  object["hibernate"] = hibernate
  object["screen_locked_now"] = locked
  if !running { object["sandboxes"] = (object["sandboxes"] as! [[String: Any]]).filter { $0["state"] as? String != "running" } }
  if let imagePhase { object["images"] = [["name": "linux", "state": "downloading", "phase": imagePhase]] }
  return try AppFacts.decode(try JSONSerialization.data(withJSONObject: object))
}
final class Box: @unchecked Sendable {
  var facts: () throws -> AppFacts = { try makeFacts() }
  var commands = 0          // localbox commands holding the launch lock, 50 ms of the wait each
  var lockFails = false
  var stopping: (@MainActor () -> Void)?
}
@main struct Driver {
  @MainActor static func main() async throws {
    let scenario = CommandLine.arguments[1]
    let log = Log(), box = Box()
    var granted = Date()
    let coordinator = UpdateCoordinator(steps: UpdateSteps(
      facts: { await MainActor.run { log.add("facts") }; return try box.facts() },
      stopChildren: { names in
        await MainActor.run { log.add("stop children [\\(names.joined(separator: ","))]"); box.stopping?() }
        // A daemon's stop runs to its end whatever happens meanwhile.
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { done.resume() } }
        await MainActor.run { log.add("children stopped") }
      },
      restartChildren: { MainActor.assumeIsolated { log.add("restart children") } },
      waitForCommands: { waiting in
        if box.lockFails { throw LaunchLockError("cannot open the lock") }
        // The wait for commands stops when the update is called off.
        if box.commands > 0 { waiting(); try await Task.sleep(nanoseconds: UInt64(box.commands) * 50_000_000) }
        await MainActor.run { log.add("no commands") }
      },
      exit: { MainActor.assumeIsolated { log.add("exit \\(Date().timeIntervalSince(granted) < 1 ? "at once" : "late")") } }))
    var last: String?
    func status() { if let message = coordinator.message, last != message { last = message; log.add("status: \\(message)") } }
    func settle() async { for _ in 0..<60 { try? await Task.sleep(nanoseconds: 10_000_000); status() } }
    // Sparkle's side of a cycle: a downloaded update, then (once granted) the helper's request and its authorization.
    func offer() {
      coordinator.downloading(version: "0.9.0"); status()
      coordinator.ready(install: {
        granted = Date(); log.add("grant")
        coordinator.installing(authorize: { log.add("authorize"); coordinator.willRelaunch() })
      }, cancel: { log.add("cancel") })
      status()
    }
    coordinator.setAvailability(enabled: scenario != "manual-only")
    switch scenario {
    case "automatic":
      offer()
    case "locked":
      box.facts = { try makeFacts(hibernate: "only_while_unlocked", locked: true) }
      offer(); await settle()
      log.add("can check: \\(coordinator.canCheck)")
      coordinator.check()       // Settings' Check for Updates while it waits: a person's install
    case "password-lock-unlocked":
      box.facts = { try makeFacts(hibernate: "only_while_unlocked", locked: false) }
      offer()
    case "unknown-lock-unlocked":
      box.facts = { try makeFacts(hibernate: "unknown", locked: false) }
      offer()
    case "unknown-lock-locked":
      box.facts = { try makeFacts(hibernate: "unknown", locked: true) }
      offer()
    case "no-password-locked":
      box.facts = { try makeFacts(hibernate: "available", locked: true) }
      offer()
    case "unlocked-while-waiting":
      box.facts = { try makeFacts(hibernate: "only_while_unlocked", locked: true) }
      offer(); await settle()
      box.facts = { try makeFacts(hibernate: "only_while_unlocked", locked: false) }
      coordinator.factsChanged()
    case "locked-nothing-running":
      box.facts = { try makeFacts(hibernate: "only_while_unlocked", locked: true, running: false) }
      offer()
    case "image-installing":
      box.facts = { try makeFacts(imagePhase: "installing") }
      offer(); coordinator.install(); await settle()   // a person's install: the image still blocks
      box.facts = { try makeFacts() }
      coordinator.factsChanged()
    case "commands":
      box.commands = 3
      offer()
    case "lock-fails":
      box.lockFails = true
      offer()
    case "helper-refuses":
      coordinator.downloading(version: "0.9.0")
      coordinator.ready(install: {
        log.add("grant")
        coordinator.cycleFinished(error: "launch lock is unavailable; update deferred without terminating the application", upToDate: false)
      }, cancel: { log.add("cancel") })
    case "installer-killed":
      box.commands = 200          // a command that would hold the install for 10 s
      offer(); await settle()
      log.add("sparkle ends the cycle")
      coordinator.cycleFinished(error: "an error occurred while running the updater", upToDate: false)
    case "turned-off-while-stopping":
      box.stopping = { coordinator.setAutomatic(false) }
      offer()
    case "facts-unreadable":
      box.facts = { throw CLIFailure(code: "guest_unreachable", message: "Localbox is not running") }
      offer()
    case "check-answers-at-once":
      coordinator.cycleFinished(error: nil, upToDate: true); status()   // the last cycle found nothing newer
      coordinator.startCheck = { log.add("sparkle asked") }
      coordinator.check()
      log.add("answer: \\(coordinator.phase.rawValue), \\(coordinator.message ?? "-")")
    case "manual-only":
      offer(); await settle()
      log.add("can check: \\(coordinator.canCheck)")
      coordinator.install()
    default: fatalError(scenario)
    }
    await settle()
    log.add("phase \\(coordinator.phase.rawValue)")
    for line in log.lines { print(line) }
  }
}
`;

let driver;
before(() => { driver = compile(DRIVER); });
const scenario = (name) => run(driver, [name]).split("\n");
const withoutStatus = (lines) => lines.filter((line) => !line.startsWith("status:"));

test("gate order: blockers, connector and daemon stopped (hibernating), no commands, then the permit, and exit as soon as Sparkle authorizes", () => {
  const lines = scenario("automatic");
  assert.deepEqual(withoutStatus(lines), ["facts", "stop children [quiet-otter]", "children stopped", "no commands", "grant", "authorize", "exit at once", "phase installing"]);
  assert.ok(lines.indexOf("status: Putting 1 sandbox to sleep to install Localbox 0.9.0…") < lines.indexOf("children stopped"), lines.join("\n"));
});

const INSTALLS = ["facts", "stop children [quiet-otter]", "children stopped", "no commands", "grant", "authorize", "exit at once", "phase installing"];
const WAITING = "status: Waiting: this Mac is locked, so installing could restart running sandboxes. Unlock it, or use Check for Updates in Settings to install anyway.";

test("automatic installs wait while sandboxes run and the screen is locked with a password lock; Check for Updates installs anyway, saying they may restart", () => {
  const lines = scenario("locked");
  const asked = lines.indexOf("can check: true");
  assert.ok(lines.slice(0, asked).includes(WAITING), lines.join("\n"));
  assert.ok(!lines.slice(0, asked).some((line) => line.startsWith("stop children")), "nothing stopped while blocked");
  const after = lines.slice(asked);
  assert.deepEqual(withoutStatus(after), ["can check: true", ...INSTALLS]);
  assert.ok(after.includes("status: Installing Localbox 0.9.0 while this Mac is locked; running sandboxes may restart."), after.join("\n"));
});

test("a password lock with the screen unlocked does not block: the sandboxes are put to sleep and the update installs", () => {
  const lines = scenario("password-lock-unlocked");
  assert.deepEqual(withoutStatus(lines), INSTALLS);
  assert.ok(lines.includes("status: Putting 1 sandbox to sleep to install Localbox 0.9.0…") && !lines.includes(WAITING), lines.join("\n"));
});

test("an unreadable lock setting blocks only while the screen is locked; no password lock never blocks", () => {
  assert.deepEqual(withoutStatus(scenario("unknown-lock-unlocked")), INSTALLS);
  const unknownLocked = scenario("unknown-lock-locked");
  assert.ok(unknownLocked.includes(WAITING) && !unknownLocked.some((line) => line.startsWith("stop children")), unknownLocked.join("\n"));
  assert.equal(unknownLocked.at(-1), "phase waiting");
  assert.deepEqual(withoutStatus(scenario("no-password-locked")), INSTALLS);
});

test("an update waiting on a locked screen installs once the facts say it is unlocked", () => {
  const lines = scenario("unlocked-while-waiting");
  const waited = lines.indexOf(WAITING);
  assert.ok(waited > 0, lines.join("\n"));
  assert.deepEqual(withoutStatus(lines.slice(waited)), INSTALLS);
});

test("with nothing running, hibernation being unavailable does not block an automatic install", () => {
  assert.deepEqual(withoutStatus(scenario("locked-nothing-running")), ["facts", "stop children []", "children stopped", "no commands", "grant", "authorize", "exit at once", "phase installing"]);
});

test("the built-in image being swapped in blocks even a manual install, until the facts change", () => {
  const lines = scenario("image-installing");
  const blocked = lines.indexOf("status: Waiting for the built-in Linux image to finish installing.");
  assert.ok(blocked > 0, lines.join("\n"));
  assert.ok(lines.indexOf("stop children [quiet-otter]") > blocked);
  assert.equal(lines.filter((line) => line === "facts").length, 2);
  assert.equal(lines.at(-1), "phase installing");
});

test("running localbox commands delay the permit, and say so", () => {
  const lines = scenario("commands");
  assert.ok(lines.indexOf("status: Waiting for localbox commands to finish.") > lines.indexOf("children stopped"), lines.join("\n"));
  assert.ok(lines.indexOf("grant") > lines.indexOf("no commands"));
});

test("a failure before the permit restarts the children, ends Sparkle's cycle and says why", () => {
  const lines = scenario("lock-fails");
  assert.deepEqual(withoutStatus(lines), ["facts", "stop children [quiet-otter]", "children stopped", "restart children", "cancel", "phase failed"]);
  assert.ok(lines.includes("status: Update failed: the launch lock could not be checked (cannot open the lock). Your current version is unchanged."), lines.join("\n"));
  assert.ok(!lines.includes("grant"));
});

test("Sparkle's helper refusing after the permit (a command took the lock) restarts the children and reports it", () => {
  const lines = scenario("helper-refuses");
  assert.deepEqual(lines.slice(lines.indexOf("grant")), ["grant", "restart children",
    "status: Update failed: launch lock is unavailable; update deferred without terminating the application. Your current version is unchanged.", "phase failed"]);
});

test("Sparkle ending the cycle while a command holds the install (its installer killed) stops the wait and brings the children back at once", () => {
  const lines = scenario("installer-killed");
  const ended = lines.indexOf("sparkle ends the cycle");
  assert.ok(lines.indexOf("status: Waiting for localbox commands to finish.") < ended, lines.join("\n"));
  assert.deepEqual(withoutStatus(lines.slice(ended)), ["sparkle ends the cycle", "restart children", "phase failed"]);
  assert.ok(lines.includes("status: Update failed: an error occurred while running the updater. Your current version is unchanged."), lines.join("\n"));
});

test("turning automatic installs off while the children stop brings them back and withdraws the update", () => {
  assert.deepEqual(withoutStatus(scenario("turned-off-while-stopping")), ["facts", "stop children [quiet-otter]", "children stopped", "restart children", "cancel", "phase disabled"]);
});

test("facts that cannot be read stop nothing; the update keeps waiting", () => {
  const lines = scenario("facts-unreadable");
  assert.ok(!lines.some((line) => line.startsWith("stop children")));
  assert.ok(lines.includes("status: Waiting: Localbox could not read this Mac's state (Localbox is not running)."), lines.join("\n"));
  assert.equal(lines.at(-1), "phase waiting");
});

test("with automatic installs off a downloaded update waits for a person; installing it then runs the same gate", () => {
  const lines = scenario("manual-only");
  assert.ok(lines.includes("status: Localbox 0.9.0 is ready. Check for Updates to install it."), lines.join("\n"));
  assert.ok(lines.indexOf("can check: true") < lines.indexOf("facts"), "nothing ran before the person asked");
  assert.deepEqual(withoutStatus(lines.slice(lines.indexOf("facts"))), ["facts", "stop children [quiet-otter]", "children stopped", "no commands", "grant", "authorize", "exit at once", "phase installing"]);
});

test("a check reads as checking the moment it is asked for, never as the last cycle's answer", () => {
  const lines = scenario("check-answers-at-once");
  assert.ok(lines.includes("status: You’re up to date."), lines.join("\n"));
  const asked = lines.indexOf("sparkle asked");
  assert.deepEqual(lines.slice(asked, asked + 2), ["sparkle asked", "answer: checking, Checking for updates…"], lines.join("\n"));
});
