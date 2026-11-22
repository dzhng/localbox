import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { compile, run, temporary } from "./driver.mjs";

// A fake bundle whose `cli/localbox` answers `app paths` as the real CLI does, or fails as the real CLI fails, so
// the app's half of the contract (decoding, the daemon's environment) runs against the CLI's half's shape.
const DRIVER = `
import Foundation
@main struct Driver {
  static func main() async {
    let bundle = URL(fileURLWithPath: CommandLine.arguments[1])
    let cli = BundledCLI(bundle: bundle, environment: ["PATH": "/usr/bin:/bin", "LOCALBOX_IPC_TOKEN": "inherited", "LOCALBOX_SANDBOX_BACKEND": "process-fixture"])
    do {
      let paths = try await AppPaths.load(cli)
      let launch = DaemonLaunch.make(bundle: bundle, paths: paths, environment: ["LOCALBOX_IPC_TOKEN": "inherited", "LOCALBOX_SANDBOX_BACKEND": "process-fixture"])
      let object: [String: Any] = ["executable": launch.executable.path, "arguments": launch.arguments, "log": launch.log.path, "environment": launch.environment,
                                   "connector": cli.connector(log: paths.log("connector.log")).arguments]
      print(String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self))
    } catch let failure as CLIFailure { print("failure \\(failure.code): \\(failure.message)") } catch { print("other \\(error)") }
  }
}
`;

let driver;
before(() => { driver = compile(DRIVER); });

/** A bundle whose CLI runs `script` (sh); `guestAgent` adds Resources/guest-agent. */
function bundle(script, guestAgent = false) {
  const app = join(temporary("lb-bundle-"), "Localbox Dev.app");
  mkdirSync(join(app, "Contents/Resources/cli"), { recursive: true });
  if (guestAgent) mkdirSync(join(app, "Contents/Resources/guest-agent"));
  writeFileSync(join(app, "Contents/Resources/cli/localbox"), `#!/bin/sh\n${script}\n`); chmodSync(join(app, "Contents/Resources/cli/localbox"), 0o755);
  return app;
}

const PATHS = { root: "/r", credentials: "/r/credentials.json", ipc_token: "/r/ipc-token", socket: "/r/agent.sock", hostd_lock: "/r/hostd.lock", app_socket: "/r/app.sock", sandboxes: "/r/sandboxes", operations: "/r/operations", images: "/r/images", logs: "/logs", bin_dir: "/home/.local/bin" };

test("the daemon runs supervised with every path app paths printed, this bundle's CLI and guest agent, and no inherited token", () => {
  const app = bundle(`[ "$*" = "app paths --json" ] || exit 9\ncat <<'EOF'\n${JSON.stringify(PATHS)}\nEOF`, true);
  const launch = JSON.parse(run(driver, [app]));
  assert.equal(launch.executable, join(app, "Contents/MacOS/localbox-hostd"));
  assert.deepEqual(launch.arguments, ["--supervised"]);
  assert.equal(launch.log, "/logs/hostd.log");
  assert.deepEqual(launch.connector, ["connector", "run"]);
  assert.deepEqual(launch.environment, {
    LOCALBOX_SANDBOX_BACKEND: "process-fixture",
    LOCALBOX_SOCKET: "/r/agent.sock", LOCALBOX_IPC_TOKEN_PATH: "/r/ipc-token", LOCALBOX_HOSTD_LOCK: "/r/hostd.lock",
    LOCALBOX_SANDBOXES: "/r/sandboxes", LOCALBOX_OPERATIONS: "/r/operations", LOCALBOX_IMAGES: "/r/images", LOCALBOX_BIN_DIR: "/home/.local/bin",
    LOCALBOX_CLI: join(app, "Contents/Resources/cli/localbox"), LOCALBOX_GUEST_AGENT: join(app, "Contents/Resources/guest-agent"),
  });
});

test("a bundle without a guest agent gives the daemon none", () => {
  const launch = JSON.parse(run(driver, [bundle(`echo '${JSON.stringify(PATHS)}'`)]));
  assert.equal(launch.environment.LOCALBOX_GUEST_AGENT, undefined);
});

test("a failing CLI becomes a typed failure: its envelope's code and message, else its stderr", () => {
  const envelope = { ok: false, release_id: "localbox-contract-v1", error: { code: "unauthorized", message: "this Mac is not signed in", retryable: false } };
  assert.equal(run(driver, [bundle(`echo '${JSON.stringify(envelope)}'; echo 'unauthorized: this Mac is not signed in' >&2; exit 2`)]), "failure unauthorized: this Mac is not signed in");
  assert.equal(run(driver, [bundle(`echo 'EACCES: permission denied, mkdir /r' >&2; exit 1`)]), "failure cli_failed: EACCES: permission denied, mkdir /r");
  assert.equal(run(driver, [bundle(`exit 3`)]), "failure cli_failed: the localbox command exited 3");
});
