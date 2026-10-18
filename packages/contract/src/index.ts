/** Versioned operation contract shared by every adapter. */
export const PROTOCOL_VERSION = "v1" as const;
export const RELEASE_ID = "localbox-contract-v1" as const;

export const operationIds = [
  "account.status", "account.rename", "machine.list", "machine.rename", "machine.remove",
  "sandbox.create", "sandbox.list", "sandbox.rename", "sandbox.delete",
  "system.info", "sandbox.status", "sandbox.resize", "sandbox.start", "sandbox.stop", "sandbox.sleep", "sandbox.logs",
  "network.egress", "relay.status", "shell.exec", "job.status", "job.wait", "job.cancel", "job.output", "guest.activity",
  "fs.list", "fs.stat", "fs.read", "fs.write", "fs.mkdir", "fs.remove",
  "browser.list_tabs", "browser.open", "browser.navigate", "browser.focus", "browser.close", "browser.screenshot",
  "browser.click", "browser.type", "browser.key", "desktop.status", "desktop.screenshot", "desktop.click",
  "desktop.move", "desktop.scroll", "desktop.key", "desktop.type",
  "skill.status", "skill.install", "skill.update", "skill.uninstall", "cli.status", "agents.setup.status", "agents.setup.set"
] as const;
export type OperationId = typeof operationIds[number];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: Json[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export const ERROR_CODES = [
  "invalid_input", "unauthorized", "forbidden", "sandbox_not_found", "sandbox_not_ready", "sandbox_ambiguous", "name_conflict",
  "guest_unreachable", "operation_timeout", "operation_cancelled", "operation_uncertain",
  "conflict", "rate_limited", "resource_exhausted", "host_denied", "unsupported", "internal",
  "machine_offline", "machine_not_found", "machine_full",
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

export type Idempotency = "none" | "optional" | "required";
export interface OperationLimits {
  deadline_ms: { min: number; max: number };
  max_input_bytes: number;
  max_output_bytes: number;
}
export interface OperationCatalogEntry {
  id: OperationId;
  description: string;
  input_schema: JsonSchema;
  retryable: boolean;
  mutation: boolean;
  idempotency: Idempotency;
  limits: OperationLimits;
  executor: "account" | "host" | "guest";
  /** Whether the request names one sandbox (`sandbox_id` set) or none (`sandbox_id: null`). */
  sandbox_scoped: boolean;
}

const empty = (): JsonSchema => ({ type: "object", properties: {}, additionalProperties: false });
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object", properties, required, additionalProperties: false
});
const string = (minLength = 1): JsonSchema => ({ type: "string", minLength });
const integer = (): JsonSchema => ({ type: "integer" });
const bool = (): JsonSchema => ({ type: "boolean" });
const number = (): JsonSchema => ({ type: "number" });
const arrayOfStrings = (): JsonSchema => ({ type: "array", items: string(), maxItems: 128 });
export const OUTPUT_CAP_BYTES = 900 * 1024;
const defaultLimits: OperationLimits = { deadline_ms: { min: 1, max: 120_000 }, max_input_bytes: 64 * 1024, max_output_bytes: OUTPUT_CAP_BYTES };

