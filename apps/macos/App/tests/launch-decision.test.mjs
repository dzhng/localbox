import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { compile, run, temporary } from "./driver.mjs";

// The driver reads one launch as JSON and prints the decision a caller would act on.
const DRIVER = `
import Foundation
struct Launch: Decodable { let info: [String: String]; let arguments: [String]; let running: [Int32]; let bundle: String?; let home: String? }
@main struct Driver {
  static func main() throws {
    let launch = try JSONDecoder().decode(Launch.self, from: Data(CommandLine.arguments[1].utf8))
    if let bundle = launch.bundle, let home = launch.home {
      print(LaunchDecision.isInApplicationsFolder(URL(fileURLWithPath: bundle), home: URL(fileURLWithPath: home)))
      return
    }
    print(LaunchDecision.decide(isRelease: LaunchDecision.isRelease(launch.info), arguments: launch.arguments, running: launch.running))
  }
}
`;

let driver;
before(() => { driver = compile(DRIVER); });
const release = { SUFeedURL: "https://localbox.sh/mac/appcast.xml" };
const decide = (launch) => run(driver, [JSON.stringify({ info: {}, arguments: [], running: [], ...launch })]);
const inApplications = (bundle, home) => run(driver, [JSON.stringify({ info: {}, arguments: [], running: [], bundle, home })]) === "true";

test("a development build (no feed) proceeds, even beside another running copy", () => {
  assert.equal(decide({ running: [123] }), "proceed");
  assert.equal(decide({ info: { SUFeedURL: "" }, running: [123] }), "proceed");
});

test("a release hands off to another running release copy, and proceeds when it is the only one", () => {
  assert.equal(decide({ info: release, running: [4242, 77] }), "handOff(4242)");
  assert.equal(decide({ info: release }), "proceed");
});

test("Sparkle's relaunch argument wins over a still-visible exiting copy", () => {
  assert.equal(decide({ info: release, arguments: ["/Applications/Localbox.app/Contents/MacOS/Localbox", "--localbox-update-relaunch"], running: [4242] }), "updateRelaunch");
});

test("only ~/Applications and /Applications count as an Applications folder, through symlinks", () => {
  const home = temporary("lb-home-");
  mkdirSync(join(home, "Applications")); symlinkSync(join(home, "Applications"), join(home, "Apps"));
  assert.equal(inApplications("/Applications/Localbox.app", home), true);
  assert.equal(inApplications(join(home, "Applications/Localbox.app"), home), true);
  assert.equal(inApplications(join(home, "Apps/Localbox.app"), home), true);
  assert.equal(inApplications(join(home, "Downloads/Localbox.app"), home), false);
  assert.equal(inApplications("/Applications/Utilities/Localbox.app", home), false);
});
