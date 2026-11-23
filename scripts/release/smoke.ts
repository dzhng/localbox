import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { installationSteps, runSteps, serveRelease, trusting } from "../proof/lib/installation.js";
import { packagedApp } from "../proof/lib/packaged-app.js";
import { sha256, type ReleaseManifest } from "../release.js";
import { readReceipt } from "./build.js";
import { BUNDLE_ID, type ReleaseConfig } from "./config.js";
import { capture } from "./process.js";

const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `smoke`: the built release, installed and run the way a user's agent gets it. The folder is served on 127.0.0.1 as
 * `releases/latest/download` serves it; the installation procedure's own blocks download, verify (against the pinned key,
 * or the rehearsal's) and place the app into a scratch HOME; the installed app is launched with `open -g`, a scratch
 * machine root and the real daemon, and must start its children, answer `app status` as this release, and fetch and
 * expand the linux image from this release, checked against the key it pins; then it is quit.
 *
 * The bundle keeps its real id, `sh.localbox.mac`, because the artifact that ships is what is proven, so three things
 * a scratch HOME cannot isolate are handled here: a running Localbox is refused (a second copy would hand off to it and
 * exit); the app runs from a copy outside every Applications folder, because a release ignores the fake login item and
 * registers its real one only from an Applications folder; and the `sh.localbox.mac` defaults and the ~/Library
 * folders the run creates are put back as they were.
 */
export async function smoke(config: ReleaseConfig): Promise<string[]> {
  const receipt = await readReceipt(config);
  const publicKey = readFileSync(config.publicKey, "utf8");
  const checked = [`${config.out} holds the ${receipt.assets.length} files the build stage verified`];
  const manifest = JSON.parse(readFileSync(join(config.out, "release.json"), "utf8")) as ReleaseManifest;
  if (capture("lsappinfo", ["find", `bundleid=${BUNDLE_ID}`]).stdout.trim()) {
    throw new Error(`Quit Localbox first (osascript -e 'quit app id "${BUNDLE_ID}"'): the smoke runs the release under its real bundle id, and a second copy hands off to the running one`);
  }

  const restore = accountState();
  const exec = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd ?? config.root, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  const app = packagedApp({ root: config.root, keep: false, exec }, { probe: "smoke", backend: "apple" });
  const server = await serveRelease(config.out);
  try {
    const temporary = join(app.scratch, "tmp");
    mkdirSync(temporary);
    const steps = installationSteps(config.root);
    // A real release is checked against the procedure's own pinned key, exactly as printed; a rehearsal against its scratch key.
    const verifyStep = config.publicKeyOverridden ? trusting(steps.get(3)!, publicKey) : steps.get(3)!;
    const installed = await runSteps([steps.get(2)!, verifyStep, steps.get(4)!], { PATH: FINDER_PATH, HOME: app.home, TMPDIR: temporary, LOCALBOX_RELEASE_URL: server.url });
    assert.equal(installed.code, 0, `the installation procedure failed:\n${installed.output}`);
    assert.match(installed.output, new RegExp(`Localbox ${receipt.version.replaceAll(".", "\\.")}: release\\.json is signed by the pinned key`));
    checked.push(`the installation procedure (steps 2 to 4) downloads ${receipt.version} from a local server, verifies it ${config.publicKeyOverridden ? "against the rehearsal's key" : "against the pinned key"} and installs it into a scratch HOME`);

    const launched = join(app.scratch, "launch", "Localbox.app");
    mkdirSync(join(app.scratch, "launch"));
    capture("ditto", [join(app.home, "Applications/Localbox.app"), launched]);
    app.adopt(launched);
    await app.start({ LOCALBOX_RELEASE_URL: server.url, LOCALBOX_SKILL_HOME: app.home, LOCALBOX_APP: launched }, 120_000);
    const status = await app.cli(["app", "status"]);
    assert.equal(status.version, receipt.version, JSON.stringify(status));
    assert.equal(status.build, "release", JSON.stringify(status));
    assert.ok(status.update?.available, `the release cannot update itself: ${JSON.stringify(status.update)}`);
    await app.until(async () => (await app.cli(["app", "status"])).daemon === "running", "the daemon to run", 60_000);
    assert.match(app.log("app.log"), /not in an Applications folder, so no login item yet/, "the smoke registered no login item");
    checked.push(`launched with open -g, never frontmost: app status is release ${receipt.version} with its daemon running and its updater on`);

    const expected = manifest.image!;
    let progress: { phase?: string; error?: string } = {};
    for (const deadline = Date.now() + 60 * 60_000; Date.now() < deadline; await sleep(1_000)) {
      try { progress = JSON.parse(readFileSync(app.paths.builtinImage, "utf8")); } catch { /* not yet */ }
      if (progress.phase === "ready" || progress.phase === "failed") break;
    }
    assert.equal(progress.phase, "ready", `the app's image fetch ended ${JSON.stringify(progress)}; ${app.log("image.log").slice(-1500)}`);
    assert.equal(await sha256(join(app.paths.images, "linux/disk.img")), expected.sha256, "the expanded image is the signed one");
    checked.push(`the app fetched this release's linux image (${expected.parts.length} part${expected.parts.length === 1 ? "" : "s"}) from the local server and expanded it to the signed digest`);

    const stopped = await app.stop(() => undefined);
    checked.push(`quit on SIGTERM (the Quit item's path): the daemon gone after ${stopped.daemonGoneAt} ms, the app after ${stopped.appGoneAt} ms`);
    return checked;
  } finally {
    server.close();
    await app.cleanup();
    restore();
  }
}

/**
 * What a run of the real bundle id leaves in this account outside the scratch HOME (Sparkle and the launcher resolve
 * the account's real home): the `sh.localbox.mac` defaults and the ~/Library folders named for it. Returns the function
 * that puts them back: the defaults as they were, and folders that did not exist before removed.
 */
function accountState(): () => void {
  const account = userInfo().homedir || homedir();
  // `defaults delete` leaves an empty plist behind, so the file goes too when there was none.
  const paths = [...["Caches", "HTTPStorages", "WebKit"].map((folder) => join(account, "Library", folder, BUNDLE_ID)),
    join(account, "Library/Saved Application State", `${BUNDLE_ID}.savedState`), join(account, "Library/Preferences", `${BUNDLE_ID}.plist`)];
  const existed = new Set(paths.filter((path) => existsSync(path)));
  const hadDefaults = capture("defaults", ["read", BUNDLE_ID]).code === 0;
  const exported = capture("defaults", ["export", BUNDLE_ID, "-"]);
  return () => {
    if (hadDefaults && exported.code === 0) {
      const file = join(account, "Library", "Caches", `.${BUNDLE_ID}.smoke-defaults.plist`);
      writeFileSync(file, exported.stdout);
      capture("defaults", ["import", BUNDLE_ID, file]);
      rmSync(file, { force: true });
    } else capture("defaults", ["delete", BUNDLE_ID]);
    for (const path of paths) if (!existed.has(path)) rmSync(path, { recursive: true, force: true });
  };
}
