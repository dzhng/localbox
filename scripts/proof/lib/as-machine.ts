import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";

export function asMachine(machine: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cwd = options.cwd ?? process.cwd();
    const child = spawn(process.execPath, ["bin/localbox.js", ...args], { cwd, env: { ...process.env, ...options.env, LOCALBOX_MACHINE: machine, LOCALBOX_MACHINE_ROOT: options.env?.LOCALBOX_MACHINE_ROOT ?? resolvePath(cwd, ".localbox", "proof", "machines", machine) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
