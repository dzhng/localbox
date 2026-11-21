import { ContractError } from "../../contract/src/index.js";
import { defaultCommandRunner, notches, runDesktopCommand, type CaptureEncoding, type DesktopButton, type DesktopCommandRunner, type DesktopSurface } from "./surface.js";

export interface X11SurfaceOptions {
  commandRunner?: DesktopCommandRunner;
  /** Merged over the agent's environment; `DISPLAY` names the X server. */
  env?: NodeJS.ProcessEnv;
}

/** The Linux image's desktop: X display `:0`, driven with xdotool and captured with ImageMagick's `import`. */
export class X11Surface implements DesktopSurface {
  private readonly runner: DesktopCommandRunner;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: X11SurfaceOptions = {}) {
    this.runner = options.commandRunner ?? defaultCommandRunner;
    this.env = { ...process.env, ...(options.env ?? {}) };
  }

  async geometry(): Promise<{ width: number; height: number }> {
    const output = await this.run("xdotool", ["getdisplaygeometry"]);
    const match = output.stdout.toString("utf8").trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) throw new ContractError("internal", "xdotool returned invalid display geometry");
    return { width: Number(match[1]), height: Number(match[2]) };
  }

  async capture(encoding: CaptureEncoding): Promise<Buffer> {
    const output = encoding.format === "png" ? ["png:-"] : ["-quality", String(encoding.quality), ...(encoding.scale < 1 ? ["-resize", `${encoding.scale * 100}%`] : []), "jpeg:-"];
    try { return (await this.run("import", ["-window", "root", ...output])).stdout; }
    catch (error) {
      // ImageMagick 7 installs only `magick`.
      if (!(error instanceof ContractError) || error.code !== "unsupported") throw error;
      return (await this.run("magick", ["import", "-window", "root", ...output])).stdout;
    }
  }

  async move(x: number, y: number): Promise<void> { await this.run("xdotool", ["mousemove", "--sync", String(x), String(y)]); }

  async click(x: number, y: number, button: DesktopButton): Promise<void> {
    await this.move(x, y);
    await this.run("xdotool", ["click", { left: "1", middle: "2", right: "3" }[button]]);
  }

  async scroll(x: number, y: number, deltaY: number, deltaX: number): Promise<void> {
    await this.move(x, y);
    // X11 scrolls with buttons: 4 up, 5 down, 6 left, 7 right.
    if (deltaY) await this.run("xdotool", ["click", "--repeat", String(notches(deltaY)), deltaY > 0 ? "5" : "4"]);
    if (deltaX) await this.run("xdotool", ["click", "--repeat", String(notches(deltaX)), deltaX > 0 ? "7" : "6"]);
  }

  async key(chord: string): Promise<void> { await this.run("xdotool", ["key", x11Key(chord)]); }

  async type(text: string): Promise<void> { await this.run("xdotool", ["type", "--clearmodifiers", "--delay", "0", text]); }

  private run(command: string, args: string[]) { return runDesktopCommand(this.runner, command, args, this.env); }
}

/** xdotool takes keysyms; the browser-style names agents use map onto them. */
function x11Key(key: string): string {
  const aliases: Record<string, string> = { ENTER: "Return", ESC: "Escape", ESCAPE: "Escape", TAB: "Tab", BACKSPACE: "BackSpace", SPACE: "space", ARROWLEFT: "Left", ARROWRIGHT: "Right", ARROWUP: "Up", ARROWDOWN: "Down" };
  return aliases[key.toUpperCase()] ?? key;
}
