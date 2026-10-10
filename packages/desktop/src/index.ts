import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { ContractError, type Json, type OperationId } from "../../contract/src/index.js";
import type { Handler, HandlerRegistry } from "../../runtime/src/index.js";

export type DesktopPhase = "stopped" | "starting" | "ready" | "reaping";
export interface BrowserTab { tab_id: string; generation: number; url: string; title: string; focused: boolean; }
export interface DesktopSnapshot { width: 1440; height: 900; phase: DesktopPhase; viewers: number; work: number; browser_tabs: BrowserTab[]; screenshot: { mime_type: "image/png"; data: string }; }

/** Deterministic desktop/browser owner used by the guest gateway and CI. */
export class DesktopRuntime {
  readonly width = 1440 as const;
  readonly height = 900 as const;
  phase: DesktopPhase = "stopped";
  generation = 0;
  viewers = 0;
  work = 0;
  private readonly tabs = new Map<string, BrowserTab>();
  private focusedTab?: string;
  private reapTimer?: ReturnType<typeof setTimeout>;

  async ensureStarted(): Promise<void> {
    if (this.phase === "ready") return;
    this.phase = "starting";
    this.generation += 1;
    await Promise.resolve();
    this.phase = "ready";
  }
  acquireViewer(): void { this.viewers += 1; void this.ensureStarted(); }
  releaseViewer(graceMs = 250): void { this.viewers = Math.max(0, this.viewers - 1); this.scheduleReap(graceMs); }
  beginWork(): void { this.work += 1; void this.ensureStarted(); }
  endWork(graceMs = 250): void { this.work = Math.max(0, this.work - 1); this.scheduleReap(graceMs); }
  private scheduleReap(graceMs: number): void {
    if (this.viewers || this.work || this.phase !== "ready") return;
    if (this.reapTimer) clearTimeout(this.reapTimer);
    this.phase = "reaping";
    this.reapTimer = setTimeout(() => { if (!this.viewers && !this.work) this.phase = "stopped"; }, graceMs);
    this.reapTimer.unref?.();
  }
  open(url: string): BrowserTab { this.beginWork(); const tab: BrowserTab = { tab_id: `tab_${this.generation}_${this.tabs.size + 1}`, generation: this.generation, url, title: url, focused: true }; for (const existing of this.tabs.values()) existing.focused = false; this.tabs.set(tab.tab_id, tab); this.focusedTab = tab.tab_id; this.endWork(); return tab; }
  getTab(tabId: string): BrowserTab {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.generation !== this.generation) throw new Error("stale or unknown browser target");
    return tab;
  }
  navigate(tabId: string, url: string): BrowserTab { const tab = this.getTab(tabId); tab.url = url; tab.title = url; return tab; }
  focus(tabId: string): BrowserTab { const tab = this.getTab(tabId); for (const item of this.tabs.values()) item.focused = false; tab.focused = true; this.focusedTab = tabId; return tab; }
  close(tabId: string): void { this.getTab(tabId); this.tabs.delete(tabId); if (this.focusedTab === tabId) this.focusedTab = undefined; this.scheduleReap(250); }
  listTabs(): BrowserTab[] { return [...this.tabs.values()].map((tab) => ({ ...tab })); }
  screenshot(): DesktopSnapshot["screenshot"] { const fingerprint = createHash("sha256").update(`${this.generation}:${this.phase}:${this.tabs.size}`).digest("base64url"); return { mime_type: "image/png", data: `fixture-desktop-${fingerprint}` }; }
  snapshot(): DesktopSnapshot { return { width: 1440, height: 900, phase: this.phase, viewers: this.viewers, work: this.work, browser_tabs: this.listTabs(), screenshot: this.screenshot() }; }
  reset(): void { this.tabs.clear(); this.focusedTab = undefined; this.generation += 1; this.phase = "stopped"; }
}

