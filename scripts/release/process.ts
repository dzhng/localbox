import { spawn, spawnSync } from "node:child_process";

export interface Captured { code: number; stdout: string; stderr: string }

/** Runs a short command to completion and returns what it printed; a missing executable is exit 127. */
export function capture(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Captured {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, input: options.input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) return { code: 127, stdout: "", stderr: result.error.message };
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** An argv as a shell command line someone can paste. */
export const commandLine = (argv: string[]): string => argv.map((part) => /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`).join(" ");

/**
 * Runs one step of a stage with its output on this terminal, printing the command first; a failure throws, naming the
 * command. Async, so a server this process runs keeps answering meanwhile.
 */
export async function step(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  console.log(`$ ${commandLine([command, ...args])}`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => resolve(127));
    child.on("close", (exit) => resolve(exit ?? 1));
  });
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${code}`);
}
