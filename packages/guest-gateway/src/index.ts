import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import {
  ContractError, failure, capResult, OUTPUT_CAP_BYTES, RELEASE_ID, type Json, type OperationId, success, type RequestEnvelope,
  type ResponseEnvelope, catalogById, operationCatalog, validateRequest,
} from "../../contract/src/index.js";
import { FixtureClock, type DispatchContext, type Handler, type HandlerRegistry } from "../../runtime/src/index.js";
import { DesktopRuntime, desktopHandlers } from "../../desktop/src/index.js";

export interface GuestGatewayOptions {
  root: string;
  shell?: string;
  maxOutputBytes?: number;
  maxCommandBytes?: number;
  /** One file per mutation, so recording a result never rewrites the others. */
  journalDirectory?: string;
  /** How long a mutation's result stays replayable; matches the relay's request retention. */
  journalRetentionMs?: number;
  now?: () => number;
  jobLogDirectory?: string;
  jobLogBytes?: number;
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
type JobStatus = "running" | "completed" | "failed" | "cancelled";
/** `droppedBytes` counts output discarded from the front of the ring-buffered log, so offsets stay absolute. */
interface JobRecord { job_id: string; child: ChildProcess; logPath: string; status: JobStatus; exit_code: number | null; signal: string | null; done: Promise<void>; resolveDone: () => void; droppedBytes: number; writes: Promise<void>; }
export interface MutationJournalEntry { mutation_id: string; operation: string; response: ResponseEnvelope; recorded_at: number; key: string; }

/** Guest-side operation handlers. All filesystem paths are rooted below `root`. */
export class GuestGateway {
  readonly root: string;
  readonly shell: string;
  readonly maxOutputBytes: number;
  readonly maxCommandBytes: number;
  private readonly journalDirectory: string;
  private readonly journalRetentionMs: number;
  private lastJournalSweep = 0;
  /** Mutations still running, so a replay that arrives mid-run joins it instead of running again. */
  private readonly inFlight = new Map<string, Promise<ResponseEnvelope>>();
  private readonly now: () => number;
  private readonly desktopRuntime: DesktopRuntime;
  private readonly extraHandlers: HandlerRegistry;
  private readonly jobLogDirectory: string;
  private readonly jobLogBytes: number;
  private readonly jobs = new Map<string, JobRecord>();