const definitions: Record<OperationId, [string, JsonSchema, boolean, boolean, Idempotency]> = {
  "account.status": ["Show the signed-in account.", empty(), true, false, "none"],
  "account.rename": ["Rename the signed-in account.", object({ name: string() }, ["name"]), false, true, "required"],
  "machine.list": ["List machines in the account.", empty(), true, false, "none"],
  "machine.rename": ["Rename an account machine.", object({ machine_id: string(), name: string() }, ["machine_id", "name"]), false, true, "required"],
  "machine.remove": ["Remove an account machine.", object({ machine_id: string() }, ["machine_id"]), false, true, "required"],
  "sandbox.create": ["Create a sandbox on the machine the request names, else by `placement` (auto takes the online machine with the most room, remote the same without the caller's), else on the caller's own machine; reports where and why, its name and size. It sleeps after `sleep_after_ms` idle (default 30 min) and, only when `delete_after_ms` is given, is deleted after that much idle time.", object({ name: string(), placement: { type: "string", enum: ["auto", "remote"] }, cpus: { type: "integer", minimum: 1, maximum: 64 }, memory_bytes: { type: "integer", minimum: 1024 * 1024 * 1024 }, sleep_after_ms: { type: "integer", minimum: 1000 }, delete_after_ms: { type: "integer", minimum: 1000 } }), false, true, "required"],
  "sandbox.list": ["List the account's sandboxes with their machine and last reported state.", empty(), true, false, "none"],
  "sandbox.rename": ["Rename a sandbox.", object({ name: string() }, ["name"]), false, true, "required"],
  "sandbox.delete": ["Delete a sandbox; `confirm`, when given, must be its name.", object({ confirm: string() }), false, true, "required"],
  "system.info": ["Describe the contract and runtime.", empty(), false, false, "none"],
  "sandbox.status": ["Read a sandbox's state and size.", empty(), true, false, "none"],
  "sandbox.resize": ["Change a sandbox's CPUs or memory.", object({ cpus: { type: "integer", minimum: 1, maximum: 64 }, memory_bytes: { type: "integer", minimum: 1024 * 1024 * 1024 } }), false, true, "required"],
  "sandbox.start": ["Start or wake a sandbox.", empty(), false, true, "required"],
  "sandbox.stop": ["Stop a sandbox.", empty(), false, true, "required"],
  "sandbox.sleep": ["Put a sandbox to sleep.", empty(), false, true, "required"],
  "sandbox.logs": ["Read recent sandbox logs.", object({ limit: { type: "integer", minimum: 1, maximum: 1000 } }), true, false, "none"],
  "network.egress": ["Inspect guest egress identity.", empty(), true, false, "none"],
  "relay.status": ["Read relay connectivity status.", empty(), true, false, "none"],
  "shell.exec": ["Execute a command in the guest shell.", object({ command: string(), args: arrayOfStrings(), cwd: string(), env: { type: "object", additionalProperties: true }, background: bool() }, ["command"]), false, true, "required"],
  "job.status": ["Read an asynchronous job status.", object({ job_id: string() }, ["job_id"]), true, false, "none"],
  "job.wait": ["Wait for an asynchronous job.", object({ job_id: string(), timeout_ms: { type: "integer", minimum: 1, maximum: 120_000 } }, ["job_id"]), true, false, "none"],
  "job.cancel": ["Cancel an asynchronous job.", object({ job_id: string() }, ["job_id"]), false, true, "required"],
  "job.output": ["Read asynchronous job output.", object({ job_id: string(), offset: integer(), length: { type: "integer", minimum: 1 } }, ["job_id"]), true, false, "none"],
  "guest.activity": ["Read guest activity.", empty(), true, false, "none"],
  "fs.list": ["List guest directory entries.", object({ path: string() }, ["path"]), true, false, "none"],
  "fs.stat": ["Read guest file metadata.", object({ path: string() }, ["path"]), true, false, "none"],
  "fs.read": ["Read guest file contents.", object({ path: string(), offset: integer(), length: { type: "integer", minimum: 1 } }, ["path"]), true, false, "none"],
  "fs.write": ["Write guest file contents.", object({ path: string(), content: { type: "string" }, mode: { type: "integer", minimum: 0, maximum: 0o777 } }, ["path", "content"]), false, true, "required"],
  "fs.mkdir": ["Create a guest directory.", object({ path: string(), parents: bool() }, ["path"]), false, true, "required"],
  "fs.remove": ["Remove a guest path.", object({ path: string(), recursive: bool() }, ["path"]), false, true, "required"],
  "browser.list_tabs": ["List browser tabs.", empty(), true, false, "none"],
  "browser.open": ["Open a browser tab.", object({ url: string() }, ["url"]), false, true, "required"],
  "browser.navigate": ["Navigate a browser tab.", object({ tab_id: string(), url: string() }, ["tab_id", "url"]), false, true, "required"],
  "browser.focus": ["Focus a browser tab.", object({ tab_id: string() }, ["tab_id"]), false, true, "required"],
  "browser.close": ["Close a browser tab.", object({ tab_id: string() }, ["tab_id"]), false, true, "required"],
  "browser.screenshot": ["Capture a browser tab screenshot.", object({ tab_id: string() }, ["tab_id"]), true, false, "none"],
  "browser.click": ["Click in a browser tab.", object({ tab_id: string(), x: number(), y: number() }, ["tab_id", "x", "y"]), false, true, "required"],
  "browser.type": ["Type into a browser tab.", object({ tab_id: string(), text: { type: "string" } }, ["tab_id", "text"]), false, true, "required"],
  "browser.key": ["Send a key to a browser tab.", object({ tab_id: string(), key: string() }, ["tab_id", "key"]), false, true, "required"],
  "desktop.status": ["Read desktop status.", empty(), true, false, "none"],
  "desktop.screenshot": ["Capture the desktop.", empty(), true, false, "none"],
  "desktop.click": ["Click on the desktop.", object({ x: number(), y: number(), button: string() }, ["x", "y"]), false, true, "required"],
  "desktop.move": ["Move the desktop pointer.", object({ x: number(), y: number() }, ["x", "y"]), false, true, "required"],
  "desktop.scroll": ["Scroll the desktop.", object({ x: number(), y: number(), delta_y: number(), delta_x: number() }, ["x", "y", "delta_y"]), false, true, "required"],
  "desktop.key": ["Send a key to the desktop.", object({ key: string() }, ["key"]), false, true, "required"],
  "desktop.type": ["Type into the desktop.", object({ text: { type: "string" } }, ["text"]), false, true, "required"],
  "skill.status": ["Read this Mac's global Localbox skill: its state, whether Localbox maintains it, the release that wrote it (`source_revision`), its ownership receipt and every agent harness path.", empty(), true, false, "none"],
  "skill.install": ["Install this release's Localbox skill for every agent harness on this Mac, replacing any global copy; a copy Localbox did not write is backed up first and the result names the backup.", empty(), false, true, "required"],
  "skill.update": ["Reinstall this release's Localbox skill for every agent harness on this Mac, exactly as skill.install does.", empty(), false, true, "required"],
  "skill.uninstall": ["Remove the global Localbox skill Localbox installed on this Mac. While agent setup is on, the next reconcile (the daemon's next start) installs it again.", empty(), false, true, "required"],
  "cli.status": ["Read this Mac's `localbox` command link (`~/.local/bin/localbox`) and the installed release it should point at.", empty(), true, false, "none"],
  "agents.setup.status": ["Read the agent setup setting. While it is on (the default), Localbox keeps the global skill and the `localbox` link matched to the installed release, at install and at every daemon start.", empty(), true, false, "none"],
  "agents.setup.set": ["Turn agent setup on or off. While it is off, Localbox leaves the global skill and the `localbox` link alone, so they can be customised.", object({ enabled: bool() }, ["enabled"]), false, true, "required"]
};

