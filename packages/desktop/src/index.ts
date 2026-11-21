import { createHash } from "node:crypto";
import type { Json, OperationId } from "../../contract/src/index.js";
import type { HandlerRegistry } from "../../runtime/src/index.js";
import { CdpBrowser, type CdpBrowserOptions } from "./browser.js";
import { MacSurface, type MacSurfaceOptions } from "./macos.js";
import { desktopScreenshot } from "./screenshot.js";
import { desktopButton, type DesktopSurface } from "./surface.js";
import { X11Surface, type X11SurfaceOptions } from "./x11.js";

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


/** Every operation a production desktop answers: on darwin the root role forwards exactly these to the `--desktop` role. */
export const DESKTOP_OPERATIONS = [
  "desktop.status", "desktop.screenshot", "desktop.click", "desktop.move", "desktop.scroll", "desktop.key", "desktop.type",
  "browser.list_tabs", "browser.open", "browser.navigate", "browser.focus", "browser.close", "browser.screenshot",
  "browser.click", "browser.type", "browser.key",
] as const satisfies readonly OperationId[];

export type ProductionDesktopOptions = CdpBrowserOptions & (
  | ({ backend: "x11" } & X11SurfaceOptions)
  | ({ backend: "macos" } & MacSurfaceOptions)
);

/**
 * Production handlers for a guest with a real desktop: one handler set over the guest OS's surface (`x11` on Linux,
 * `macos` in the darwin desktop role) and Chrome over CDP. Fixture callers keep `DesktopRuntime`.
 */
export function productionDesktopHandlers(options: ProductionDesktopOptions): HandlerRegistry {
  const surface: DesktopSurface = options.backend === "macos" ? new MacSurface(options) : new X11Surface(options);
  const browser = new CdpBrowser(options);
  type In<T> = T & Json;
  const handlers: Record<(typeof DESKTOP_OPERATIONS)[number], (input: any) => Promise<Json>> = {
    "desktop.status": async () => {
      const [{ width, height }, tabs] = await Promise.all([surface.geometry(), browser.openTabs()]);
      return { width, height, phase: "ready", viewers: 0, work: 0, browser_tabs: tabs };
    },
    "desktop.screenshot": () => desktopScreenshot(surface),
    "desktop.click": async (input: In<{ x: number; y: number; button?: string }>) => { const button = desktopButton(input.button); await surface.click(input.x, input.y, button); return { x: input.x, y: input.y, button, clicked: true }; },
    "desktop.move": async (input: In<{ x: number; y: number }>) => { await surface.move(input.x, input.y); return { x: input.x, y: input.y, moved: true }; },
    "desktop.scroll": async (input: In<{ x: number; y: number; delta_y: number; delta_x?: number }>) => { const deltaX = input.delta_x ?? 0; await surface.scroll(input.x, input.y, input.delta_y, deltaX); return { x: input.x, y: input.y, delta_y: input.delta_y, delta_x: deltaX, scrolled: true }; },
    "desktop.key": async (input: In<{ key: string }>) => { await surface.key(input.key); return { key: input.key, sent: true }; },
    "desktop.type": async (input: In<{ text: string }>) => { await surface.type(input.text); return { text: input.text, typed: true }; },
    "browser.list_tabs": () => browser.listTabs(),
    "browser.open": (input: In<{ url: string }>) => browser.open(input.url),
    "browser.navigate": (input: In<{ tab_id: string; url: string }>) => browser.navigate(input.tab_id, input.url),
    "browser.focus": (input: In<{ tab_id: string }>) => browser.focus(input.tab_id),
    "browser.close": (input: In<{ tab_id: string }>) => browser.close(input.tab_id),
    "browser.screenshot": (input: In<{ tab_id: string }>) => browser.browserScreenshot(input.tab_id),
    "browser.click": (input: In<{ tab_id: string; x: number; y: number }>) => browser.click(input.tab_id, input.x, input.y),
    "browser.type": (input: In<{ tab_id: string; text: string }>) => browser.type(input.tab_id, input.text),
    "browser.key": (input: In<{ tab_id: string; key: string }>) => browser.key(input.tab_id, input.key),
  };
  return handlers;
}

export { CdpBrowser, type CdpBrowserOptions, type CdpSocket, type CdpTarget } from "./browser.js";
export { MacSurface, macChromeLauncher, macKey, type MacChromeOptions, type MacSurfaceOptions } from "./macos.js";
export { X11Surface, type X11SurfaceOptions } from "./x11.js";
export type { CaptureEncoding, DesktopButton, DesktopCommandResult, DesktopCommandRunner, DesktopSurface } from "./surface.js";
