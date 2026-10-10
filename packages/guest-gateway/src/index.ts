import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import {
  ContractError, failure, type Json, type OperationId, success, type RequestEnvelope,
  type ResponseEnvelope, catalogById, operationCatalog, validateRequest,
} from "../../contract/src/index.js";
import { FixtureClock, type DispatchContext, type Handler, type HandlerRegistry } from "../../runtime/src/index.js";
import { DesktopRuntime, desktopHandlers } from "../../desktop/src/index.js";

export interface GuestGatewayOptions {
  root: string;
  shell?: string;
  maxOutputBytes?: number;
  maxCommandBytes?: number;
  journalPath?: string;
  now?: () => number;
  desktopRuntime?: DesktopRuntime;
  /** Optional production handlers. Fixture handlers remain the default. */
  extraHandlers?: HandlerRegistry;
}

export type ShellResult = {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  duration_ms: number;
}
export interface MutationJournalEntry { mutation_id: string; operation: string; response: ResponseEnvelope; recorded_at: number; key?: string; }

/** Guest-side operation handlers. All filesystem paths are rooted below `root`. */
export class GuestGateway {
  readonly root: string;
  readonly shell: string;
  readonly maxOutputBytes: number;
  readonly maxCommandBytes: number;
  private readonly journalFile: string;
  private readonly journal = new Map<string, MutationJournalEntry>();
  private readonly now: () => number;
  private readonly desktopRuntime: DesktopRuntime;
  private readonly extraHandlers: HandlerRegistry;
  private loaded = false;

  constructor(options: GuestGatewayOptions) {
    if (!isAbsolute(options.root)) throw new TypeError("guest root must be absolute");
    this.root = (() => { const root = resolve(options.root); try { return realpathSync(root); } catch { return root; } })();
    this.shell = options.shell ?? "/bin/sh";
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    this.maxCommandBytes = options.maxCommandBytes ?? 64 * 1024;
    this.journalFile = options.journalPath ?? resolve(this.root, ".localbox/mutation-journal.json");
    this.now = options.now ?? (() => Date.now());
    this.desktopRuntime = options.desktopRuntime ?? new DesktopRuntime();
    this.extraHandlers = options.extraHandlers ?? {};
  }

