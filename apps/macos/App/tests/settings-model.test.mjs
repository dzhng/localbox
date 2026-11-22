import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, run } from "./driver.mjs";

// `SettingsModel` over fake actions and the shared facts fixtures: the words its rows show for each state, which
// controls appear, the app's own preference, and the account flow's edges (signing in from the terminal, a second
// tap while a command runs). The CLI side of each control is settings-cli.test.mjs.
const FIXTURES = new URL("./fixtures/facts/", import.meta.url).pathname;

const DRIVER = `
import Foundation
final class Calls: @unchecked Sendable { private let lock = NSLock(); private var list: [String] = []
  func add(_ call: String) { lock.withLock { list.append(call) } }; var all: [String] { lock.withLock { list } } }
struct Fake: SettingsActions {
  let calls: Calls; let current: @Sendable () -> AppFacts; var delay: Double = 0
  func facts() async throws -> AppFacts { current() }
  func sendCode(email: String) async throws -> LoginStep { calls.add("send \\(email)"); try await Task.sleep(nanoseconds: UInt64(delay * 1e9)); return .codeSent(email: email) }
  func signIn(email: String, code: String) async throws -> LoginStep { calls.add("sign-in \\(email) \\(code)"); return .signedIn(email: email, machineName: "studio") }
  func signOut() async throws { calls.add("sign-out") }
  func setAgentSetup(_ enabled: Bool) async throws { calls.add("agents \\(enabled)") }
  func setOpenAtLogin(_ enabled: Bool) async throws { calls.add("login-item \\(enabled)") }
  func setAutomaticUpdates(_ enabled: Bool) async throws { calls.add("automatic \\(enabled)") }
  func checkForUpdates() async throws { calls.add("check") }
}
func facts(_ dir: String, _ name: String, _ change: (inout [String: Any]) -> Void = { _ in }) -> AppFacts {
  var object = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: dir).appendingPathComponent("\\(name).json"))) as! [String: Any]
  change(&object)
  return try! AppFacts.decode(try! JSONSerialization.data(withJSONObject: object))
}
final class Box: @unchecked Sendable { var facts: AppFacts; init(_ facts: AppFacts) { self.facts = facts } }
@main struct Driver {
  @MainActor static func main() async {
    let dir = CommandLine.arguments[1]
    var out: [String: Any] = [:]
    var summaries: [String: String] = [:]
    for command in ["installed", "missing", "different", "not_in_applications", "not_app_managed", "odd"] {
      for skill in ["installed", "updating", "needs_attention", "missing", "disabled", "unmanaged"] {
        summaries["\\(command)/\\(skill)"] = SettingsModel.agentSummary(.init(enabled: true, command: command, skill: skill))
      }
    }
    out["summaries"] = summaries
    var items: [String: Any] = [:]
    for state in ["enabled", "disabled", "requires_approval", "not_found"] {
      let model = SettingsModel(actions: Fake(calls: Calls(), current: { facts(dir, "idle") { $0["open_at_login"] = state } }), showAtLaunch: false, remember: { _ in })
      await model.refresh()
      items[state] = ["description": model.loginItemDescription, "on": model.openAtLogin, "pane": model.needsLoginItemsSettings]
    }
    out["login_items"] = items

    // Updates: the manual line until the facts say this build updates itself.
    let calls = Calls()
    let box = Box(facts(dir, "idle"))
    let model = SettingsModel(actions: Fake(calls: calls, current: { box.facts }), showAtLaunch: false, remember: { calls.add("remember \\($0)") })
    var log: [String] = []
    log.append("loading \\(model.account) \\(model.updates == nil)")
    await model.refresh()
    await model.checkForUpdates(); await model.setAutomaticUpdates(true)
    log.append("manual \\(model.updates == nil)")
    box.facts = facts(dir, "idle") { $0["update"] = ["available": true, "enabled": false, "can_check": true] }
    await model.refresh()
    await model.checkForUpdates(); await model.setAutomaticUpdates(true); await model.setAutomaticUpdates(false)
    log.append("updates \\(model.updates?.enabled == false)")
    // The app's own preference: off by default, remembered when changed.
    model.showAtLaunch = true; model.showAtLaunch = true; model.showAtLaunch = false
    // A switch already where it is asked to be runs nothing.
    await model.setAgentSetup(true); await model.setOpenAtLogin(true)

    // Signed out, a code sent, then signed in from the terminal: the facts end the code flow.
    box.facts = facts(dir, "signed-out")
    await model.refresh()
    log.append("signed out \\(model.account) \\(model.canSendCode)")
    model.email = "   "
    await model.sendCode()
    model.email = "dev@example.com"
    await model.sendCode()
    log.append("sent \\(model.account) \\(model.canSignIn)")
    model.code = "123456"
    box.facts = facts(dir, "idle")
    model.factsChanged(box.facts)
    log.append("terminal \\(model.account) code=\\(model.code)")

    // A second tap while a code is being sent is ignored.
    let slow = SettingsModel(actions: Fake(calls: calls, current: { facts(dir, "signed-out") }, delay: 0.3), showAtLaunch: true, remember: { _ in })
    await slow.refresh()
    slow.email = "slow@example.com"
    async let first: Void = slow.sendCode()
    try? await Task.sleep(nanoseconds: 50_000_000)
    log.append("busy \\(slow.busy.map { "\\($0)" } ?? "none") \\(slow.canSendCode)")
    await slow.sendCode()
    await first
    log.append("after \\(slow.account) \\(slow.showAtLaunch)")
    out["log"] = log
    out["calls"] = calls.all
    print(String(decoding: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), as: UTF8.self))
  }
}
`;

