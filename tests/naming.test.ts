import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Localbox ships under one set of names: bundle ids under `sh.localbox`, no launchd job of its own, no versioned
// release folders, and no other product's names (specs/menu-bar-app, slice 16). Shipped sources are every tracked file
// under apps, packages, scripts, skills, bin and api, plus the root docs; specs/ is the record and is not scanned.

const ROOT = new URL("..", import.meta.url).pathname;
const SCANNED = ["apps", "packages", "scripts", "skills", "bin", "api", "README.md", "DEVELOPMENT.md", "SECURITY.md", "positioning.md"];
const FORBIDDEN = ["org.localbox", "com.localbox", "ing.bento", "Bento", "launchctl", "releases/active"];

/** The only places a forbidden name may appear: each names its file, its term, the line it must be on, and why. */
const ALLOWED: { file: RegExp; term: string; line: RegExp; why: string }[] = [
  { file: /^apps\/guest-agent\/darwin\//, term: "launchctl", line: /./, why: "the darwin guest agent's own launchd units, inside a macOS sandbox" },
  { file: /^apps\/macos\/HostDaemon\/(Sources\/HostDaemonCore\/MacBaseBuilder|Sources\/localbox-vmlab\/MacGuestLab|Tests\/HostDaemonCoreTests\/MacBaseBuilderTests)\.swift$/, term: "launchctl", line: /./, why: "commands run inside a macOS guest while building or testing it" },
  { file: /^apps\/cli\/src\/app-launch\.ts$/, term: "launchctl", line: /launchctl.*asuser|asuser.*launchctl/, why: "the documented launch command, `launchctl asuser … open -g`: no job" },
  { file: /^skills\/localbox\/references\/installation\.md$/, term: "launchctl", line: /launchctl asuser "\$\(id -u\)" \/usr\/bin\/open -g/, why: "the same launch command, as the procedure runs it" },
  { file: /^scripts\/proof\/probes\/41-app-lifetime\.ts$/, term: "launchctl", line: /execFileSync\("launchctl", \["list"\]/, why: "probe 41 checks that no launchd job exists" },
];

function shippedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", ...SCANNED], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
}

test("shipped sources carry no other product's names, no launchd job and no release folders", () => {
  const used = new Set<number>();
  const hits: string[] = [];
  for (const file of shippedFiles()) {
    const bytes = readFileSync(join(ROOT, file));
    if (bytes.includes(0)) continue;
    bytes.toString("utf8").split("\n").forEach((line, index) => {
      for (const term of FORBIDDEN) {
        if (!line.includes(term)) continue;
        const rule = ALLOWED.findIndex((allowed) => allowed.term === term && allowed.file.test(file) && allowed.line.test(line));
        if (rule >= 0) used.add(rule);
        else hits.push(`${file}:${index + 1}: ${term}: ${line.trim().slice(0, 160)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `forbidden names in shipped sources:\n${hits.join("\n")}`);
  const stale = ALLOWED.filter((_, index) => !used.has(index)).map((allowed) => `${allowed.file} (${allowed.why})`);
  assert.deepEqual(stale, [], "an allow-list entry no longer matches anything; delete it");
});
