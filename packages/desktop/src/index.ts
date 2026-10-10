import { createHash } from "node:crypto";

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
