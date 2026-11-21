import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContractError } from "../../contract/src/index.js";
import { defaultCommandRunner, notches, runDesktopCommand, type CaptureEncoding, type DesktopButton, type DesktopCommandRunner, type DesktopSurface } from "./surface.js";

export interface MacSurfaceOptions {
  /** The `localbox-desktop` helper, installed beside the agent (`/usr/local/localbox/localbox-desktop`). */
  helper: string;
  commandRunner?: DesktopCommandRunner;
  env?: NodeJS.ProcessEnv;
}

/**
 * The macOS guest's desktop, reached through the `localbox-desktop` Swift helper (ScreenCaptureKit and CGEvent, which
 * a Bun binary can't call). The agent's `--desktop` role spawns it in the auto-login session, so TCC sees the agent as
 * the responsible process and the agent's rows grant it. The helper stays mechanical; key names, scroll direction and
 * encodings are decided here.
 */
export class MacSurface implements DesktopSurface {
  private readonly helper: string;
  private readonly runner: DesktopCommandRunner;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: MacSurfaceOptions) {
    this.helper = options.helper;
    this.runner = options.commandRunner ?? defaultCommandRunner;
    this.env = { ...process.env, ...(options.env ?? {}) };
  }

  async geometry(): Promise<{ width: number; height: number }> {
    const output = (await this.run(["geometry"])).stdout.toString("utf8").trim().match(/^(\d+)\s+(\d+)$/);
    if (!output) throw new ContractError("internal", "localbox-desktop returned invalid display geometry");
    return { width: Number(output[1]), height: Number(output[2]) };
  }

  async capture(encoding: CaptureEncoding): Promise<Buffer> {
    return (await this.run(encoding.format === "png" ? ["capture", "png"] : ["capture", "jpeg", String(encoding.quality), String(encoding.scale)])).stdout;
  }

  async move(x: number, y: number): Promise<void> { await this.run(["move", coordinate(x), coordinate(y)]); }

  async click(x: number, y: number, button: DesktopButton): Promise<void> { await this.run(["click", coordinate(x), coordinate(y), button]); }

  async scroll(x: number, y: number, deltaY: number, deltaX: number): Promise<void> {
    // A CGEvent wheel's positive value scrolls up (or left), the opposite of the handlers' convention.
    await this.run(["scroll", coordinate(x), coordinate(y), String(deltaY ? -Math.sign(deltaY) * notches(deltaY) : 0), String(deltaX ? -Math.sign(deltaX) * notches(deltaX) : 0)]);
  }

  async key(chord: string): Promise<void> {
    const { keyCode, modifiers } = macKey(chord);
    await this.run(["key", String(keyCode), ...(modifiers.length ? [modifiers.join(",")] : [])]);
  }

  async type(text: string): Promise<void> { if (text) await this.run(["type", text]); }

  private run(args: string[]) { return runDesktopCommand(this.runner, this.helper, args, this.env); }
}

function coordinate(value: number): string {
  if (!Number.isFinite(value)) throw new ContractError("invalid_input", "desktop coordinates must be finite numbers");
  return String(value);
}

