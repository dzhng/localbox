import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { compile, run, temporary } from "./driver.mjs";

// The real `SettingsModel` over the real `CLISettingsActions` and `BundledCLI`, against a
// fake bundle whose `cli/localbox` logs every invocation and answers as the CLI does: `app status` prints the facts
// file; `login --code`, `logout`, `app login-item` and `agents setup` change it; a line in `refuse` makes that exact
// invocation fail the way the CLI does (a sentence on stderr, exit 1). Each control must issue exactly its command,
// then re-read the facts, and a refusal must show its message and keep what was typed.
const FIXTURES = new URL("./fixtures/facts/", import.meta.url).pathname;

const DRIVER = `
import Foundation
@MainActor func state(_ model: SettingsModel, _ label: String) {
  let object: [String: Any] = ["step": label, "account": "\\(model.account)", "email": model.email, "code": model.code,
    "failure": model.accountFailure ?? NSNull(), "login_failure": model.loginFailure ?? NSNull(), "agent_failure": model.agentSetupFailure ?? NSNull(),
    "open_at_login": model.openAtLogin, "set_up_agents": model.setUpAgents, "busy": model.busy.map { "\\($0)" } ?? NSNull()]
  print(String(decoding: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self))
  print("--- \\(label)")
}
@main struct Driver {
  @MainActor static func main() async {
    let cli = BundledCLI(bundle: URL(fileURLWithPath: CommandLine.arguments[1]), environment: ["PATH": "/usr/bin:/bin"])
    let model = SettingsModel(actions: CLISettingsActions(cli: cli), showAtLaunch: false, remember: { _ in })
    await model.refresh(); state(model, "opened")
    model.email = "  wrong@example.com "; await model.sendCode(); state(model, "send refused")
    model.email = "dev@example.com"; await model.sendCode(); state(model, "code sent")
    model.code = "000000"; await model.signIn(); state(model, "code refused")
    model.useDifferentEmail(); state(model, "different email")
    await model.sendCode(); model.code = " 123456 "; await model.signIn(); state(model, "signed in")
    await model.setAgentSetup(false); state(model, "agents off")
    await model.setOpenAtLogin(false); state(model, "login item refused")
    await model.setOpenAtLogin(false); state(model, "login item off")
    await model.signOut(); state(model, "signed out")
  }
}
`;

const CLI = `#!/bin/sh
here="$(cd "$(dirname "$0")" && pwd)"
echo "$*" >> "$here/log"
if grep -qxF -- "$*" "$here/refuse" 2>/dev/null; then
  case "$*" in
    login*--code*) echo "verification code is invalid or expired" >&2 ;;
    *) echo "email is invalid" >&2 ;;
  esac
  exit 1
fi
# The app's refusal comes back as the CLI's failure envelope, once.
if [ "$*" = "app login-item off --json" ] && [ -f "$here/refuse-login-item" ]; then
  rm "$here/refuse-login-item"
  echo '{"ok":false,"error":{"code":"internal","message":"the login item could not be removed: Operation not permitted","retryable":false}}'
  exit 1
fi
case "$*" in
  "app status --json") cat "$here/facts.json" ;;
  login*--code*) cp "$here/signed-in.json" "$here/facts.json"; echo '{"account_name":"dev","machine_name":"studio","machine_count":1}' ;;
  login*) echo "Code sent to $3. Ask the user for the 6-digit code, then run: localbox login --email $3 --code NNNNNN" ;;
  "logout --json") cp "$here/signed-out.json" "$here/facts.json"; echo '{"signed_out":true,"sandboxes_forgotten":true}' ;;
  "agents setup off --json") sed -i '' 's/"enabled": true/"enabled": false/' "$here/facts.json"; echo '{"ok":true,"result":{}}' ;;
  "app login-item off --json") sed -i '' 's/"open_at_login": "[a-z_]*"/"open_at_login": "disabled"/' "$here/facts.json"; echo '{"state":"disabled"}' ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`;

let steps, log;
before(() => {
  const app = join(temporary("lb-settings-"), "Localbox Dev.app");
  const cli = join(app, "Contents/Resources/cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "localbox"), CLI); chmodSync(join(cli, "localbox"), 0o755);
  copyFileSync(join(FIXTURES, "signed-out.json"), join(cli, "facts.json"));
  copyFileSync(join(FIXTURES, "signed-out.json"), join(cli, "signed-out.json"));
  copyFileSync(join(FIXTURES, "idle.json"), join(cli, "signed-in.json"));
  // The first refusal of each: a bad email, a wrong code, a login item macOS will not remove.
  writeFileSync(join(cli, "refuse"), ["login --email wrong@example.com --json", "login --email dev@example.com --code 000000 --json"].join("\n") + "\n");
  writeFileSync(join(cli, "refuse-login-item"), "");
  const output = run(compile(DRIVER), [app], 120_000);
  const raw = output.split("\n");
  steps = {};
  for (let index = 0; index < raw.length; index++) if (raw[index].startsWith("--- ")) steps[raw[index].slice(4)] = JSON.parse(raw[index - 1]);
  log = readFileSync(join(cli, "log"), "utf8").trim().split("\n");
});

test("each control runs exactly its command, then app status; nothing else is run", () => {
  assert.deepEqual(log, [
    "app status --json",
    "login --email wrong@example.com --json", "app status --json",
    "login --email dev@example.com --json", "app status --json",
    "login --email dev@example.com --code 000000 --json", "app status --json",
    "login --email dev@example.com --json", "app status --json",
    "login --email dev@example.com --code 123456 --json", "app status --json",
    "agents setup off --json", "app status --json",
    "app login-item off --json", "app status --json",
    "app login-item off --json", "app status --json",
    "logout --json", "app status --json",
  ]);
});

test("the three account states and their transitions; a refusal keeps the email or the code that was typed", () => {
  assert.equal(steps.opened.account, "signedOut");
  assert.deepEqual([steps["send refused"].account, steps["send refused"].failure, steps["send refused"].email], ["signedOut", "Email is invalid.", "  wrong@example.com "]);
  assert.deepEqual([steps["code sent"].account, steps["code sent"].failure], ['codeSent(email: "dev@example.com")', null]);
  assert.deepEqual([steps["code refused"].account, steps["code refused"].failure, steps["code refused"].code],
    ['codeSent(email: "dev@example.com")', "Verification code is invalid or expired.", "000000"]);
  assert.deepEqual([steps["different email"].account, steps["different email"].email, steps["different email"].code, steps["different email"].failure],
    ["signedOut", "dev@example.com", "", null]);
  assert.deepEqual([steps["signed in"].account, steps["signed in"].code, steps["signed in"].failure], ['signedIn(email: Optional("dev@example.com"), machineName: "studio")', "", null]);
  assert.equal(steps["signed out"].account, "signedOut");
  for (const step of Object.values(steps)) assert.equal(step.busy, null, "nothing is left busy");
});

test("the switches follow the facts the CLI reports after each change", () => {
  assert.equal(steps["signed in"].set_up_agents, true);
  assert.deepEqual([steps["agents off"].set_up_agents, steps["agents off"].agent_failure], [false, null]);
  assert.equal(steps["signed in"].open_at_login, true);
  assert.deepEqual([steps["login item refused"].open_at_login, steps["login item refused"].login_failure],
    [true, "The login item could not be removed: Operation not permitted."], "a refusal shows the app's message and the switch stays where the facts say");
  assert.deepEqual([steps["login item off"].open_at_login, steps["login item off"].login_failure], [false, null]);
});
