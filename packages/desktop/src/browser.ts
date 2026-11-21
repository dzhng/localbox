import { createRequire } from "node:module";
import { ContractError, type Json } from "../../contract/src/index.js";
import { dataUrl, fits, REENCODE_STEPS } from "./screenshot.js";

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

export interface CdpBrowserOptions {
  /** Chromium remote debugging HTTP endpoint. Defaults to loopback port 9222. */
  cdpUrl?: string;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => CdpSocket;
  generation?: number;
  commandTimeoutMs?: number;
  /**
   * Starts the browser when CDP doesn't answer (the macOS desktop role launches Chrome in the user session). Unset
   * where a supervisor keeps it running (the Linux image's `localbox-browser` unit).
   */
  launch?: () => Promise<void>;
  /** How long a launched browser has to answer CDP. */
  launchTimeoutMs?: number;
}

/** The guest's Chrome, driven over CDP: the same on every guest OS. */
export class CdpBrowser {
  private readonly fetchImpl: typeof fetch;
  private readonly makeSocket: (url: string) => CdpSocket;
  private readonly cdpUrl: string;
  private readonly generation: number;
  private readonly commandTimeoutMs: number;
  private readonly launch: (() => Promise<void>) | undefined;
  private readonly launchTimeoutMs: number;
  private launching: Promise<void> | undefined;
  private focusedTab?: string;