/** Catalog-level sandbox operations: they change the account catalog in Convex, then tell the machine. */
const ACCOUNT_SANDBOX_OPERATIONS: readonly string[] = ["sandbox.create", "sandbox.list", "sandbox.rename", "sandbox.delete"];
/** Agent setup: the skill and the `localbox` link on one Mac. The CLI runs them; HostDaemon relays remote callers to it. */
export const AGENT_SETUP_OPERATIONS: readonly OperationId[] = ["skill.status", "skill.install", "skill.update", "skill.uninstall", "cli.status", "agents.setup.status", "agents.setup.set"];
const HOST_OPERATIONS: readonly string[] = ["sandbox.status", "sandbox.resize", "sandbox.start", "sandbox.stop", "sandbox.sleep", "sandbox.logs", "system.info", "relay.status", ...AGENT_SETUP_OPERATIONS];
function executorOf(id: OperationId): OperationCatalogEntry["executor"] {
  if (id.startsWith("account.") || id.startsWith("machine.") || ACCOUNT_SANDBOX_OPERATIONS.includes(id)) return "account";
  return HOST_OPERATIONS.includes(id) ? "host" : "guest";
}
/** Account, machine, create, list, relay status and agent setup name no sandbox; everything else acts on exactly one. */
const sandboxScoped = (id: OperationId) => !id.startsWith("account.") && !id.startsWith("machine.") && id !== "sandbox.create" && id !== "sandbox.list" && id !== "relay.status" && !AGENT_SETUP_OPERATIONS.includes(id);

export const operationCatalog: OperationCatalogEntry[] = operationIds.map((id) => {
  const [description, input_schema, retryable, mutation, idempotency] = definitions[id];
  return { id, description, input_schema, retryable, mutation, idempotency, limits: defaultLimits, executor: executorOf(id), sandbox_scoped: sandboxScoped(id) };
});
export const catalogById = new Map(operationCatalog.map((entry) => [entry.id, entry]));

