import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the guest agent as one self-contained executable per guest OS, so no image depends on a runtime of its own.
 * `bun build --compile` bundles the agent with Bun's runtime and cross-compiles both targets from one Mac. Beside them,
 * `darwin/` holds everything else a macOS image build installs (`install.sh`, the launchd units, and the native
 * `localbox-desktop` helper and `localbox-vsock` forwarder), so the host app ships all of it.
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

/**
 * The agent embeds its own version (it announces it in its ready frame), and the version names a digest of the
 * binaries, so the build runs twice: once with no version, whose digests make the version, then with that version
 * embedded. The same sources give the same first pass, so the version still changes exactly when the agent does;
 * `sha256` names the binaries that ship.
 */
export async function buildGuestAgent(outDir = join(root, "dist/guest-agent"), releaseVersion?: string): Promise<AgentVersion> {
  const found = bunVersion();
  if (found !== BUN_VERSION) throw new Error(`the guest agent builds with bun ${BUN_VERSION} (found ${found ?? "none"}): curl -fsSL https://bun.sh/install | bash -s bun-v${BUN_VERSION}`);
  const release = releaseVersion ?? (JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string }).version;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const unversioned = await compileAll(outDir, "");
  const digest = createHash("sha256").update(`linux:${unversioned.linux}\ndarwin:${unversioned.darwin}\n`).digest("hex").slice(0, 12);
  const version = `${release}+${digest}`;
  const agentVersion: AgentVersion = { version, sha256: await compileAll(outDir, version) };
  await writeFile(join(outDir, "agent-version.json"), `${JSON.stringify(agentVersion, null, 2)}\n`);
  await writeDarwinFiles(join(outDir, "darwin"));
  return agentVersion;
}

/** The native darwin tools, built from the host daemon's package for the guest (same arm64 macOS). */
export const DARWIN_TOOLS = ["localbox-desktop", "localbox-vsock"] as const;

/** `darwin/`: `install.sh` and the units from `apps/guest-agent/darwin`, and release builds of the native tools. */
async function writeDarwinFiles(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const units = join(root, "apps/guest-agent/darwin");
  for (const name of await readdir(units)) await copyFile(join(units, name), join(outDir, name));
  const swift = (args: string[]) => spawnSync("swift", [...args, "--package-path", "apps/macos/HostDaemon", "-c", "release"], { cwd: root, encoding: "utf8" });
  for (const tool of DARWIN_TOOLS) {
    const build = swift(["build", "--product", tool]);
    if (build.status !== 0) throw new Error(`swift build of ${tool} failed:\n${build.stdout}${build.stderr}`);
  }
  const bin = swift(["build", "--show-bin-path"]).stdout.trim();
  for (const tool of DARWIN_TOOLS) await copyFile(join(bin, tool), join(outDir, tool));
}

/** Compiles both targets into `outDir` with `version` embedded; returns their digests. */
async function compileAll(outDir: string, version: string): Promise<Record<AgentOS, string>> {
  const sha256 = {} as Record<AgentOS, string>;
  for (const os of Object.keys(AGENT_TARGETS) as AgentOS[]) {
    const outfile = join(outDir, agentBinaryName(os));
    // A standalone Bun executable otherwise loads .env and bunfig.toml from its working directory, which would leak
    // into the agent's environment and every command it runs.
    const build = spawnSync("bun", ["build", "apps/guest-agent/src/index.ts", "--compile", `--target=${AGENT_TARGETS[os]}`,
      "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--define", `LOCALBOX_AGENT_VERSION=${JSON.stringify(version)}`,
      "--outfile", outfile], { cwd: root, encoding: "utf8" });
    if (build.status !== 0) throw new Error(`bun build for ${os} failed:\n${build.stdout}${build.stderr}`);
    sha256[os] = createHash("sha256").update(await readFile(outfile)).digest("hex");
  }
  return sha256;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf("--release-version");
  const releaseVersion = flag >= 0 ? process.argv[flag + 1] : undefined;
  buildGuestAgent(undefined, releaseVersion).then((built) => console.log(JSON.stringify(built)), (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
