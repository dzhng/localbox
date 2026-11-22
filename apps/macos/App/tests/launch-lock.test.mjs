import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compile, run, temporary } from "./driver.mjs";

// The app's side of the shared launch lock: the update waits while a command holds it shared (as the launcher does
// for a command's whole life), and refuses a lock file that is not a private one, as Sparkle's helper would.
const DRIVER = `
import Foundation
@main struct Driver {
  static func main() {
    let info: [String: Any] = ["LocalboxLaunchLockRelativePath": CommandLine.arguments[2]]
    guard let lock = LaunchLock(info: info, home: CommandLine.arguments[1]) else { print("no lock"); return }
    print(lock.path)
    if CommandLine.arguments.count > 3 { do { try lock.prepare(); print("prepared") } catch { print("refused: \\(error)") }; return }
    let started = Date()
    do { try lock.waitUntilFree(interval: 0.05) { print("waiting") } } catch { print("refused: \\(error)"); return }
    print(Date().timeIntervalSince(started) > 0.4 ? "free after the command" : "free at once")
  }
}
`;

test("an update waits until no command holds the launch lock shared, and a lock file that is not private is refused", async () => {
  const driver = compile(DRIVER), home = temporary("lb-lock-");
  assert.deepEqual(run(driver, [home, "Library/Caches/sh.localbox.mac/launch.lock", "prepare"]).split("\n"), [join(home, "Library/Caches/sh.localbox.mac/launch.lock"), "prepared"]);
  assert.deepEqual(run(driver, [home, "Library/Caches/sh.localbox.mac/launch.lock"]).split("\n").slice(1), ["free at once"]);
  // A command's whole life, as the launcher holds it: shared, for 700 ms.
  const lock = join(home, "Library/Caches/sh.localbox.mac/launch.lock");
  const holder = spawn("perl", ["-e", 'use Fcntl ":flock"; open(F, "<", $ARGV[0]) or die; flock(F, LOCK_SH) or die; $| = 1; print "held\\n"; select(undef, undef, undef, 0.7);', lock], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const waited = await new Promise((resolve) => { const child = spawn(driver, [home, "Library/Caches/sh.localbox.mac/launch.lock"]); let out = ""; child.stdout.on("data", (chunk) => { out += chunk; }); child.on("close", () => resolve(out.trim().split("\n").slice(1))); });
  assert.deepEqual(waited, ["waiting", "free after the command"]);
  chmodSync(lock, 0o644);
  assert.match(run(driver, [home, "Library/Caches/sh.localbox.mac/launch.lock", "prepare"]), /refused: .* is not a private file owned by this user/);
  assert.equal(run(driver, [home, "../escape/launch.lock"]), "no lock");
  assert.equal(run(driver, [home, "/absolute/launch.lock"]), "no lock");
});