export interface RequestEnvelope<T extends Json = Json> {
  protocol_version: typeof PROTOCOL_VERSION;
  request_id: string;
  operation: OperationId | string;
  sandbox_id: string | null;
  /** The machine the request is for (a name or id), when the caller names one; the agent API resolves it and never relays it. */
  machine?: string;
  deadline_ms: number;
  mutation_id: string | null;
  input: T;
}
/** Transport-neutral input accepted by CLI, MCP, and future adapters. */
export interface Invocation<T extends Json = Json> {
  operation: OperationId | string;
  sandbox_id?: string | null;
  machine?: string;
  deadline_ms?: number;
  mutation_id?: string | null;
  request_id?: string;
  input: T;
}
export function requestFromInvocation<T extends Json>(invocation: Invocation<T>, defaults: { request_id?: string; deadline_ms?: number } = {}): RequestEnvelope<T> {
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: invocation.request_id ?? defaults.request_id ?? "request-1",
    operation: invocation.operation,
    sandbox_id: invocation.sandbox_id ?? null,
    ...(invocation.machine ? { machine: invocation.machine } : {}),
    deadline_ms: invocation.deadline_ms ?? defaults.deadline_ms ?? 30_000,
    mutation_id: invocation.mutation_id ?? null,
    input: invocation.input,
  };
}
export interface EnvelopeIdentity {
  protocol_version: typeof PROTOCOL_VERSION;
  request_id: string;
  operation: string;
  sandbox_id: string | null;
  release_id: typeof RELEASE_ID;
}
/**
 * What HostDaemon did for a request on the way (a wake, a boot no request asked for) is prepended to `result.actions`
 * when the result is an object; otherwise (an error, a non-object result) it travels as `host_actions`.
 */
export interface SuccessEnvelope<T extends Json = Json> extends EnvelopeIdentity {
  ok: true;
  result: T;
  host_actions?: ActionReport["actions"];
}
export interface ErrorBody { code: ErrorCode; message: string; retryable: boolean; details?: Json }
export interface ErrorEnvelope extends EnvelopeIdentity { ok: false; error: ErrorBody; host_actions?: ActionReport["actions"] }
export type ResponseEnvelope<T extends Json = Json> = SuccessEnvelope<T> | ErrorEnvelope;

export class ContractError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: Json, public readonly retryable = false) { super(message); this.name = "ContractError"; }
}

