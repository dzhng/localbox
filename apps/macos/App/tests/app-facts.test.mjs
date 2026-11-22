import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { compile, run, temporary } from "./driver.mjs";

// The app's half of `localbox app status`: `AppFacts` decodes every fixture the CLI's tests write (tests/app-facts.test.ts),
// `FactsSource` polls as the popover and Settings need, and `BundledCLI` stops a poll nobody waits for.
const FIXTURES = new URL("./fixtures/facts/", import.meta.url).pathname;

const DRIVER = `
import Foundation
final class Log: @unchecked Sendable { private let lock = NSLock(); private var lines: [String] = []
  func add(_ line: String) { lock.withLock { lines.append(line) } }; var all: [String] { lock.withLock { lines } } }
func pause(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
@main struct Driver {
  static func main() async throws {
    let args = CommandLine.arguments
    switch args[1] {
    case "decode":
      // Each fixture decoded and encoded again, so a field either side lacks shows as a difference.
      var out: [String: Any] = [:]
      for name in try FileManager.default.contentsOfDirectory(atPath: args[2]).sorted() where name.hasSuffix(".json") {
        let facts = try AppFacts.decode(Data(contentsOf: URL(fileURLWithPath: args[2]).appendingPathComponent(name)))
        out[name] = ["facts": try JSONSerialization.jsonObject(with: facts.encoded()), "hibernating": facts.hibernating]
      }
      print(String(decoding: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), as: UTF8.self))
    case "source":
      // A fake CLI: each plain read answers a new version; a --since read waits until it is cancelled.
      let template = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[2]))) as! [String: Any]
      let log = Log(), counter = Log()
      let source = FactsSource(fetch: { arguments in
        log.add(arguments.joined(separator: " "))
        if arguments.contains("--since") {
          do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { log.add("cancelled"); throw error }
        }
        counter.add("x")
        var facts = template; facts["watch_version"] = counter.all.count
        return try JSONSerialization.data(withJSONObject: facts)
      }, idleRefresh: 0.25, published: { facts in log.add("published \\(facts.watchVersion)") })
      source.start()
      await pause(0.6)
      log.add("open")
      source.setWatching(true)
      await pause(0.4)
      log.add("close")
      source.setWatching(false)
      await pause(0.1)
      source.stop()
      await pause(0.4)
      print(log.all.joined(separator: "\\n"))
    case "cancel":
      let cli = BundledCLI(bundle: URL(fileURLWithPath: args[2]), environment: ["PATH": "/usr/bin:/bin"])
      let started = Date()
      let task = Task { try await cli.run(["app", "status", "--since", "1"]) }
      await pause(0.5)
      task.cancel()
      let outcome: String
      do { _ = try await task.value; outcome = "answered" } catch is CancellationError { outcome = "cancelled" } catch { outcome = "failed \\(error)" }
      print("\\(outcome) \\(Int(Date().timeIntervalSince(started) * 1000))")
    default: fatalError("unknown mode")
    }
  }
}
`;

let driver;
before(() => { driver = compile(DRIVER); });

/** The fixture as JSON with its nulls dropped, as Swift encodes absent optionals; `update` is slice 15's. */
const withoutNulls = (value) => Array.isArray(value) ? value.map(withoutNulls)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key, item]) => item !== null && key !== "update").map(([key, item]) => [key, withoutNulls(item)])) : value;

test("AppFacts decodes every fixture the CLI's tests write, losing nothing", () => {
  const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".json")).sort();
  assert.ok(names.length >= 10, `fixtures: ${names}`);
  const decoded = JSON.parse(run(driver, ["decode", FIXTURES]));
  assert.deepEqual(Object.keys(decoded).sort(), names);
  for (const name of names) assert.deepEqual(decoded[name].facts, withoutNulls(JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))), name);
  assert.deepEqual(decoded["three-sandboxes.json"].hibernating, ["quiet-otter"], "the stop waits for the sandboxes the daemon saves");
});

test("FactsSource: idle reads every refresh; opening reads at once then long-polls with --since; closing cancels the poll", () => {
  const lines = run(driver, ["source", join(FIXTURES, "idle.json")]).split("\n");
  const open = lines.indexOf("open"), close = lines.indexOf("close");
  const idle = lines.slice(0, open);
  assert.ok(idle.filter((line) => line === "app status").length >= 2, `idle refreshes: ${idle}`);
  assert.ok(idle.every((line) => line === "app status" || line.startsWith("published ")), `no --since while idle: ${idle}`);
  const watched = lines.slice(open + 1, close);
  assert.equal(watched[0], "app status", "opening reads at once");
  const published = Number(watched[1].split(" ")[1]);
  assert.deepEqual(watched.slice(1), [`published ${published}`, `app status --since ${published}`], `then waits for a change: ${watched}`);
  assert.equal(lines[close + 1], "cancelled", `closing cancels the long poll: ${lines.slice(close)}`);
  const versions = lines.filter((line) => line.startsWith("published ")).map((line) => Number(line.split(" ")[1]));
  assert.deepEqual(versions, [...new Set(versions)], "each version is published once");
});

test("cancelling a BundledCLI run stops its command at once", () => {
  const app = join(temporary("lb-bundle-"), "Localbox Dev.app");
  mkdirSync(join(app, "Contents/Resources/cli"), { recursive: true });
  writeFileSync(join(app, "Contents/Resources/cli/localbox"), "#!/bin/sh\nexec sleep 30\n");
  chmodSync(join(app, "Contents/Resources/cli/localbox"), 0o755);
  const [outcome, ms] = run(driver, ["cancel", app]).split(" ");
  assert.equal(outcome, "cancelled");
  assert.ok(Number(ms) < 3_000, `stopped after ${ms} ms`);
});
