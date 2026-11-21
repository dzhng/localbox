import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the guest agent as one self-contained executable per guest OS, so no image depends on a runtime of its own.
 * `bun build --compile` bundles the agent with Bun's runtime and cross-compiles both targets from one Mac.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The compiler is pinned: the same sources and Bun version give byte-identical binaries, so a digest names a build. */
export const BUN_VERSION = "1.4.4";
export const AGENT_TARGETS = { linux: "bun-linux-arm64", darwin: "bun-darwin-arm64" } as const;
export type AgentOS = keyof typeof AGENT_TARGETS;
export const agentBinaryName = (os: AgentOS) => `localbox-agent-${os}-arm64`;

/** `version` is the release version plus a digest of both binaries, so any change to either is a new version. */
export interface AgentVersion { version: string; sha256: Record<AgentOS, string> }

export function bunVersion(): string | undefined {
  const result = spawnSync("bun", ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export async function buildGuestAgent(outDir = join(root, "dist/guest-agent"), releaseVersion?: string): Promise<AgentVersion> {
  const found = bunVersion();
  if (found !== BUN_VERSION) throw new Error(`the guest agent builds with bun ${BUN_VERSION} (found ${found ?? "none"}): curl -fsSL https://bun.sh/install | bash -s bun-v${BUN_VERSION}`);
  const version = releaseVersion ?? (JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string }).version;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const sha256 = {} as Record<AgentOS, string>;
  for (const os of Object.keys(AGENT_TARGETS) as AgentOS[]) {
    const outfile = join(outDir, agentBinaryName(os));
    // A standalone Bun executable otherwise loads .env and bunfig.toml from its working directory, which would leak
    // into the agent's environment and every command it runs.
    const build = spawnSync("bun", ["build", "apps/guest-agent/src/index.ts", "--compile", `--target=${AGENT_TARGETS[os]}`,
      "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", outfile], { cwd: root, encoding: "utf8" });
    if (build.status !== 0) throw new Error(`bun build for ${os} failed:\n${build.stdout}${build.stderr}`);
    sha256[os] = createHash("sha256").update(await readFile(outfile)).digest("hex");
  }
  const digest = createHash("sha256").update(`linux:${sha256.linux}\ndarwin:${sha256.darwin}\n`).digest("hex").slice(0, 12);
  const agentVersion: AgentVersion = { version: `${version}+${digest}`, sha256 };
  await writeFile(join(outDir, "agent-version.json"), `${JSON.stringify(agentVersion, null, 2)}\n`);
  return agentVersion;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf("--release-version");
  const releaseVersion = flag >= 0 ? process.argv[flag + 1] : undefined;
  buildGuestAgent(undefined, releaseVersion).then((built) => console.log(JSON.stringify(built)), (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