function pathFor(path: string, key: string): string { return path ? `${path}.${key}` : key; }
export function validateJson(value: unknown, schema: JsonSchema, path = "input"): asserts value is Json {
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) throw new ContractError("invalid_input", `${path} must be one of the allowed values`);
  if (schema.type === "null" && value !== null) throw new ContractError("invalid_input", `${path} must be null`);
  if (schema.type === "string") {
    if (typeof value !== "string") throw new ContractError("invalid_input", `${path} must be a string`);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new ContractError("invalid_input", `${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new ContractError("invalid_input", `${path} is too long`);
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) throw new ContractError("invalid_input", `${path} must be a ${schema.type}`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new ContractError("invalid_input", `${path} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new ContractError("invalid_input", `${path} is above maximum`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") throw new ContractError("invalid_input", `${path} must be a boolean`);
  else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new ContractError("invalid_input", `${path} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new ContractError("invalid_input", `${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new ContractError("invalid_input", `${path} has too many items`);
    if (schema.items) value.forEach((item, i) => validateJson(item, schema.items!, `${path}[${i}]`));
  } else if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ContractError("invalid_input", `${path} must be an object`);
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) throw new ContractError("invalid_input", `${pathFor(path, key)} is required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(record)) if (!Object.hasOwn(schema.properties ?? {}, key)) throw new ContractError("invalid_input", `${pathFor(path, key)} is not allowed`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(record, key)) validateJson(record[key], child, pathFor(path, key));
  }
}

export function validateRequest(request: unknown): asserts request is RequestEnvelope {
  if (typeof request !== "object" || request === null || Array.isArray(request)) throw new ContractError("invalid_input", "request must be an object");
  const r = request as Record<string, unknown>;
  if (r.protocol_version !== PROTOCOL_VERSION) throw new ContractError("invalid_input", `protocol_version must be ${PROTOCOL_VERSION}`);
  for (const key of ["request_id", "operation"] as const) if (typeof r[key] !== "string" || !(r[key] as string).length) throw new ContractError("invalid_input", `${key} must be a non-empty string`);
  if (typeof r.deadline_ms !== "number" || !Number.isInteger(r.deadline_ms) || r.deadline_ms < 1 || r.deadline_ms > 120_000) throw new ContractError("invalid_input", "deadline_ms must be an integer between 1 and 120000");
  if (r.mutation_id !== null && (typeof r.mutation_id !== "string" || !r.mutation_id.length)) throw new ContractError("invalid_input", "mutation_id must be a non-empty string or null");
  const entry = catalogById.get(r.operation as OperationId);
  if (!entry) throw new ContractError("invalid_input", `unknown operation: ${String(r.operation)}`);
  if (entry.sandbox_scoped && (typeof r.sandbox_id !== "string" || !r.sandbox_id.length)) throw new ContractError("invalid_input", `${entry.id} needs a sandbox_id`);
  if (!entry.sandbox_scoped && r.sandbox_id !== null) throw new ContractError("invalid_input", `${entry.id} takes no sandbox; sandbox_id must be null`);
  validateJson(r.input, entry.input_schema);
  if (entry.idempotency === "required" && r.mutation_id === null) throw new ContractError("invalid_input", `${entry.id} requires mutation_id`);
}

export function identityFromRequest(request: RequestEnvelope): EnvelopeIdentity { return { protocol_version: PROTOCOL_VERSION, request_id: request.request_id, operation: request.operation, sandbox_id: request.sandbox_id ?? null, release_id: RELEASE_ID }; }
export function success<T extends Json>(request: RequestEnvelope, result: T): SuccessEnvelope<T> { return { ...identityFromRequest(request), ok: true, result }; }
export function failure(request: RequestEnvelope, error: ContractError | ErrorBody): ErrorEnvelope {
  const body: ErrorBody = error instanceof ContractError ? { code: error.code, message: error.message, retryable: error.retryable, ...(error.details === undefined ? {} : { details: error.details }) } : error;
  return { ...identityFromRequest(request), ok: false, error: body };
}

export interface ResultTruncation { original_bytes: number; returned_bytes: number }
export interface CappedResult<T extends Json = Json> { result: T; truncated?: ResultTruncation }

/** Bound a produced JSON result while keeping the value valid JSON and UTF-8. */
export function capResult<T extends Json>(value: T, cap = OUTPUT_CAP_BYTES): CappedResult {
  const encoded = Buffer.from(JSON.stringify(value) ?? "null", "utf8");
  if (encoded.byteLength <= cap) return { result: value };
  if (typeof value === "string") {
    const bytes = utf8Prefix(encoded, cap);
    const result = bytes.toString("utf8");
    return { result, truncated: { original_bytes: encoded.byteLength, returned_bytes: Buffer.byteLength(result) } };
  }
  // Produced operation results are objects. Trim string fields until the JSON
  // envelope fits; this preserves the operation's shape and metadata.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const copy = { ...(value as Record<string, Json>) };
    const strings = Object.entries(copy).filter(([, item]) => typeof item === "string").sort((a, b) => Buffer.byteLength(b[1] as string) - Buffer.byteLength(a[1] as string));
    for (const [key, item] of strings) {
      const current = Buffer.byteLength(JSON.stringify(copy));
      const room = Math.max(0, cap - current + Buffer.byteLength(item as string));
      copy[key] = utf8Prefix(Buffer.from(item as string), room).toString("utf8");
      if (Buffer.byteLength(JSON.stringify(copy)) <= cap) break;
    }
    const result = copy as Json;
    return { result, truncated: { original_bytes: encoded.byteLength, returned_bytes: Buffer.byteLength(JSON.stringify(result)) } };
  }
  const result = utf8Prefix(encoded, cap).toString("utf8") as Json;
  return { result, truncated: { original_bytes: encoded.byteLength, returned_bytes: Buffer.byteLength(JSON.stringify(result)) } };
}

function utf8Prefix(value: Uint8Array, limit: number): Buffer {
  let end = Math.min(value.byteLength, Math.max(0, limit));
  while (end > 0 && (value[end] & 0xc0) === 0x80) end -= 1;
  return Buffer.from(value.subarray(0, end));
}

export interface HelpSnapshotEntry { id: OperationId; description: string; retryable: boolean; mutation: boolean; idempotency: Idempotency; input_schema: JsonSchema; executor: "account" | "host" | "guest"; sandbox_scoped: boolean; }
export function helpSnapshot(): HelpSnapshotEntry[] { return operationCatalog.map(({ limits: _limits, ...entry }) => entry); }
export function catalogSnapshot(): OperationCatalogEntry[] { return JSON.parse(JSON.stringify(operationCatalog)) as OperationCatalogEntry[]; }

/** What a request did: what was asked, what resulted, and every side effect taken on the way. */
export type ActionKind = "slept" | "woke" | "made_room" | "restarted" | "cold_booted" | "truncated" | "created" | "deleted" | "renamed"
  | "installed" | "replaced" | "reinstalled" | "uninstalled" | "linked" | "left_alone" | "turned_on" | "turned_off" | "failed";
export interface ActionReport { requested: Json; produced: Json; actions: Array<{ kind: ActionKind; detail?: string; [key: string]: Json | undefined }> }

/**
 * What a machine can still take, as its daemon reports it through `host.watch` and its connector stores on the
 * machine row. `room_bytes` is reservation-based: the daemon's admission budget minus what running sandboxes reserve,
 * not live free memory. `revision` changes only when the reservation does, so the connector writes it only then.
 */
export interface CapacityReport { cpus: number; total_bytes: number; reserved_bytes: number; room_bytes: number; running: number; revision: number }

const GIB = 1024 ** 3;
/** A size for a report, e.g. "2 GiB" or "1.5 GiB". */
export const gibibytes = (bytes: number) => `${Math.round(bytes / GIB * 10) / 10} GiB`;
/** The smallest size `defaultSize` gives; placement asks for room for this much when a create names no memory. */
export const DEFAULT_SIZE_MINIMUM = { cpus: 2, memory_bytes: 2 * GIB } as const;
/** A new sandbox's size when its create asks for none: half the host's cores and a quarter of its RAM in whole GiB, at least `DEFAULT_SIZE_MINIMUM`. */
export function defaultSize(hostCpus: number, hostMemoryBytes: number): { cpus: number; memory_bytes: number } {
  return { cpus: Math.max(DEFAULT_SIZE_MINIMUM.cpus, Math.floor(hostCpus / 2)), memory_bytes: Math.max(DEFAULT_SIZE_MINIMUM.memory_bytes, Math.floor(hostMemoryBytes / 4 / GIB) * GIB) };
}
/** `defaultSize` in words, for a create report. */
export const defaultSizeReason = (hostCpus: number, hostMemoryBytes: number) => `half its ${hostCpus} CPUs and a quarter of its ${gibibytes(hostMemoryBytes)}, at least ${DEFAULT_SIZE_MINIMUM.cpus} CPUs and ${gibibytes(DEFAULT_SIZE_MINIMUM.memory_bytes)}`;

/** Operations HostDaemon answers itself (the rest go to the guest): the host executor plus the catalog-level sandbox operations it mirrors. */
export function hostOperationIds(): OperationId[] { return operationCatalog.filter((entry) => entry.executor === "host" || entry.id.startsWith("sandbox.")).map((entry) => entry.id); }

/** HostDaemon's copy of the contract: its protocol and release ids and the `HostOperation`s it routes. Written by `contract generate-snapshots`. */
export function swiftHostOperations(): string {
  const caseName = (id: string) => id.split(/[._]/).map((part, index) => index === 0 ? part : part[0].toUpperCase() + part.slice(1)).join("");
  return [
    "// Generated by `npm run generate:snapshots` from packages/contract. Do not edit.",
    "",
    `public let protocolVersion = "${PROTOCOL_VERSION}"`,
    `public let releaseID = "${RELEASE_ID}"`,
    "",
    "/// Catalog operations HostDaemon routes itself; the rest go straight to the guest.",
    "public enum HostOperation: String, CaseIterable, Sendable {",
    ...hostOperationIds().map((id) => `    case ${caseName(id)} = "${id}"`),
    "}",
    "",
  ].join("\n");
}
