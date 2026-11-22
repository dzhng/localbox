import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, run } from "./driver.mjs";

// The driver plays one Mac's history against a fake SMAppService: each step is a launch (`release`, `apps`: in an
// Applications folder), an explicit `set`, or the user removing the item in System Settings (`outside`), every one through a fresh LoginItem over the same driver and the same
// remembered flag, as successive launches of the app would be. It prints each step's resulting state. `approval`
// makes registering land in requires_approval; `failures` makes that many registrations throw first.
const DRIVER = `
import Foundation
struct Step: Decodable { let launch: Launch?; let set: Bool?; let outside: Bool? }
struct Launch: Decodable { let release: Bool; let apps: Bool }
struct Scenario: Decodable { let approval: Bool?; let failures: Int?; let steps: [Step] }
struct Refused: Error {}
final class Flaky: LoginItemDriver, @unchecked Sendable {
  let inner: FakeLoginItem; var failures: Int
  init(_ inner: FakeLoginItem, failures: Int) { self.inner = inner; self.failures = failures }
  var state: LoginItemState { inner.state }
  func register() throws { if failures > 0 { failures -= 1; throw Refused() }; try inner.register() }
  func unregister() throws { try inner.unregister() }
}
final class Flag: @unchecked Sendable { var value = false }
@main struct Driver {
  static func main() throws {
    let scenario = try JSONDecoder().decode(Scenario.self, from: Data(CommandLine.arguments[1].utf8))
    let driver = Flaky(FakeLoginItem(approval: scenario.approval ?? false), failures: scenario.failures ?? 0)
    let flag = Flag()
    var out: [String] = []
    for step in scenario.steps {
      let item = LoginItem(driver: driver, remembered: { flag.value }, remember: { flag.value = true })
      if let launch = step.launch { item.launched(isRelease: launch.release, inApplications: launch.apps); out.append(item.state.rawValue) }
      if let enabled = step.set { out.append(try item.set(enabled: enabled).rawValue) }
      if step.outside == true { try driver.unregister(); out.append(item.state.rawValue) }
    }
    print(out.joined(separator: " "))
  }
}
`;

let driver;
before(() => { driver = compile(DRIVER); });
const play = (scenario) => run(driver, [JSON.stringify(scenario)]).split(" ");
const release = { launch: { release: true, apps: true } };

test("a release in an Applications folder registers on its first launch, and a user who turned it off stays off", () => {
  assert.deepEqual(play({ steps: [release, release, { set: false }, release, release, { set: true }, release] }),
    ["enabled", "enabled", "disabled", "disabled", "disabled", "enabled", "enabled"]);
});

test("turned off outside the app (System Settings) is never turned back on either", () => {
  assert.deepEqual(play({ steps: [release, { outside: true }, release, release] }), ["enabled", "disabled", "disabled", "disabled"]);
});

test("a development build never registers by default, only when asked", () => {
  const dev = { launch: { release: false, apps: true } };
  assert.deepEqual(play({ steps: [dev, dev, { set: true }, dev, { set: false }, dev] }), ["disabled", "disabled", "enabled", "enabled", "disabled", "disabled"]);
});

test("a release outside an Applications folder waits: moved into one, its first launch there registers", () => {
  const elsewhere = { launch: { release: true, apps: false } };
  assert.deepEqual(play({ steps: [elsewhere, elsewhere, release] }), ["disabled", "disabled", "enabled"]);
  assert.deepEqual(play({ steps: [elsewhere, { set: false }, release] }), ["disabled", "disabled", "disabled"], "an explicit off there is final too");
});

test("requires_approval is a state: registered once, reported, and not registered again", () => {
  assert.deepEqual(play({ approval: true, steps: [release, release, { set: false }, release] }), ["requires_approval", "requires_approval", "disabled", "disabled"]);
});

test("a registration that fails is not remembered, so the next launch tries again", () => {
  assert.deepEqual(play({ failures: 1, steps: [release, release, { set: false }, release] }), ["disabled", "enabled", "disabled", "disabled"]);
});