  constructor(options: CdpBrowserOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.makeSocket = options.webSocketFactory ?? defaultWebSocketFactory;
    this.cdpUrl = (options.cdpUrl ?? "http://127.0.0.1:9222").replace(/\/$/, "");
    this.generation = options.generation ?? 1;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.launch = options.launch;
    this.launchTimeoutMs = options.launchTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs < 1) throw new TypeError("commandTimeoutMs must be positive");
  }

  /** The tabs if the browser is up, else none: reading status never starts a browser. */
  async openTabs(): Promise<Json[]> {
    try { return (await this.targets(false)).filter((target) => !target.type || target.type === "page").map((target) => this.tab(target)); }
    catch (error) { if (error instanceof ContractError && error.code === "guest_unreachable") return []; throw error; }
  }

  async listTabs(): Promise<Json> {
    const targets = await this.targets();
    return { tabs: targets.filter((target) => !target.type || target.type === "page").map((target) => this.tab(target)) } as Json;
  }

  async open(url: string): Promise<Json> {
    if (!url) throw new ContractError("invalid_input", "browser URL must be non-empty");
    let response = await this.cdp(`/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!response.ok && (response.status === 404 || response.status === 405)) response = await this.cdp(`/json/new?${encodeURIComponent(url)}`);
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
    const response = await this.cdp(`/json/activate/${encodeURIComponent(target.id)}`);
    if (!response.ok) throw new ContractError("guest_unreachable", `Chromium could not focus tab (${response.status})`, undefined, true);
    this.focusedTab = target.id;
    return this.tab(target);
  }

  async close(tabId: string): Promise<Json> {
    await this.target(tabId);
    const response = await this.cdp(`/json/close/${encodeURIComponent(tabId)}`);
    if (!response.ok) throw new ContractError("guest_unreachable", `Chromium could not close tab (${response.status})`, undefined, true);
    if (this.focusedTab === tabId) this.focusedTab = undefined;
    return { closed: tabId };
  }

  async browserScreenshot(tabId: string): Promise<Json> {
    const target = await this.target(tabId);
    return await this.withCdp(target, async (client) => {
      await client.command("Page.enable");
      const shot = async (params: Record<string, unknown>) => {
        const result = await client.command("Page.captureScreenshot", params);
        if (!result?.data || typeof result.data !== "string") throw new ContractError("internal", "Chromium returned no screenshot");
        return result.data as string;
      };
      const png = await shot({ format: "png" });
      if (fits("image/png", png)) return { mime_type: "image/png", data: dataUrl("image/png", png) } as Json;
      const metrics = await client.command("Page.getLayoutMetrics") as { cssLayoutViewport?: { clientWidth: number; clientHeight: number } };
      const viewport = metrics?.cssLayoutViewport ?? { clientWidth: 1440, clientHeight: 900 };
      for (const step of REENCODE_STEPS) {
        const jpeg = await shot({ format: "jpeg", quality: step.quality, ...(step.scale < 1 ? { clip: { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight, scale: step.scale } } : {}) });
        if (fits("image/jpeg", jpeg)) return { mime_type: "image/jpeg", data: dataUrl("image/jpeg", jpeg), reencoded: { from: "image/png", original_bytes: Buffer.byteLength(dataUrl("image/png", png)), quality: step.quality, scale: step.scale } } as Json;
      }
      throw new ContractError("resource_exhausted", "browser screenshot does not fit the output cap even re-encoded");
    });
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
    const value = cdpKeySpec(key);
    await this.withCdp(target, async (client) => {
      const params = { key: value.key, code: value.code, modifiers: value.modifiers, ...(value.text ? { text: value.text } : {}) };
      await client.command("Input.dispatchKeyEvent", { type: "keyDown", ...params });
      await client.command("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    });
    return { tab_id: tabId, key };
  }

  private async targets(launch = true): Promise<CdpTarget[]> {
    const response = await this.cdp(`/json/list`, undefined, launch);
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

  /** One CDP HTTP call; when the browser isn't up and this guest launches it, starts it once and retries. */
  private async cdp(path: string, init?: RequestInit, launch = true): Promise<Response> {
    try { return await this.fetchImpl(`${this.cdpUrl}${path}`, init); }
    catch (error) {
      if (!this.launch || !launch) throw new ContractError("guest_unreachable", `Chromium CDP is unavailable: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
      this.launching ??= this.started().finally(() => { this.launching = undefined; });
      await this.launching;
      return await this.fetchImpl(`${this.cdpUrl}${path}`, init);
    }
  }

  private async started(): Promise<void> {
    await this.launch!();
    for (const deadline = Date.now() + this.launchTimeoutMs; Date.now() < deadline;) {
      try { if ((await this.fetchImpl(`${this.cdpUrl}/json/version`)).ok) return; } catch { /* not listening yet */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new ContractError("guest_unreachable", `Chrome did not answer CDP within ${this.launchTimeoutMs} ms of launching`, undefined, true);
  }
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
      if (socket.readyState === 1) { clearTimeout(timer); resolve(); }
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

function cdpKeySpec(raw: string): { key: string; code: string; modifiers: number; text?: string } {
  const parts = raw.split("+").filter(Boolean);
  const base = parts.pop() ?? raw;
  let modifiers = 0;
  for (const modifier of parts) {
    if (modifier.toUpperCase() === "CTRL" || modifier.toUpperCase() === "CONTROL") modifiers |= 2;
    else if (modifier.toUpperCase() === "ALT") modifiers |= 1;
    else if (modifier.toUpperCase() === "SHIFT") modifiers |= 8;
    else if (modifier.toUpperCase() === "META" || modifier.toUpperCase() === "CMD" || modifier.toUpperCase() === "COMMAND") modifiers |= 4;
  }
  const aliases: Record<string, string> = { ENTER: "Enter", ESC: "Escape", ESCAPE: "Escape", TAB: "Tab", BACKSPACE: "Backspace", SPACE: " ", ARROWLEFT: "ArrowLeft", ARROWRIGHT: "ArrowRight", ARROWUP: "ArrowUp", ARROWDOWN: "ArrowDown" };
  const value = aliases[base.toUpperCase()] ?? base;
  const code = value.length === 1 && /[a-z]/i.test(value) ? `Key${value.toUpperCase()}` : value === " " ? "Space" : value;
  return { key: value, code, modifiers, ...(value.length === 1 ? { text: value } : {}) };
}