/** macOS virtual key codes (`kVK_*` in Carbon's Events.h) for the ANSI layout. */
const KEY_CODES: Record<string, number> = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07, c: 0x08, v: 0x09, b: 0x0b, q: 0x0c, w: 0x0d,
  e: 0x0e, r: 0x0f, y: 0x10, t: 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18,
  "9": 0x19, "7": 0x1a, "-": 0x1b, "8": 0x1c, "0": 0x1d, "]": 0x1e, o: 0x1f, u: 0x20, "[": 0x21, i: 0x22, p: 0x23,
  l: 0x25, j: 0x26, "'": 0x27, k: 0x28, ";": 0x29, "\\": 0x2a, ",": 0x2b, "/": 0x2c, n: 0x2d, m: 0x2e, ".": 0x2f,
  "`": 0x32,
  return: 0x24, enter: 0x24, tab: 0x30, space: 0x31, " ": 0x31, backspace: 0x33, escape: 0x35, esc: 0x35,
  // X11's and the browser's "Delete" is forward delete; macOS labels Backspace "delete".
  delete: 0x75, forwarddelete: 0x75, home: 0x73, end: 0x77, pageup: 0x74, prior: 0x74, pagedown: 0x79, next: 0x79,
  left: 0x7b, arrowleft: 0x7b, right: 0x7c, arrowright: 0x7c, down: 0x7d, arrowdown: 0x7d, up: 0x7e, arrowup: 0x7e,
  f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61, f7: 0x62, f8: 0x64, f9: 0x65, f10: 0x6d, f11: 0x67, f12: 0x6f,
};

const MODIFIERS: Record<string, string> = { ctrl: "control", control: "control", shift: "shift", alt: "option", option: "option", cmd: "command", command: "command", meta: "command", super: "command" };

/** A chord such as `ctrl+c`, `cmd+shift+t`, `Return` or `A` (shift+a) as a key code and its modifier names. */
export function macKey(chord: string): { keyCode: number; modifiers: string[] } {
  const parts = chord.split("+");
  const base = parts.pop() ?? "";
  const modifiers = new Set<string>();
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) throw new ContractError("invalid_input", `unknown key modifier "${part}" in "${chord}"`);
    modifiers.add(modifier);
  }
  if (/^[A-Z]$/.test(base)) modifiers.add("shift");
  const keyCode = KEY_CODES[base.length === 1 ? base.toLowerCase() : base.toLowerCase().replace(/[_ ]/g, "")];
  if (keyCode === undefined) throw new ContractError("invalid_input", `unknown key "${base}" in "${chord}"; desktop.type sends any text`);
  return { keyCode, modifiers: [...modifiers].sort() };
}

export interface MacChromeOptions {
  /** CDP's loopback port (9222, as on Linux). */
  port: number;
  /** A profile of its own: Chrome refuses remote debugging on the default profile. */
  userDataDir: string;
  app?: string;
  commandRunner?: DesktopCommandRunner;
  env?: NodeJS.ProcessEnv;
}

/**
 * What a new profile starts with: no sign-in (so no "Sign in to Chrome?" button) and no site asking to send
 * notifications. A sandbox's browser is driven by agents, so anything Chrome asks covers what they look at; an unmanaged
 * Mac ignores Chrome's managed policies, so the profile itself carries these.
 */
export const MAC_CHROME_PROFILE = { signin: { allowed: false }, profile: { default_content_setting_values: { notifications: 2 } } };

/**
 * Starts Google Chrome in the desktop role's session through Launch Services (`open`), so it is an ordinary app of the
 * logged-in user that outlives the agent; `CdpBrowser` calls this when CDP doesn't answer and waits for it to. It starts
 * with no window, so the tab `browser.open` makes is the only one (no stray blank tab beside it), on a profile seeded
 * with `MAC_CHROME_PROFILE` the first time.
 */
export function macChromeLauncher(options: MacChromeOptions): () => Promise<void> {
  const runner = options.commandRunner ?? defaultCommandRunner, env = { ...process.env, ...(options.env ?? {}) };
  return async () => {
    const preferences = join(options.userDataDir, "Default", "Preferences");
    if (!existsSync(preferences)) {
      mkdirSync(join(options.userDataDir, "Default"), { recursive: true });
      writeFileSync(preferences, JSON.stringify(MAC_CHROME_PROFILE));
    }
    await runDesktopCommand(runner, "/usr/bin/open", ["-n", "-a", options.app ?? "Google Chrome", "--args",
      `--remote-debugging-port=${options.port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${options.userDataDir}`,
      "--no-first-run", "--no-default-browser-check", "--no-startup-window"], env);
  };
}