export function desktopHandlers(runtime = new DesktopRuntime()) {
  return {
    runtime,
    "desktop.status": () => runtime.snapshot(),
    "desktop.screenshot": () => runtime.screenshot(),
    "browser.list_tabs": () => ({ tabs: runtime.listTabs() }),
    "browser.open": (input: { url: string }) => runtime.open(input.url),
    "browser.navigate": (input: { tab_id: string; url: string }) => runtime.navigate(input.tab_id, input.url),
    "browser.focus": (input: { tab_id: string }) => runtime.focus(input.tab_id),
    "browser.close": (input: { tab_id: string }) => { runtime.close(input.tab_id); return { closed: input.tab_id }; },
    "browser.screenshot": (input: { tab_id: string }) => { runtime.getTab(input.tab_id); return runtime.screenshot(); },
  };
}

/**
 * CDP and X11-backed desktop/browser implementation used inside production
 * guests. It has no process-global state and is opt-in through
 * `productionDesktopHandlers`; fixture callers continue to use DesktopRuntime.
 */
export interface CdpTarget {
  id: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void): void;
}

export interface DesktopCommandResult { stdout: Buffer; stderr: Buffer; code: number }
export type DesktopCommandRunner = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<DesktopCommandResult>;

export interface ProductionDesktopOptions {
  /** Chromium remote debugging HTTP endpoint. Defaults to loopback port 9222. */
  cdpUrl?: string;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => CdpSocket;
  commandRunner?: DesktopCommandRunner;
  env?: NodeJS.ProcessEnv;
  generation?: number;
  commandTimeoutMs?: number;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly opened: Promise<void>;

  constructor(private readonly socket: CdpSocket, private readonly timeoutMs = 30_000) {
    this.opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ContractError("operation_timeout", "CDP websocket open timed out", undefined, true)), this.timeoutMs);
      const fail = (event: any) => { clearTimeout(timer); reject(new Error(event?.message ?? "CDP websocket failed")); };
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      socket.addEventListener("error", fail);
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        const error = new Error("CDP websocket closed");
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
      });
      socket.addEventListener("message", (event: any) => {
        try {
          const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8")) as { id?: number; result?: unknown; error?: { message?: string } };
          if (message.id === undefined) return;
          const waiter = this.pending.get(message.id);
          if (!waiter) return;
          this.pending.delete(message.id);
          if (message.error) waiter.reject(new Error(message.error.message ?? "CDP command failed")); else waiter.resolve(message.result ?? {});
        } catch (error) {
          for (const waiter of this.pending.values()) waiter.reject(error instanceof Error ? error : new Error(String(error)));
          this.pending.clear();
        }
      });
    });
  }

  async command(method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.opened;
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ContractError("operation_timeout", `CDP command timed out: ${method}`, undefined, true)); }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  close(): void { this.socket.close(); }
}

class ProductionDesktopBackend {
  private readonly fetchImpl: typeof fetch;
  private readonly makeSocket: (url: string) => CdpSocket;
  private readonly command: DesktopCommandRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cdpUrl: string;
  private readonly generation: number;
  private readonly commandTimeoutMs: number;
  private focusedTab?: string;

