// Offscreen shots of the popover and the Settings window (Bento's settings-view-shots pattern): LocalboxAppCore and
// LocalboxMenu are compiled as the modules they are, Shots.swift renders the real PopoverView in an NSHostingView from
// each shared facts fixture, and SettingsShots.swift the real SettingsView, light and dark, with no activation.
//
//   node apps/macos/App/tests/view-shots/view-shots.mjs [popover directory] [scale] [settings directory]
//
// The defaults are specs/menu-bar-app/evidence/13 at 2x for the popover and evidence/14 for Settings (at the
// window's own scale, 1x, as Bento's reference shots are).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const app = resolve(here, "../..");
const root = resolve(app, "../../..");
const output = resolve(process.argv[2] ?? join(root, "specs/menu-bar-app/evidence/13"));
const scale = process.argv[3] ?? "2";
const settings = resolve(process.argv[4] ?? join(root, "specs/menu-bar-app/evidence/14"));
const scratch = mkdtempSync("/tmp/lb-view-shots-");
const swift = (args) => {
  try { execFileSync("swiftc", ["-swift-version", "5", "-target", "arm64-apple-macosx14.0", "-parse-as-library", ...args], { stdio: "pipe", encoding: "utf8" }); }
  catch (error) { throw new Error(`swiftc failed:\n${error.stderr}`); }
};
const sources = (target) => readdirSync(join(app, "Sources", target)).filter((name) => name.endsWith(".swift")).map((name) => join(app, "Sources", target, name));
const library = (name, dependencies = []) => swift(["-module-name", name, "-emit-library", "-static", "-emit-module",
  "-emit-module-path", join(scratch, `${name}.swiftmodule`), "-I", scratch, ...sources(name), "-o", join(scratch, `lib${name}.a`), ...dependencies]);
try {
  library("LocalboxAppCore");
  library("LocalboxMenu");
  const shots = join(scratch, "shots");
  swift(["-I", scratch, "-L", scratch, "-lLocalboxMenu", "-lLocalboxAppCore", join(here, "Shots.swift"), join(here, "SettingsShots.swift"), "-o", shots]);
  execFileSync(shots, [join(app, "tests/fixtures/facts"), output, scale, settings], { stdio: "inherit", timeout: 180_000 });
  process.stdout.write(`${output}\n${settings}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
