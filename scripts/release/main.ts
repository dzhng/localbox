// Cuts a Localbox release, in stages that each stand alone. DEVELOPMENT.md ("Releasing") is the runbook.
//
//   npm run release -- validate            refuse unless everything a release needs is true
//   npm run release -- test                the gates a release must pass
//   npm run release -- build               build dist/release and verify it
//   npm run release -- smoke               install the build from a local server into a scratch HOME and run it
//   npm run release -- publish             a DRAFT GitHub release with every file, each downloaded back and compared
//   npm run release -- publish --confirm   make the draft public, then check what installs and updates see
//   npm run release -- all                 validate, test, build, smoke and publish, stopping at the draft
//
// --rehearsal   from any branch or tree, with scratch credentials (LOCALBOX_SIGNING_DIR, LOCALBOX_RELEASE_PUBLIC_KEY) and
//               --version V; never publishes
// --dry-run     publish prints the assets and the GitHub calls it would make, and calls nothing
// --out DIR     the build folder (default dist/release; its receipt is DIR.build.json)
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.js";
import { parseFlags, releaseConfig, type Flags, type ReleaseConfig } from "./config.js";
import { step } from "./process.js";
import { publish } from "./publish.js";
import { smoke } from "./smoke.js";
import { ALL_GROUPS, BUILD_GROUPS, PUBLISH_GROUPS, RefusedError, validate } from "./validate.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STAGES = ["validate", "test", "build", "smoke", "publish", "all"] as const;
type Stage = (typeof STAGES)[number];

/** The command for a stage, carrying this run's mode, so "next" is copyable as printed. */
const command = (flags: Flags, stage: string, extra = "") => `npm run release -- ${stage}${flags.rehearsal ? ` --rehearsal${flags.version ? ` --version ${flags.version}` : ""}` : ""}${flags.out ? ` --out ${flags.out}` : ""}${extra}`;

function heading(stage: string, config: ReleaseConfig) {
  console.log(`\n== ${stage}: Localbox ${config.version}${config.rehearsal ? " (rehearsal)" : ""} ==`);
}

function finish(stage: string, done: string[], next: string) {
  for (const line of done) console.log(`  ok  ${line}`);
  console.log(`\n${stage} passed. Next: ${next}`);
}

/**
 * The gates a release must pass, the same ones a change must pass, plus the release probes at tier a: the build as a
 * release is cut, its installation, the image fetch, and an N to N+1 update.
 */
async function test(config: ReleaseConfig): Promise<string[]> {
  const generated = ["snapshots/catalog.json", "snapshots/help.json", "apps/macos/HostDaemon/Sources/HostDaemonCore/GeneratedOperations.swift"];
  const digest = () => generated.map((file) => createHash("sha256").update(readFileSync(join(config.root, file))).digest("hex")).join();
  const gates: Array<[string, string[]]> = [
    ["npm", ["run", "build"]], ["npm", ["test"]],
    ["swift", ["build", "--package-path", "apps/macos/App"]], ["npm", ["run", "test:app"]],
    ["swift", ["test", "--package-path", "apps/macos/HostDaemon"]],
  ];
  const done: string[] = [];
  for (const [executable, args] of gates) { await step(executable, args, { cwd: config.root }); done.push(`${executable} ${args.join(" ")}`); }
  const before = digest();
  await step("npm", ["run", "-s", "generate:snapshots"], { cwd: config.root });
  if (digest() !== before) throw new Error(`the contract snapshots are stale: commit what npm run generate:snapshots just wrote (${generated.join(", ")})`);
  done.push("the contract snapshots are what the code generates");
  for (const probe of ["42", "43", "44"]) { await step("npm", ["run", "-s", "proof", "--", probe, "--tier", "a"], { cwd: config.root }); done.push(`proof ${probe} at tier a`); }
  return done;
}

async function runStage(stage: Stage, flags: Flags, config: ReleaseConfig): Promise<void> {
  switch (stage) {
    case "validate":
      heading("validate", config);
      validate(config, ALL_GROUPS);
      return finish("validate", [], command(flags, "test"));
    case "test":
      heading("test", config);
      return finish("test", await test(config), command(flags, "build"));
    case "build": {
      heading("build", config);
      validate(config, BUILD_GROUPS);
      const receipt = await build(config);
      const bytes = receipt.assets.reduce((total, asset) => total + asset.size, 0);
      return finish("build", [`${config.out}: ${(bytes / 1024 ** 2).toFixed(1)} MiB from ${receipt.commit.slice(0, 7)}`], command(flags, "smoke"));
    }
    case "smoke":
      heading("smoke", config);
      return finish("smoke", await smoke(config), command(flags, "publish", flags.rehearsal ? " --dry-run" : ""));
    case "publish": {
      heading(flags.confirm ? "publish --confirm" : flags.dryRun ? "publish --dry-run" : "publish", config);
      if (!flags.dryRun) validate(config, PUBLISH_GROUPS);
      const { done, next } = await publish(config, { confirm: flags.confirm, dryRun: flags.dryRun || config.rehearsal });
      return finish("publish", done, next);
    }
    case "all":
      for (const each of ["validate", "test", "build", "smoke", "publish"] as const) await runStage(each, { ...flags, confirm: false }, config);
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help || !flags.stage) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\nimport ")[0].replace(/^\/\/ ?/gm, "") + "\n");
    process.exitCode = flags.help ? 0 : 2;
    return;
  }
  if (!(STAGES as readonly string[]).includes(flags.stage)) throw new Error(`unknown stage ${flags.stage}: one of ${STAGES.join(", ")}`);
  if (flags.confirm && flags.stage !== "publish") throw new Error("--confirm belongs to publish: npm run release -- publish --confirm");
  if (!existsSync(join(root, "package.json"))) throw new Error(`no checkout at ${root}`);
  await runStage(flags.stage as Stage, flags, releaseConfig(root, flags));
}

main().catch((error) => {
  if (!(error instanceof RefusedError)) console.error(`\nStopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
