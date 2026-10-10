import test from "node:test";
import assert from "node:assert/strict";
import { DesktopRuntime, productionDesktopHandlers, type CdpSocket, type CdpTarget, type DesktopCommandResult } from "../packages/desktop/src/index.js";

test("desktop uses fixed geometry and generation-local browser targets", async () => {
  const runtime = new DesktopRuntime();
  const tab = runtime.open("https://example.test");
  assert.equal(runtime.snapshot().width, 1440);
  assert.equal(runtime.snapshot().height, 900);
  assert.equal(runtime.getTab(tab.tab_id).url, "https://example.test");
  runtime.reset();
  assert.throws(() => runtime.getTab(tab.tab_id), /stale/);
});

test("desktop reaps after demand disappears", async () => {
  const runtime = new DesktopRuntime();
  runtime.acquireViewer();
  await runtime.ensureStarted();
  assert.equal(runtime.phase, "ready");
  runtime.releaseViewer(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.phase, "stopped");
});

test("production desktop handlers use CDP and bounded desktop commands", async () => {
  const target: CdpTarget = { id: "target-1", type: "page", title: "Example", url: "https://example.test", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-1" };
  const calls: Array<{ command: string; args: string[] }> = [];
  const commandRunner = async (command: string, args: string[]): Promise<DesktopCommandResult> => {
    calls.push({ command, args });
    if (command === "xdotool" && args[0] === "getdisplaygeometry") return { stdout: Buffer.from("1440 900\n"), stderr: Buffer.alloc(0), code: 0 };
    if (command === "import") return { stdout: Buffer.from("png-bytes"), stderr: Buffer.alloc(0), code: 0 };
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
  };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/json/list")) return new Response(JSON.stringify([target]), { status: 200 });
    if (url.includes("/json/new?")) return new Response(JSON.stringify({ ...target, id: "target-2", url: "https://new.test" }), { status: 200 });
    if (url.includes("/json/activate/") || url.includes("/json/close/")) return new Response("Target activated", { status: 200 });
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
  };
  const handlers = productionDesktopHandlers({ fetchImpl, commandRunner, webSocketFactory: () => new FakeCdpSocket() });
  const status = await handlers["desktop.status"]!({}, {} as any);
  assert.deepEqual((status as any).width, 1440);
  const opened = await handlers["browser.open"]!({ url: "https://new.test" }, {} as any) as any;
  assert.equal(opened.tab_id, "target-2");
  const screenshot = await handlers["browser.screenshot"]!({ tab_id: "target-1" }, {} as any) as any;
  assert.equal(screenshot.mime_type, "image/png");
  assert.equal(screenshot.data, "data:image/png;base64,c2NyZWVuc2hvdA==");
  await handlers["desktop.click"]!({ x: 10, y: 20, button: "left" }, {} as any);
  await handlers["desktop.type"]!({ text: "hello" }, {} as any);
  assert.ok(calls.some((call) => call.command === "xdotool" && call.args[0] === "click"));
  assert.ok(calls.some((call) => call.command === "xdotool" && call.args[0] === "type"));
});

class FakeCdpSocket implements CdpSocket {
  readonly readyState = 1;
  private readonly listeners = new Map<string, ((event: any) => void)[]>();
  constructor() { queueMicrotask(() => this.emit("open", {})); }
  send(data: string): void {
    const request = JSON.parse(data) as { id: number; method: string };
    const result = request.method === "Page.captureScreenshot" ? { data: Buffer.from("screenshot").toString("base64") } : {};
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: request.id, result }) }));
  }
  close(): void { this.emit("close", {}); }
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  private emit(type: string, event: any): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}