  private async loadJournal(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.journalFile, "utf8");
      const entries = JSON.parse(raw) as MutationJournalEntry[];
      for (const entry of entries) if (entry?.mutation_id && entry.response) this.journal.set(entry.key ?? entry.mutation_id, entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async saveJournal(): Promise<void> {
    await fs.mkdir(dirname(this.journalFile), { recursive: true });
    const temp = `${this.journalFile}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify([...this.journal.values()]), { mode: 0o600 });
    await fs.rename(temp, this.journalFile);
  }
  private path(input: unknown): string {
    if (typeof input !== "string" || !input.length) throw new ContractError("invalid_input", "path must be a non-empty string");
    const candidate = resolve(this.root, input.startsWith("/") ? `.${input}` : input);
    const rel = relative(this.root, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ContractError("forbidden", "guest path escapes the VM filesystem");
    return candidate;
  }
  private journalKey(request: RequestEnvelope): string { return `${request.vm_id}:${request.operation}:${request.mutation_id ?? ""}`; }
  private async existingPath(candidate: string): Promise<string> {
    let real: string;
    try { real = await fs.realpath(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error; throw error; }
    const rel = relative(this.root, real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ContractError("forbidden", "guest path resolves outside the VM filesystem");
    return real;
  }
  private async writePath(candidate: string): Promise<string> {
    const parent = await this.existingPath(dirname(candidate));
    return resolve(parent, candidate.slice(dirname(candidate).length + 1));
  }

  private async shellExec(input: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }, context: DispatchContext): Promise<Json> {
    const command = input.command;
    const args = input.args ?? [];
    if (Buffer.byteLength(command) + args.reduce((n, x) => n + Buffer.byteLength(x), 0) > this.maxCommandBytes) throw new ContractError("resource_exhausted", "command exceeds input limit");
    const cwd = input.cwd ? await this.existingPath(this.path(input.cwd)) : this.root;
    const started = this.now();
    return new Promise<Json>((resolveResult, reject) => {
      const child = spawn(this.shell, ["-c", `${command}${args.length ? ` ${args.map(shellQuote).join(" ")}` : ""}`], { cwd, env: { ...process.env, ...(input.env ?? {}) }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false, settled = false;
      const append = (which: "stdout" | "stderr", chunk: Buffer) => {
        const current = which === "stdout" ? stdout : stderr;
        const remaining = Math.max(0, this.maxOutputBytes - stdout.length - stderr.length);
        if (remaining < chunk.length) truncated = true;
        const accepted = chunk.subarray(0, remaining);
        if (which === "stdout") stdout = Buffer.concat([stdout, accepted]); else stderr = Buffer.concat([stderr, accepted]);
        if (remaining === 0 && child.pid) killTree(child);
      };
      child.stdout?.on("data", (c: Buffer) => append("stdout", c));
      child.stderr?.on("data", (c: Buffer) => append("stderr", c));
      const timeout = setTimeout(() => { if (child.pid) killTree(child); finish(new ContractError("operation_timeout", "shell execution timed out", { deadline_ms: context.request.deadline_ms }, true)); }, context.request.deadline_ms);
      const abort = () => { if (child.pid) killTree(child); finish(new ContractError("operation_cancelled", "shell execution cancelled")); };
      context.signal?.addEventListener("abort", abort, { once: true });
      const finish = (error?: ContractError) => {
        if (settled) return; settled = true; clearTimeout(timeout); context.signal?.removeEventListener("abort", abort);
        if (error) { reject(error); return; }
        resolveResult({ exit_code: child.exitCode, signal: null, stdout: stdout.toString(), stderr: stderr.toString(), truncated, duration_ms: Math.max(0, this.now() - started) });
      };
      child.once("error", (error) => finish(new ContractError("internal", error.message)));
      child.once("close", (code, signal) => finish(undefined));
    });
  }

  handlers(): Partial<Record<OperationId, Handler>> {
    const desktop = desktopHandlers(this.desktopRuntime) as unknown as Partial<Record<OperationId, Handler>>;
    return {
      ...desktop,
      "system.info": async (_input, context) => ({ vm_id: context.request.vm_id, root: "/", gateway: "guest", capabilities: operationCatalog.map((entry) => entry.id) }),
      "vm.list": async (_input, context) => ({ vms: [{ vm_id: context.request.vm_id, status: "ready" }] }),
      "vm.status": async (_input, context) => ({ vm_id: context.request.vm_id, status: "ready", desktop: this.desktopRuntime.phase }),
      "vm.start": async (_input, context) => ({ vm_id: context.request.vm_id, status: "ready", operation: "start" }),
      "vm.stop": async (_input, context) => { this.desktopRuntime.reset(); return { vm_id: context.request.vm_id, status: "stopped", operation: "stop" }; },
      "vm.pause": async (_input, context) => ({ vm_id: context.request.vm_id, status: "paused", operation: "pause" }),
      "vm.reset": async (_input, context) => { this.desktopRuntime.reset(); return { vm_id: context.request.vm_id, status: "stopped", operation: "reset" }; },
      "vm.logs": async () => ({ lines: [] }),
      "network.egress": async () => ({ connected: true, address: guestAddress(), source: "guest" }),
      "relay.status": async () => ({ connected: Boolean(process.env.LOCALBOX_RELAY_URL), relay_url: process.env.LOCALBOX_RELAY_URL ?? null }),
      "job.status": async (input) => ({ job_id: (input as { job_id: string }).job_id, status: "completed" }),
      "job.wait": async (input) => ({ job_id: (input as { job_id: string }).job_id, status: "completed" }),
      "job.cancel": async (input) => ({ job_id: (input as { job_id: string }).job_id, cancelled: true }),
      "job.output": async (input) => ({ job_id: (input as { job_id: string }).job_id, output: "" }),
      "shell.exec": (input, context) => this.shellExec(input as { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }, context),
      "fs.list": async (input) => { const path = await this.existingPath(this.path((input as { path: string }).path)); const entries = await fs.readdir(path, { withFileTypes: true }); return { path: guestPath(this.root, path), entries: entries.map((e) => ({ name: e.name, kind: e.isDirectory() ? "directory" : e.isFile() ? "file" : "other" })) }; },
      "fs.stat": async (input) => { const path = this.path((input as { path: string }).path); try { await this.existingPath(path); const stat = await fs.stat(path); return { path: guestPath(this.root, path), exists: true, kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other", size: stat.size, mode: stat.mode & 0o777, modified_ms: stat.mtimeMs }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: guestPath(this.root, path), exists: false } as Json; throw error; } },
      "fs.read": async (input) => { const path = await this.existingPath(this.path((input as { path: string }).path)); const content = await fs.readFile(path, "utf8"); if (Buffer.byteLength(content) > this.maxOutputBytes) throw new ContractError("resource_exhausted", "file exceeds output limit"); return { path: guestPath(this.root, path), content }; },
      "fs.write": async (input) => { const i = input as { path: string; content: string; mode?: number }; const path = this.path(i.path); await fs.mkdir(dirname(path), { recursive: true }); await this.existingPath(dirname(path)); try { await this.existingPath(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await fs.writeFile(path, i.content, { mode: i.mode ?? 0o600 }); return { path: guestPath(this.root, path), bytes: Buffer.byteLength(i.content) }; },
      "fs.mkdir": async (input) => { const i = input as { path: string; parents?: boolean }; await fs.mkdir(this.path(i.path), { recursive: i.parents ?? false }); await this.existingPath(this.path(i.path)); return { path: i.path, created: true }; },
      "fs.remove": async (input) => { const i = input as { path: string; recursive?: boolean }; await this.existingPath(this.path(i.path)); await fs.rm(this.path(i.path), { recursive: i.recursive ?? false, force: false }); return { path: i.path, removed: true }; },
      "browser.click": async (input) => { const i = input as { tab_id: string; x: number; y: number }; this.desktopRuntime.getTab(i.tab_id); return { tab_id: i.tab_id, clicked: true, x: i.x, y: i.y }; },
      "browser.type": async (input) => { const i = input as { tab_id: string; text: string }; this.desktopRuntime.getTab(i.tab_id); return { tab_id: i.tab_id, typed: i.text.length }; },
      "browser.key": async (input) => { const i = input as { tab_id: string; key: string }; this.desktopRuntime.getTab(i.tab_id); return { tab_id: i.tab_id, key: i.key }; },
      "desktop.click": async (input) => ({ ...(input as Record<string, Json>), clicked: true }),
      "desktop.move": async (input) => ({ ...(input as Record<string, Json>), moved: true }),
      "desktop.scroll": async (input) => ({ ...(input as Record<string, Json>), scrolled: true }),
      "desktop.key": async (input) => ({ ...(input as Record<string, Json>), sent: true }),
      "desktop.type": async (input) => ({ ...(input as Record<string, Json>), typed: true }),
      ...this.extraHandlers,
    };
  }

  /** Dispatch one authenticated request. The caller authenticates the channel. */
  async dispatch(request: RequestEnvelope, options: { signal?: AbortSignal } = {}): Promise<ResponseEnvelope> {
    try { validateRequest(request); } catch (error) { return failure(request, error instanceof ContractError ? error : new ContractError("invalid_input", "invalid request")); }
    const handler = this.handlers()[request.operation as OperationId];
    if (!handler) return failure(request, new ContractError("unsupported", `guest operation not implemented: ${request.operation}`));
    const context = { request, operation: request.operation as OperationId, clock: new FixtureClock(this.now()), release_id: "agent-computer-contract-v1" as const, signal: options.signal, cancelled: () => options.signal?.aborted === true, assertActive: () => { if (options.signal?.aborted) throw new ContractError("operation_cancelled", "operation cancelled"); } } as DispatchContext;
    if (catalogById.get(request.operation as OperationId)?.mutation) {
      // Re-run the handler through the journal with the full envelope.
      await this.loadJournal();
      const prior = request.mutation_id ? this.journal.get(this.journalKey(request)) : undefined;
      if (prior) return prior.response;
    }
    try {
      const result = await handler(request.input, context);
      const response = success(request, result);
      if (request.mutation_id) { this.journal.set(this.journalKey(request), { mutation_id: request.mutation_id, operation: request.operation, response, recorded_at: this.now(), key: this.journalKey(request) }); await this.saveJournal(); }
      return response;
    } catch (error) { return failure(request, error instanceof ContractError ? error : new ContractError("internal", error instanceof Error ? error.message : "guest operation failed")); }
  }
}

function guestPath(root: string, absolute: string): string { const rel = relative(root, absolute); return rel ? `/${rel.split(sep).join("/")}` : "/"; }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function killTree(child: ChildProcess): void { if (!child.pid) return; try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* exited */ } } }

function guestAddress(): string | null {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) if (!address.internal && address.family === "IPv4") return address.address;
  }
  return null;
}

export { GuestService, runGuestService, type GuestServiceOptions } from "./service.js";
