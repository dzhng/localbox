import { spawn } from "node:child_process";
import { ContractError } from "../../contract/src/index.js";

/** How a screenshot is encoded: PNG first, then JPEG steps when the PNG doesn't fit the output cap. */
export type CaptureEncoding = { format: "png" } | { format: "jpeg"; quality: number; scale: number };

/**
 * One guest OS's desktop: the display, its pixels and its input. The browser is the same Chrome over CDP everywhere,
 * so only this differs between backends.
 */
export interface DesktopSurface {
  /** The display size in the coordinates `click`, `move` and `scroll` take (a screenshot at scale 1 has this size). */
  geometry(): Promise<{ width: number; height: number }>;
  capture(encoding: CaptureEncoding): Promise<Buffer>;
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number, button: DesktopButton): Promise<void>;
  /** Positive `deltaY` scrolls down and positive `deltaX` right, in wheel notches. */
  scroll(x: number, y: number, deltaY: number, deltaX: number): Promise<void>;
  /** A key chord such as `Return`, `ctrl+c` or `cmd+shift+t`. */
  key(chord: string): Promise<void>;
  type(text: string): Promise<void>;
}

export type DesktopButton = "left" | "middle" | "right";

export function desktopButton(button: string | undefined): DesktopButton {
  const value = (button ?? "left").toLowerCase();
  if (value === "left" || value === "middle" || value === "right") return value;
  throw new ContractError("invalid_input", `unsupported desktop button: ${button}`);
}

export interface DesktopCommandResult { stdout: Buffer; stderr: Buffer; code: number }
export type DesktopCommandRunner = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<DesktopCommandResult>;

/** Runs a desktop command; a failed one is `internal` with its stderr, a missing one `unsupported`. */
export async function runDesktopCommand(runner: DesktopCommandRunner, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<DesktopCommandResult> {
  try {
    const result = await runner(command, args, env);
    if (result.code !== 0) throw new ContractError("internal", result.stderr.toString("utf8").trim() || `${command} exited with code ${result.code}`);
    return result;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError("unsupported", `${command} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function defaultCommandRunner(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<DesktopCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 1 }));
  });
}

/** Wheel notches as a positive whole count, at least one when the delta is non-zero. */
export const notches = (delta: number) => Math.max(1, Math.abs(Math.trunc(delta)));