  constructor(options: ProductionDesktopOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.makeSocket = options.webSocketFactory ?? defaultWebSocketFactory;
    this.command = options.commandRunner ?? defaultCommandRunner;
    this.env = { ...process.env, ...(options.env ?? {}) };
    this.cdpUrl = (options.cdpUrl ?? "http://127.0.0.1:9222").replace(/\/$/, "");
    this.generation = options.generation ?? 1;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs < 1) throw new TypeError("commandTimeoutMs must be positive");
  }

  async status(): Promise<Json> {
    const geometry = await this.displayGeometry();
    const tabs = await this.targets();
    return { width: geometry.width, height: geometry.height, phase: "ready", viewers: 0, work: 0, browser_tabs: tabs.filter((target) => !target.type || target.type === "page").map((target) => this.tab(target)) } as Json;
  }

  async screenshot(): Promise<Json> {
    let output: DesktopCommandResult;
    try { output = await this.run("import", ["-window", "root", "png:-"]); }
    catch (error) {
      if (!(error instanceof ContractError) || error.code !== "unsupported") throw error;
      output = await this.run("magick", ["import", "-window", "root", "png:-"]);
    }
    return { mime_type: "image/png", data: `data:image/png;base64,${output.stdout.toString("base64")}` };
  }

  async listTabs(): Promise<Json> {
    const targets = await this.targets();
    return { tabs: targets.filter((target) => !target.type || target.type === "page").map((target) => this.tab(target)) } as Json;
  }

  async open(url: string): Promise<Json> {
    if (!url) throw new ContractError("invalid_input", "browser URL must be non-empty");
    let response = await this.fetchImpl(`${this.cdpUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!response.ok && (response.status === 404 || response.status === 405)) response = await this.fetchImpl(`${this.cdpUrl}/json/new?${encodeURIComponent(url)}`);
    if (!response.ok) throw new ContractError("guest_unreachable", `Chromium could not open a tab (${response.status})`, undefined, true);
    const target = await response.json() as CdpTarget;
    if (!target.id) throw new ContractError("internal", "Chromium returned an invalid target");
    this.focusedTab = target.id;
    return this.tab(target);
  }

  async navigate(tabId: string, url: string): Promise<Json> {
    const target = await this.target(tabId);
    await this.withCdp(target, (client) => client.command("Page.navigate", { url }));
    return this.tab({ ...target, url });
  }

  async focus(tabId: string): Promise<Json> {
    const target = await this.target(tabId);
    const response = await this.fetchImpl(`${this.cdpUrl}/json/activate/${encodeURIComponent(target.id)}`);
    if (!response.ok) throw new ContractError("guest_unreachable", `Chromium could not focus tab (${response.status})`, undefined, true);
    this.focusedTab = target.id;
    return this.tab(target);
  }

  async close(tabId: string): Promise<Json> {
    await this.target(tabId);
    const response = await this.fetchImpl(`${this.cdpUrl}/json/close/${encodeURIComponent(tabId)}`);
    if (!response.ok) throw new ContractError("guest_unreachable", `Chromium could not close tab (${response.status})`, undefined, true);
    if (this.focusedTab === tabId) this.focusedTab = undefined;
    return { closed: tabId };
  }

  async browserScreenshot(tabId: string): Promise<Json> {
    const target = await this.target(tabId);
    const result = await this.withCdp(target, async (client) => {
      await client.command("Page.enable");
      return await client.command("Page.captureScreenshot", { format: "png" });
    });
    if (!result?.data || typeof result.data !== "string") throw new ContractError("internal", "Chromium returned no screenshot");
    return { mime_type: "image/png", data: `data:image/png;base64,${result.data}` };
  }

  async click(tabId: string, x: number, y: number): Promise<Json> {
    const target = await this.target(tabId);
    await this.withCdp(target, async (client) => {
      await client.command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await client.command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    });
    return { tab_id: tabId, clicked: true, x, y };
  }

  async type(tabId: string, text: string): Promise<Json> {
    const target = await this.target(tabId);
    await this.withCdp(target, (client) => client.command("Input.insertText", { text }));
    return { tab_id: tabId, typed: text.length };
  }

  async key(tabId: string, key: string): Promise<Json> {
    const target = await this.target(tabId);
    const value = normalizeCdpKey(key);
    await this.withCdp(target, async (client) => {
      await client.command("Input.dispatchKeyEvent", { type: "keyDown", key: value, code: value });
      await client.command("Input.dispatchKeyEvent", { type: "keyUp", key: value, code: value });
    });
    return { tab_id: tabId, key };
  }

  async desktopClick(x: number, y: number, button: string): Promise<Json> {
    await this.run("xdotool", ["mousemove", "--sync", String(x), String(y)]);
    await this.run("xdotool", ["click", desktopButton(button)]);
    return { x, y, button, clicked: true };
  }

  async desktopMove(x: number, y: number): Promise<Json> {
    await this.run("xdotool", ["mousemove", "--sync", String(x), String(y)]);
    return { x, y, moved: true };
  }

  async desktopScroll(x: number, y: number, deltaY: number, deltaX = 0): Promise<Json> {
    await this.run("xdotool", ["mousemove", "--sync", String(x), String(y)]);
    if (deltaY) await this.run("xdotool", ["click", "--repeat", String(Math.max(1, Math.abs(Math.trunc(deltaY)))), deltaY > 0 ? "5" : "4"]);
    if (deltaX) await this.run("xdotool", ["click", "--repeat", String(Math.max(1, Math.abs(Math.trunc(deltaX)))), deltaX > 0 ? "7" : "6"]);
    return { x, y, delta_y: deltaY, delta_x: deltaX, scrolled: true };
  }

  async desktopKey(key: string): Promise<Json> {
    await this.run("xdotool", ["key", normalizeKey(key)]);
    return { key, sent: true };
  }

  async desktopType(text: string): Promise<Json> {
    await this.run("xdotool", ["type", "--clearmodifiers", "--delay", "0", text]);
    return { text, typed: true };
  }

  private async targets(): Promise<CdpTarget[]> {
    const response = await this.fetchImpl(`${this.cdpUrl}/json/list`);
    if (!response.ok) throw new ContractError("guest_unreachable", `Chromium CDP is unavailable (${response.status})`, undefined, true);
    const value = await response.json() as unknown;
    if (!Array.isArray(value)) throw new ContractError("internal", "Chromium returned an invalid target list");
    return value.filter((target): target is CdpTarget => Boolean(target && typeof target === "object" && typeof (target as CdpTarget).id === "string"));
  }

  private async target(tabId: string): Promise<CdpTarget> {
    const target = (await this.targets()).find((candidate) => candidate.id === tabId && (!candidate.type || candidate.type === "page"));
    if (!target) throw new ContractError("invalid_input", `unknown browser tab: ${tabId}`);
    if (!target.webSocketDebuggerUrl) throw new ContractError("guest_unreachable", "Chromium target has no debugger websocket", undefined, true);
    return target;
  }

  private tab(target: CdpTarget): Json {
    return { tab_id: target.id, generation: this.generation, url: target.url ?? "about:blank", title: target.title ?? target.url ?? "", focused: target.id === this.focusedTab };
  }

  private async withCdp<T>(target: CdpTarget, action: (client: CdpClient) => Promise<T>): Promise<T> {
    if (!target.webSocketDebuggerUrl) throw new ContractError("guest_unreachable", "Chromium target has no debugger websocket", undefined, true);
    const client = new CdpClient(this.makeSocket(target.webSocketDebuggerUrl), this.commandTimeoutMs);
    try { return await action(client); } catch (error) { if (error instanceof ContractError) throw error; throw new ContractError("guest_unreachable", error instanceof Error ? error.message : "Chromium CDP command failed", undefined, true); } finally { client.close(); }
  }

  private async displayGeometry(): Promise<{ width: number; height: number }> {
    const output = await this.run("xdotool", ["getdisplaygeometry"]);
    const match = output.stdout.toString("utf8").trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) throw new ContractError("internal", "xdotool returned invalid display geometry");
    return { width: Number(match[1]), height: Number(match[2]) };
  }

  private async run(command: string, args: string[]): Promise<DesktopCommandResult> {
    try { return await this.command(command, args, this.env); }
    catch (error) {
      if (error instanceof ContractError) throw error;
      throw new ContractError("unsupported", `${command} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Build production handlers without changing the deterministic fixture backend. */
export function productionDesktopHandlers(options: ProductionDesktopOptions = {}): HandlerRegistry {
  const backend = new ProductionDesktopBackend(options);
  return {
    "desktop.status": () => backend.status(),
    "desktop.screenshot": () => backend.screenshot(),
    "browser.list_tabs": () => backend.listTabs(),
    "browser.open": (input) => backend.open((input as { url: string }).url),
    "browser.navigate": (input) => { const value = input as { tab_id: string; url: string }; return backend.navigate(value.tab_id, value.url); },
    "browser.focus": (input) => backend.focus((input as { tab_id: string }).tab_id),
    "browser.close": (input) => backend.close((input as { tab_id: string }).tab_id),
    "browser.screenshot": (input) => backend.browserScreenshot((input as { tab_id: string }).tab_id),
    "browser.click": (input) => { const value = input as { tab_id: string; x: number; y: number }; return backend.click(value.tab_id, value.x, value.y); },
    "browser.type": (input) => { const value = input as { tab_id: string; text: string }; return backend.type(value.tab_id, value.text); },
    "browser.key": (input) => { const value = input as { tab_id: string; key: string }; return backend.key(value.tab_id, value.key); },
    "desktop.click": (input) => { const value = input as { x: number; y: number; button: string }; return backend.desktopClick(value.x, value.y, value.button); },
    "desktop.move": (input) => { const value = input as { x: number; y: number }; return backend.desktopMove(value.x, value.y); },
    "desktop.scroll": (input) => { const value = input as { x: number; y: number; delta_y: number; delta_x?: number }; return backend.desktopScroll(value.x, value.y, value.delta_y, value.delta_x ?? 0); },
    "desktop.key": (input) => backend.desktopKey((input as { key: string }).key),
    "desktop.type": (input) => backend.desktopType((input as { text: string }).text),
  };
}

function defaultWebSocketFactory(url: string): CdpSocket {
  const constructor = (globalThis as unknown as { WebSocket?: new (url: string) => CdpSocket }).WebSocket;
  if (constructor) return new constructor(url);
  // Debian's Node 18 image has no global WebSocket; undici ships the same
  // client implementation and is installed as a production runtime dep.
  try {
    const UndiciWebSocket = (createRequire(import.meta.url)("undici") as { WebSocket?: new (url: string) => CdpSocket }).WebSocket;
    if (UndiciWebSocket) return new UndiciWebSocket(url);
  } catch { /* report the stable contract error below */ }
  throw new ContractError("unsupported", "Node WebSocket support is unavailable");
}

function defaultCommandRunner(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<DesktopCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 1 };
      if (result.code !== 0) reject(new ContractError("internal", result.stderr.toString("utf8") || `${command} exited with code ${result.code}`)); else resolve(result);
    });
  });
}

function desktopButton(button: string): string {
  switch (button.toLowerCase()) {
    case "left": return "1";
    case "middle": return "2";
    case "right": return "3";
    default: throw new ContractError("invalid_input", `unsupported desktop button: ${button}`);
  }
}

function normalizeKey(key: string): string {
  const aliases: Record<string, string> = { ENTER: "Return", ESC: "Escape", ESCAPE: "Escape", TAB: "Tab", BACKSPACE: "BackSpace", SPACE: "space", ARROWLEFT: "Left", ARROWRIGHT: "Right", ARROWUP: "Up", ARROWDOWN: "Down" };
  return aliases[key.toUpperCase()] ?? key;
}

function normalizeCdpKey(key: string): string {
  const aliases: Record<string, string> = { ENTER: "Enter", ESC: "Escape", ESCAPE: "Escape", TAB: "Tab", BACKSPACE: "Backspace", SPACE: " ", ARROWLEFT: "ArrowLeft", ARROWRIGHT: "ArrowRight", ARROWUP: "ArrowUp", ARROWDOWN: "ArrowDown" };
  return aliases[key.toUpperCase()] ?? key;
}