  constructor(options: GuestGatewayOptions) {
    if (!isAbsolute(options.root)) throw new TypeError("guest root must be absolute");
    this.root = (() => { const root = resolve(options.root); try { return realpathSync(root); } catch { return root; } })();
    this.shell = options.shell ?? "/bin/sh";
    // Payloads leave room for the envelope so a full page never has to be trimmed again by capResult.
    this.maxOutputBytes = options.maxOutputBytes ?? OUTPUT_CAP_BYTES - 16 * 1024;
    this.maxCommandBytes = options.maxCommandBytes ?? 64 * 1024;
    this.journalDirectory = options.journalDirectory ?? resolve(this.root, ".localbox/mutations");
    this.journalRetentionMs = options.journalRetentionMs ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
    this.desktopRuntime = options.desktopRuntime ?? new DesktopRuntime();
    this.extraHandlers = options.extraHandlers ?? {};
    this.jobLogDirectory = options.jobLogDirectory ?? resolve(this.root, ".localbox/jobs");
    this.jobLogBytes = options.jobLogBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.jobLogBytes) || this.jobLogBytes < 1) throw new TypeError("jobLogBytes must be a positive integer");
  }

  private journalFile(key: string): string { return resolve(this.journalDirectory, `${createHash("sha256").update(key).digest("hex")}.json`); }
  private async journalEntry(key: string): Promise<MutationJournalEntry | undefined> {
    let entry: MutationJournalEntry;
    try { entry = JSON.parse(await fs.readFile(this.journalFile(key), "utf8")) as MutationJournalEntry; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    return entry.key === key && this.now() - entry.recorded_at < this.journalRetentionMs ? entry : undefined;
  }
  private async recordJournal(entry: MutationJournalEntry): Promise<void> {
    await fs.mkdir(this.journalDirectory, { recursive: true, mode: 0o700 });
    const target = this.journalFile(entry.key);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(entry), { mode: 0o600 });
    await fs.rename(temp, target);
    // The result is recorded; a failed sweep must not turn an applied mutation into an error.
    await this.sweepJournal().catch(() => undefined);
  }
  /** Drop expired results, at most once an hour, so the journal stays bounded by retention. */
  private async sweepJournal(): Promise<void> {
    const now = this.now();
    if (now - this.lastJournalSweep < 60 * 60 * 1000) return;
    this.lastJournalSweep = now;
    for (const name of await fs.readdir(this.journalDirectory)) {
      const file = resolve(this.journalDirectory, name);
      try { if (now - (await fs.stat(file)).mtimeMs >= this.journalRetentionMs) await fs.rm(file, { force: true }); } catch { /* removed concurrently */ }
    }
  }
  private path(input: unknown): string {
    if (typeof input !== "string" || !input.length) throw new ContractError("invalid_input", "path must be a non-empty string");
    const candidate = resolve(this.root, input.startsWith("/") ? `.${input}` : input);
    const rel = relative(this.root, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ContractError("forbidden", "guest path escapes the VM filesystem");
    return candidate;
  }
  private journalKey(request: RequestEnvelope): string { return `${request.sandbox_id}:${request.operation}:${request.mutation_id ?? ""}`; }
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

  private async shellExec(input: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; background?: boolean }, context: DispatchContext): Promise<Json> {
    const command = input.command;
    const args = input.args ?? [];
    if (Buffer.byteLength(command) + args.reduce((n, x) => n + Buffer.byteLength(x), 0) > this.maxCommandBytes) throw new ContractError("resource_exhausted", "command exceeds input limit");
    const cwd = input.cwd ? await this.existingPath(this.path(input.cwd)) : this.root;
    const started = this.now();
    if (input.background) return this.startJob(input, cwd);
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
      const finish = (error?: ContractError, signal: NodeJS.Signals | null = null) => {
        if (settled) return; settled = true; clearTimeout(timeout); context.signal?.removeEventListener("abort", abort);
        if (error) { reject(error); return; }
        resolveResult({ exit_code: child.exitCode, signal, stdout: stdout.toString(), stderr: stderr.toString(), truncated, duration_ms: Math.max(0, this.now() - started) });
      };
      child.once("error", (error) => finish(new ContractError("internal", error.message)));
      child.once("close", (_code, signal) => finish(undefined, signal));
    });
  }

  private async startJob(input: { command: string; args?: string[]; env?: Record<string, string> }, cwd: string): Promise<Json> {
    await fs.mkdir(this.jobLogDirectory, { recursive: true });
    const jobId = `job_${randomUUID()}`;
    const logPath = resolve(this.jobLogDirectory, `${jobId}.log`);
    await fs.writeFile(logPath, "", { mode: 0o600 });
    const child = spawn(this.shell, ["-c", `${input.command}${(input.args ?? []).length ? ` ${(input.args ?? []).map(shellQuote).join(" ")}` : ""}`], { cwd, env: { ...process.env, ...(input.env ?? {}) }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const record: JobRecord = { job_id: jobId, child, logPath, status: "running", exit_code: null, signal: null, done, resolveDone, droppedBytes: 0, writes: Promise.resolve() };
    this.jobs.set(jobId, record);
    // Appends are serialized so trimming never races a concurrent write.
    const append = (chunk: Buffer) => { record.writes = record.writes.then(async () => {
      await fs.appendFile(logPath, chunk);
      const size = (await fs.stat(logPath)).size;
      if (size <= this.jobLogBytes) return;
      // Trim to half the cap, so a chatty job rewrites the log once per half-cap of output, not once per chunk.
      const kept = Math.floor(this.jobLogBytes / 2);
      const keep = Buffer.alloc(kept); const handle = await fs.open(logPath, "r");
      try { await handle.read(keep, 0, keep.length, size - kept); } finally { await handle.close(); }
      await fs.writeFile(logPath, keep); record.droppedBytes += size - kept;
    }); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", () => { record.status = "failed"; record.resolveDone(); });
    child.once("close", (code, signal) => { void record.writes.then(() => { record.exit_code = code; record.signal = signal; record.status = signal === "SIGKILL" || signal === "SIGTERM" ? "cancelled" : code === 0 ? "completed" : "failed"; record.resolveDone(); }); });
    return { job_id: jobId };
  }
  private job(input: Json): JobRecord {
    const id = (input as { job_id?: unknown }).job_id;
    const record = typeof id === "string" ? this.jobs.get(id) : undefined;
    if (!record) throw new ContractError("invalid_input", "unknown job");
    return record;
  }
  private async jobOutput(input: { job_id: string; offset?: number; length?: number }): Promise<Json> {
    const record = this.job(input); await record.writes;
    const requested = input.offset ?? 0; const length = input.length ?? this.maxOutputBytes;
    if (!Number.isSafeInteger(requested) || requested < 0 || !Number.isSafeInteger(length) || length < 1) throw new ContractError("invalid_input", "offset must be a non-negative integer and length a positive integer");
    const offset = Math.max(requested, record.droppedBytes); const total = record.droppedBytes + (await fs.stat(record.logPath)).size;
    const end = Math.min(total, offset + length); const data = Buffer.alloc(Math.max(0, end - offset)); const handle = await fs.open(record.logPath, "r");
    try { await handle.read(data, 0, data.length, offset - record.droppedBytes); } finally { await handle.close(); }
    return { job_id: record.job_id, data: data.toString("utf8"), offset, next_offset: end, eof: end >= total && record.status !== "running", ...(requested < record.droppedBytes ? { dropped_bytes: record.droppedBytes } : {}) };
  }

  handlers(): Partial<Record<OperationId, Handler>> {
    const desktop = desktopHandlers(this.desktopRuntime) as unknown as Partial<Record<OperationId, Handler>>;
    return {
      ...desktop,
      "system.info": async (_input, context) => ({ sandbox_id: context.request.sandbox_id, root: "/", gateway: "guest", capabilities: operationCatalog.map((entry) => entry.id) }),
      "network.egress": async () => ({ connected: true, address: guestAddress(), source: "guest" }),
      "job.status": async (input) => { const j = this.job(input); return { job_id: j.job_id, status: j.status, exit_code: j.exit_code, signal: j.signal }; },
      "job.wait": async (input, context) => {
        const i = input as { job_id: string; timeout_ms?: number }; const j = this.job(i);
        // Without timeout_ms, wait as long as the request may run, leaving room to answer before its deadline.
        const waitMs = Math.min(i.timeout_ms ?? Infinity, Math.max(0, context.request.deadline_ms - 1_000));
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([j.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]); } finally { clearTimeout(timer); }
        return { job_id: j.job_id, status: j.status, exit_code: j.exit_code, signal: j.signal }; },
      "job.cancel": async (input) => { const j = this.job(input); if (j.status === "running" && j.child.pid) killTree(j.child); return { job_id: j.job_id, cancelled: true }; },
      "job.output": async (input) => this.jobOutput(input as { job_id: string; offset?: number; length?: number }),
      "guest.activity": async () => ({ running_jobs: [...this.jobs.values()].filter((job) => job.status === "running").length }),
      "shell.exec": (input, context) => this.shellExec(input as { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; background?: boolean }, context),
      "fs.list": async (input) => { const path = await this.existingPath(this.path((input as { path: string }).path)); const entries = await fs.readdir(path, { withFileTypes: true }); return { path: guestPath(this.root, path), entries: entries.map((e) => ({ name: e.name, kind: e.isDirectory() ? "directory" : e.isFile() ? "file" : "other" })) }; },
      "fs.stat": async (input) => { const path = this.path((input as { path: string }).path); try { await this.existingPath(path); const stat = await fs.stat(path); return { path: guestPath(this.root, path), exists: true, kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other", size: stat.size, mode: stat.mode & 0o777, modified_ms: stat.mtimeMs }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: guestPath(this.root, path), exists: false } as Json; throw error; } },
      "fs.read": async (input) => { const i = input as { path: string; offset?: number; length?: number }; const path = await this.existingPath(this.path(i.path)); const stat = await fs.stat(path); const offset = i.offset ?? 0; const length = i.length ?? this.maxOutputBytes; const end = Math.min(stat.size, offset + length); const handle = await fs.open(path, "r"); try { const data = Buffer.alloc(Math.max(0, end - offset)); await handle.read(data, 0, data.length, offset); return { path: guestPath(this.root, path), content: data.toString("utf8"), offset, next_offset: end, eof: end >= stat.size, ...(offset === 0 && end < stat.size ? { truncated: { original_bytes: stat.size, returned_bytes: data.byteLength } } : {}) }; } finally { await handle.close(); } },
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
    const context = { request, operation: request.operation as OperationId, clock: new FixtureClock(this.now()), release_id: RELEASE_ID, signal: options.signal, cancelled: () => options.signal?.aborted === true, assertActive: () => { if (options.signal?.aborted) throw new ContractError("operation_cancelled", "operation cancelled"); } } as DispatchContext;
    const key = request.mutation_id && catalogById.get(request.operation as OperationId)?.mutation ? this.journalKey(request) : undefined;
    if (!key) return this.run(handler, request, context);
    const running = this.inFlight.get(key);
    if (running) return running;
    const replay = (async () => {
      const prior = await this.journalEntry(key);
      if (prior) return prior.response;
      const response = await this.run(handler, request, context);
      if (response.ok) await this.recordJournal({ mutation_id: request.mutation_id!, operation: request.operation, response, recorded_at: this.now(), key });
      return response;
    })();
    this.inFlight.set(key, replay);
    try { return await replay; } finally { this.inFlight.delete(key); }
  }

  private async run(handler: Handler, request: RequestEnvelope, context: DispatchContext): Promise<ResponseEnvelope> {
    try {
      const result = await handler(request.input, context);
      const capped = capResult(result);
      return success(request, capped.truncated && capped.result && typeof capped.result === "object" && !Array.isArray(capped.result) ? ({ ...(capped.result as Record<string, Json>), truncated: capped.truncated } as unknown as Json) : capped.result);
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