let out;
before(() => { out = JSON.parse(run(compile(DRIVER), [FIXTURES])); });

test("the Set up my agents line: the all-good sentence, else the command's state and the skill's", () => {
  const s = out.summaries;
  assert.equal(s["installed/installed"], "localbox command + skill, kept current. All good ✓");
  assert.equal(s["missing/installed"], "Command not installed; skill installed.");
  assert.equal(s["installed/updating"], "Command installed; skill updating.");
  assert.equal(s["different/needs_attention"], "A different command is at ~/.local/bin/localbox; skill needs attention.");
  assert.equal(s["not_in_applications/installed"], "Command waits for Localbox to be in Applications; skill installed.");
  assert.equal(s["not_app_managed/disabled"], "Command unavailable in this build; skill not installed.");
  assert.equal(s["odd/unmanaged"], "Command needs attention; skill not installed.");
  for (const line of Object.values(s)) assert.doesNotMatch(line, /_/, "no raw state word");
});

test("Open at login: four lines; on while awaiting approval; the pane only when macOS needs it", () => {
  assert.deepEqual(out.login_items, {
    enabled: { description: "Localbox opens when you log in.", on: true, pane: false },
    disabled: { description: "Localbox does not open when you log in.", on: false, pane: false },
    requires_approval: { description: "Waiting for your approval in Login Items settings.", on: true, pane: true },
    not_found: { description: "macOS does not recognise this copy of Localbox as a login item.", on: false, pane: true },
  });
});

test("updates are the manual line until the facts carry them; then the toggle and the button run their commands", () => {
  assert.deepEqual(out.log.slice(0, 3), ["loading loading true", "manual true", "updates true"]);
  const calls = out.calls;
  assert.deepEqual(calls.slice(0, 3), ["check", "automatic true", "remember true"], "nothing ran while updates were manual; then check and on (off was already off)");
});

test("the window-at-launch preference is remembered once per change; a switch already in place runs nothing", () => {
  assert.deepEqual(out.calls.filter((call) => call.startsWith("remember")), ["remember true", "remember false"]);
  assert.ok(!out.calls.some((call) => call.startsWith("agents") || call.startsWith("login-item")), JSON.stringify(out.calls));
});

test("account: a blank email sends nothing; a sign-in from the terminal ends the code flow; a second tap while busy is ignored", () => {
  assert.deepEqual(out.log.slice(3), [
    "signed out signedOut false",
    'sent codeSent(email: "dev@example.com") false',  // Sign In waits for a code to be typed
    'terminal signedIn(email: Optional("dev@example.com"), machineName: "studio") code=',
    "busy sendingCode false",
    'after codeSent(email: "slow@example.com") true',
  ]);
  assert.deepEqual(out.calls.filter((call) => call.startsWith("send")), ["send dev@example.com", "send slow@example.com"]);
});
