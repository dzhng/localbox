// Bento's pattern for the app's tests: a small Swift driver compiled together with the production sources of
// LocalboxAppCore, run as a process in a scratch directory, so each check runs the real code with real children.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after } from "node:test";

const core = new URL("../Sources/LocalboxAppCore/", import.meta.url).pathname;
const scratch = [];
after(() => { for (const directory of scratch) rmSync(directory, { recursive: true, force: true }); });

/** A scratch directory, removed when the test file ends. Under /tmp so paths stay short. */
export function temporary(prefix = "lb-app-") {
  const directory = mkdtempSync(join("/tmp", prefix));
  scratch.push(directory);
  return directory;
}

/** Compiles `main` (a Swift file with an `@main` type) against every LocalboxAppCore source; returns the executable. */
export function compile(main, directory = temporary()) {
  const driver = join(directory, "Driver.swift");
  writeFileSync(driver, main);
  const sources = readdirSync(core).filter((name) => name.endsWith(".swift")).map((name) => join(core, name));
  const executable = join(directory, "driver");
  try { execFileSync("swiftc", ["-swift-version", "5", "-parse-as-library", ...sources, driver, "-o", executable], { stdio: "pipe", encoding: "utf8" }); }
  catch (error) { throw new Error(`the driver did not compile:\n${error.stderr}`); }
  return executable;
}

/** Runs a compiled driver; its stdout, trimmed. */
export function run(executable, args = [], timeout = 60_000) {
  return execFileSync(executable, args, { encoding: "utf8", timeout }).trim();
}

/** `value` as a Swift string literal. */
export const swiftString = (value) => JSON.stringify(value);
