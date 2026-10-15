import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { hostname } from "node:os";
import {
  catalogById, catalogSnapshot, cliHelpSnapshot, mcpToolsSnapshot, operationCatalog, swiftHostOperations,
  ContractError, failure, PROTOCOL_VERSION, requestFromInvocation, success, validateRequest,
  type Json, type JsonSchema, type OperationCatalogEntry, type OperationId, type RequestEnvelope, type ResponseEnvelope,
} from "../../../packages/contract/src/index.js";
import { FakeDispatcher } from "../../../packages/runtime/src/index.js";
import { AgentClient, fixtureTransport, LocalIPCTransport, RelayHttpTransport, type ClientTransport } from "../../../packages/client/src/index.js";
import { GuestGateway } from "../../../packages/guest-gateway/src/index.js";
import { AgentSetup, isAgentSetupOperation, REASONS, type Reason } from "./agent-setup.js";
import { checkForUpdate, installLatest } from "./updater.js";
import { render } from "./render.js";
import { machinePaths, PUBLIC_API_ORIGIN, PUBLIC_MCP_RESOURCE } from "../../../packages/config/src/index.js";
import { readCredentials, writeCredentials, deleteCredentials, type Credentials } from "../../../packages/credentials/src/index.js";
import { machineName } from "../../../packages/names/src/index.js";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const argv = process.argv.slice(2);
/** Options end at `--`; what follows is a command line (`shell exec -- CMD ...`). */
const head = (argv.indexOf("--") < 0 ? argv : argv.slice(0, argv.indexOf("--"))).filter((word) => word !== "--json");
const tail = argv.indexOf("--") < 0 ? [] : argv.slice(argv.indexOf("--") + 1);
const json = (argv.indexOf("--") < 0 ? argv : argv.slice(0, argv.indexOf("--"))).includes("--json");
/** CLI group names that differ from the catalog prefix. */
const GROUPS: Record<string, string> = { machines: "machine" };
const VERBS: Record<string, string> = { "account.show": "account.status" };
const CONTROL_FLAGS = new Set(["sandbox", "machine", "input-json", "request-id", "mutation-id", "deadline-ms", "memory", "sleep-after", "delete-after"]);
/** Commands that are not catalog operations. */
const LOCAL_COMMANDS: Array<[string, string]> = [
  ["login --email EMAIL [--code CODE]", "Sign this Mac in with an email code"],
  ["logout", "Sign this Mac out and remove it from the account"],
  ["status [--sandbox NAME]", "Show a sandbox's state, the relay and egress"],
  ["invoke OPERATION [--sandbox NAME] [--input-json JSON] [--mutation-id ID]", "Invoke any catalog operation"],
  ["help [OPERATION]", "Show this help, or one operation's schema"],
  ["mcp install", "Print the MCP server config"],
  ["update check|install", "Check for or install the latest release"],
  ["agents reconcile [--reason install|daemon_start|explicit]", "Match the skill and the localbox link to this release (run by the installer and the daemon)"],
  ["agents op OPERATION [--input-json JSON]", "Run one agent setup operation here (HostDaemon's relay for remote callers)"],
  ["connector run", "Run the relay connector (launchd job)"],
  ["contract probe|generate-snapshots", "Inspect the contract or regenerate its snapshots"],
];

function print(value: ResponseEnvelope | Json): void {
  const out = render(value, { json });
  process.stdout.write(out.stdout); process.stderr.write(out.stderr);
  if (out.exitCode) process.exitCode = out.exitCode;
}

/** `--name value` pairs and bare words before `--`; flags the schema types boolean take no value. */
function parse(words: string[], schema?: JsonSchema): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {}; const positional: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (!word.startsWith("--")) { positional.push(word); continue; }
    const key = word.slice(2);
    if (schema?.properties?.[key.replaceAll("-", "_")]?.type === "boolean") { flags[key] = true; continue; }
    const value = words[index + 1];
    if (value === undefined) throw new ContractError("invalid_input", `${word} needs a value`);
    flags[key] = value; index++;
  }
  return { flags, positional };
}

function usage(): string {
  const groups = new Map<string, OperationCatalogEntry[]>();
  for (const entry of operationCatalog) { const prefix = entry.id.split(".")[0]; groups.set(prefix, [...(groups.get(prefix) ?? []), entry]); }
  const cliGroup = (prefix: string) => Object.entries(GROUPS).find(([, value]) => value === prefix)?.[0] ?? prefix;
  const out = ["localbox <command> [options]", "",
    "Operations on one sandbox take --sandbox NAME; leave it out when the account has exactly one sandbox.",
    "--json prints the response envelope; text prints the same facts.", ""];
  for (const [prefix, entries] of groups) {
    out.push(cliGroup(prefix));
    for (const entry of entries) out.push(`  ${commandLine(entry).padEnd(58)} ${entry.description}`);
  }
  out.push("", "other");
  for (const [command, description] of LOCAL_COMMANDS) out.push(`  ${command.padEnd(58)} ${description}`);
  return `${out.join("\n")}\n`;
}

function commandLine(entry: OperationCatalogEntry): string {
  const verb = entry.id.split(".").slice(1).join(" ").replaceAll("_", "-");
  if (entry.id === "agents.setup.set") return "setup on|off";
  const properties = entry.input_schema.properties ?? {}; const required = entry.input_schema.required ?? [];
  const flag = (key: string) => key === "memory_bytes" ? "[--memory 4G]" : key === "sleep_after_ms" ? "[--sleep-after 30m]" : key === "delete_after_ms" ? "[--delete-after 2h]" : properties[key].type === "boolean" ? `[--${key.replaceAll("_", "-")}]` : `[--${key.replaceAll("_", "-")} ${key.toUpperCase()}]`;
  if (entry.id === "shell.exec") return `${verb} [--background] -- COMMAND [ARGS...]`;
  return [verb, ...(entry.sandbox_scoped && entry.id.startsWith("sandbox.") ? ["[SANDBOX]"] : []), ...required.map((key) => key.toUpperCase()), ...Object.keys(properties).filter((key) => !required.includes(key)).map(flag)].join(" ");
}

/** The catalog operation `words` name (`sandbox create`, `agents setup status`, `agents setup on`), the words after it and any input the words imply. */
function catalogEntry(words: string[]): { entry: OperationCatalogEntry; rest: string[]; input: Record<string, Json> } | undefined {
  const [group, verb, third] = words;
  if (!group || !verb || verb.startsWith("-")) return undefined;
  const prefix = GROUPS[group] ?? group;
  if (prefix === "agents" && verb === "setup" && (third === "on" || third === "off")) return { entry: catalogById.get("agents.setup.set")!, rest: words.slice(3), input: { enabled: third === "on" } };
  const three = third && !third.startsWith("-") ? catalogById.get(`${prefix}.${verb}.${third}`.replaceAll("-", "_") as OperationId) : undefined;
  if (three) return { entry: three, rest: words.slice(3), input: {} };
  const entry = catalogById.get((VERBS[`${prefix}.${verb}`] ?? `${prefix}.${verb.replaceAll("-", "_")}`) as OperationId);
  return entry ? { entry, rest: words.slice(2), input: {} } : undefined;
}

/** The non-catalog command `words` start with: every literal word of its LOCAL_COMMANDS row matches. */
function localCommand(words: string[]): [string, string] | undefined {
  return LOCAL_COMMANDS.find(([syntax]) => {
    const literals: string[] = [];
    for (const token of syntax.split(" ")) { if (!/^[a-z][a-z_|-]*$/.test(token)) break; literals.push(token); }
    return literals.every((token, index) => token.split("|").includes(words[index]));
  });
}

function operationHelp(entry: OperationCatalogEntry): Json {
  const { limits: _limits, ...help } = entry;
  return { usage: `localbox ${Object.entries(GROUPS).find(([, value]) => value === entry.id.split(".")[0])?.[0] ?? entry.id.split(".")[0]} ${commandLine(entry)}`, ...help } as unknown as Json;
}

async function writeSnapshots(): Promise<void> {
  await Promise.all([
    writeFile(resolve(root, "snapshots/catalog.json"), `${JSON.stringify(catalogSnapshot(), null, 2)}\n`),
    writeFile(resolve(root, "snapshots/cli-help.json"), `${JSON.stringify(cliHelpSnapshot(), null, 2)}\n`),
    writeFile(resolve(root, "snapshots/mcp-tools.json"), `${JSON.stringify(mcpToolsSnapshot(), null, 2)}\n`),
    writeFile(resolve(root, "apps/macos/HostDaemon/Sources/HostDaemonCore/GeneratedOperations.swift"), swiftHostOperations()),
  ]);
  process.stdout.write("Generated contract snapshots and HostDaemon's operation list.\n");
}

async function localTransport(): Promise<ClientTransport> {
  if (process.env.LOCALBOX_LOCAL_TRANSPORT !== "fixture") return new LocalIPCTransport();
  const guestRoot = resolve(root, ".localbox/guest");
  await mkdir(guestRoot, { recursive: true });
  return fixtureTransport("local", new FakeDispatcher({ handlers: new GuestGateway({ root: guestRoot }).handlers() }));
}

async function signedIn(): Promise<Credentials> {
  const credentials = await readCredentials(machinePaths().credentials);
  if (!credentials) throw new ContractError("unauthorized", "this Mac is not signed in; run localbox login --email you@example.com");
  return credentials;
}
const accountTransport = async () => new RelayHttpTransport({ apiOrigin: PUBLIC_API_ORIGIN, accessToken: (await signedIn()).secret });
/** A create defaults to this Mac only when its daemon answers here; otherwise it needs --machine or --placement. */
async function createTransport(): Promise<ClientTransport> {
  const credentials = await signedIn();
  const daemon = await (await localTransport()).dispatch(call("sandbox.list", {})).catch(() => undefined);
  return new RelayHttpTransport({ apiOrigin: PUBLIC_API_ORIGIN, accessToken: credentials.secret, ...(daemon?.ok ? { callerMachineId: credentials.machine_id } : {}) });
}
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const call = (operation: OperationId, input: Json, sandboxId: string | null = null): RequestEnvelope => requestFromInvocation({ operation, input, sandbox_id: sandboxId, request_id: newId("cli"), mutation_id: catalogById.get(operation)!.idempotency === "required" ? newId("cli") : null });
const rowsOf = (response: ResponseEnvelope) => response.ok ? (response.result as { sandboxes?: Array<{ sandbox_id: string; name: string; machine_id?: string }> }).sandboxes ?? [] : [];

interface Target { sandboxId: string; local: boolean }
/**
 * `--sandbox NAME` against this Mac's daemon first, then the account; omitted, the account's only sandbox (this
 * Mac's only one when not signed in). A sandbox on another machine goes through the agent API, which finds it.
 */
async function target(wanted: string | undefined): Promise<Target> {
  const local = await (await localTransport()).dispatch(call("sandbox.list", {}));
  const here = rowsOf(local);
  const hit = wanted ? here.find((row) => row.name === wanted || row.sandbox_id === wanted) : undefined;
  if (hit) return { sandboxId: hit.sandbox_id, local: true };
  const credentials = await readCredentials(machinePaths().credentials);
  let rows = here;
  if (credentials) {
    const account = await (await accountTransport()).dispatch(call("sandbox.list", {}));
    if (!account.ok) throw new ContractError(account.error.code, account.error.message, account.error.details, account.error.retryable);
    rows = rowsOf(account);
  } else if (!local.ok) throw new ContractError(local.error.code, local.error.message, local.error.details, local.error.retryable);
  const names = rows.map((row) => row.name);
  const row = wanted ? rows.find((candidate) => candidate.name === wanted || candidate.sandbox_id === wanted) : rows.length === 1 ? rows[0] : undefined;
  if (!row && wanted) throw new ContractError("sandbox_not_found", `no sandbox ${wanted}${credentials ? " on this account" : " on this Mac"}; ${names.length ? `sandboxes: ${names.join(", ")}` : "there are none"}`, { names });
  if (!row && !rows.length) throw new ContractError("sandbox_not_found", `no sandboxes yet; create one with localbox sandbox create${credentials ? "" : " (after localbox login)"}`, { names });
  if (!row) throw new ContractError("sandbox_ambiguous", `${rows.length} sandboxes; pass --sandbox with one of: ${names.join(", ")}`, { names });
  return { sandboxId: row.sandbox_id, local: !credentials || row.machine_id === credentials.machine_id };
}

/** Runs a catalog request where it belongs: the account (catalog changes), this Mac's daemon, or the agent API. */
async function run(request: RequestEnvelope, wanted: string | undefined): Promise<ResponseEnvelope> {
  const entry = catalogById.get(request.operation as OperationId)!;
  try {
    // Agent setup acts on this Mac's skill and link, so the CLI answers it itself (the daemon runs this CLI for remote callers).
    if (isAgentSetupOperation(entry.id)) { validateRequest(request); return success(request, await new AgentSetup().handle(entry.id, request.input)); }
    const where = entry.sandbox_scoped ? await target(wanted) : undefined;
    if (where) request = { ...request, sandbox_id: where.sandboxId };
    validateRequest(request);
    // Without a sign-in there is no account catalog, only this Mac's daemon.
    const local = entry.executor === "account" ? entry.id === "sandbox.list" && !(await readCredentials(machinePaths().credentials)) : where?.local ?? true;
    return await (local ? await localTransport() : entry.id === "sandbox.create" ? await createTransport() : await accountTransport()).dispatch(request);
  } catch (error) {
    return failure(request, error instanceof ContractError ? error : new ContractError("internal", error instanceof Error ? error.message : String(error)));
  }
}

const SIZE = /^(\d+(?:\.\d+)?)\s*([KMGT]i?B?|B)?$/i;
function bytes(value: string): number {
  const match = value.match(SIZE); if (!match) throw new ContractError("invalid_input", `--memory takes a size like 4G or 4096M, not ${value}`);
  const unit = (match[2] ?? "B")[0].toUpperCase();
  return Math.round(Number(match[1]) * 1024 ** ("BKMGT".indexOf(unit)));
}
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i;
/** `5s`, `10m`, `2h`, `1d` in milliseconds. */
function milliseconds(value: string, flag: string): number {
  const match = value.match(DURATION); if (!match) throw new ContractError("invalid_input", `--${flag} takes a duration like 5s, 10m or 2h, not ${value}`);
  return Math.round(Number(match[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase() as "ms"]);
}
function coerce(value: string | true, schema: JsonSchema | undefined, flag: string): Json {
  if (value === true) return true;
  if (schema?.type === "integer" || schema?.type === "number") { const number = Number(value); if (!Number.isFinite(number)) throw new ContractError("invalid_input", `--${flag} must be a number`); return number; }
  if (schema?.type === "array" || schema?.type === "object") { try { return JSON.parse(value) as Json; } catch { throw new ContractError("invalid_input", `--${flag} takes JSON`); } }
  return value;
}

/** `localbox <group> <verb> [positional...] [--flag value...]` for any catalog operation. */
async function catalogCommand(entry: OperationCatalogEntry, words: string[], implied: Record<string, Json> = {}): Promise<void> {
  const schema = entry.input_schema; const properties = schema.properties ?? {};
  const { flags, positional } = parse(words, schema);
  const input: Record<string, Json> = { ...(typeof flags["input-json"] === "string" ? JSON.parse(flags["input-json"]) : {}), ...implied };
  for (const [flag, value] of Object.entries(flags)) {
    if (CONTROL_FLAGS.has(flag) && !(flag === "machine" && entry.id === "sandbox.create")) continue;
    const key = flag.replaceAll("-", "_");
    if (!properties[key]) throw new ContractError("invalid_input", `${entry.id} has no --${flag}; see localbox help ${entry.id}`);
    input[key] = coerce(value, properties[key], flag);
  }
  if (typeof flags.memory === "string") input.memory_bytes = bytes(flags.memory);
  for (const flag of ["sleep-after", "delete-after"]) {
    const value = flags[flag]; if (typeof value !== "string") continue;
    const key = `${flag.replace("-", "_")}_ms`;
    if (!properties[key]) throw new ContractError("invalid_input", `${entry.id} has no --${flag}; see localbox help ${entry.id}`);
    input[key] = milliseconds(value, flag);
  }
  if (typeof flags.machine === "string" && entry.id !== "sandbox.create") throw new ContractError("invalid_input", "--machine only applies to sandbox create; name an existing sandbox with --sandbox");
  let sandbox = typeof flags.sandbox === "string" ? flags.sandbox : undefined;
  const required = (schema.required ?? []).filter((key) => !(key in input));
  // `sandbox rename OLD NEW`, `sandbox delete NAME`: a leading extra word names the sandbox.
  if (entry.sandbox_scoped && entry.id.startsWith("sandbox.") && !sandbox && positional.length > required.length) sandbox = positional.shift();
  if (entry.id === "shell.exec") {
    const [command, ...rest] = [...positional, ...tail];
    if (command && !("command" in input)) Object.assign(input, { command, args: rest });
    if (!("cwd" in input)) input.cwd = "/";
  } else {
    if (positional.length > required.length) throw new ContractError("invalid_input", `unexpected ${positional.slice(required.length).join(" ")}; see localbox help ${entry.id}`);
    required.forEach((key, index) => { if (positional[index] !== undefined) input[key] = coerce(positional[index], properties[key], key); });
  }
  if (entry.id.startsWith("machine.") && typeof input.machine_id === "string" && !input.machine_id.startsWith("machine_")) {
    const machines = await (await accountTransport()).dispatch(call("machine.list", {}));
    const found = machines.ok ? (machines.result as Array<{ machineId: string; name: string }>).find((row) => row.name === input.machine_id) : undefined;
    if (found) input.machine_id = found.machineId;
  }
  const request = requestFromInvocation({ operation: entry.id, input, request_id: typeof flags["request-id"] === "string" ? flags["request-id"] : newId("cli"), deadline_ms: typeof flags["deadline-ms"] === "string" ? Number(flags["deadline-ms"]) : undefined, mutation_id: typeof flags["mutation-id"] === "string" ? flags["mutation-id"] : entry.idempotency === "required" ? newId("cli") : null });
  print(await run(request, sandbox));
}

async function apiCall(path: string, body?: Record<string, unknown>): Promise<any> {
  const credentials = await readCredentials(machinePaths().credentials);
  const response = await fetch(`${PUBLIC_API_ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(credentials ? { authorization: `Bearer ${credentials.secret}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error_description ?? result.error ?? `request failed (${response.status})`); return result;
}

async function main(): Promise<void> {
  const [group, verb, ...rest] = head;
  const subcommand = verb?.startsWith("--") ? undefined : verb;
  if (!group || group === "--help" || group === "-h") { process.stdout.write(usage()); return; }
  // `localbox <command> --help` describes that command without running it; an unknown command fails.
  if (head.includes("--help") || head.includes("-h")) {
    const words = head.filter((word) => word !== "--help" && word !== "-h");
    const found = catalogEntry(words); const local = found ? undefined : localCommand(words);
    if (found) print(operationHelp(found.entry));
    else if (local) process.stdout.write(`localbox ${local[0]}\n  ${local[1]}\n`);
    else { process.stderr.write(`unknown command: localbox ${words.join(" ")}\n${usage()}`); process.exitCode = 2; }
    return;
  }
  if (group === "help") {
    if (!subcommand) { if (json) process.stdout.write(`${JSON.stringify(cliHelpSnapshot(), null, 2)}\n`); else process.stdout.write(usage()); return; }
    const entry = catalogById.get(subcommand as OperationId);
    if (!entry) { print(failure(requestFromInvocation({ operation: subcommand, input: {} }), new ContractError("invalid_input", `unknown operation: ${subcommand}`))); return; }
    print(operationHelp(entry)); return;
  }
  if (group === "contract" && (!subcommand || subcommand === "probe")) {
    const dispatcher = new FakeDispatcher();
    const response = await dispatcher.dispatch({ protocol_version: PROTOCOL_VERSION, request_id: "probe-0001", operation: "sandbox.list", sandbox_id: null, deadline_ms: 30_000, mutation_id: null, input: {} });
    print(response.ok ? { ...response, result: ({ catalog: catalogSnapshot(), cli_help: cliHelpSnapshot(), mcp_tools: mcpToolsSnapshot(), sandboxes: response.result } as unknown as Json) } : response);
    return;
  }
  if (group === "contract" && subcommand === "generate-snapshots") { await writeSnapshots(); return; }
  if (group === "login") {
    const { flags } = parse(head.slice(1));
    const email = typeof flags.email === "string" ? flags.email : undefined; const code = typeof flags.code === "string" ? flags.code : undefined;
    if (!email) throw new Error("login requires --email");
    if (!code) { await apiCall("/api/auth/email/start", { email }); process.stdout.write(`Code sent to ${email}. Ask the user for the 6-digit code, then run: localbox login --email ${email} --code NNNNNN\n`); return; }
    const result = await apiCall("/api/auth/email/verify", { email, code, machine_name: machineName(hostname()) });
    const current = await readCredentials(machinePaths().credentials); if (current && current.account_id !== result.account_id) throw new Error(`this Mac is already signed in to account ${current.account_name}`);
    const credentials: Credentials = { api_origin: result.api_origin ?? PUBLIC_API_ORIGIN, convex_url: result.convex_url, account_id: result.account_id, account_name: result.account_name, machine_id: result.machine_id, machine_name: result.machine_name, secret: result.secret };
    await writeCredentials(machinePaths().credentials, credentials);
    const facts = { account_name: credentials.account_name, machine_name: credentials.machine_name, machine_count: result.machine_count };
    if (json) print(facts); else process.stdout.write(`Signed in to ${facts.account_name} as ${facts.machine_name}. ${facts.machine_count} machine${facts.machine_count === 1 ? "" : "s"}.\n`);
    return;
  }
  if (group === "logout") {
    await apiCall("/api/auth/logout"); await deleteCredentials(machinePaths().credentials);
    // The mirror holds the old account's sandboxes; an account signed in next must not find them here.
    const cleared = await new LocalIPCTransport().dispatch({ protocol_version: PROTOCOL_VERSION, request_id: newId("cli"), operation: "sandbox.mirror", sandbox_id: null, deadline_ms: 30_000, mutation_id: null, input: { sandboxes: [] } });
    print({ signed_out: true, sandboxes_forgotten: cleared.ok }); return;
  }
  if (group === "mcp" && subcommand === "install") { process.stdout.write(`${JSON.stringify({ mcpServers: { localbox: { url: PUBLIC_MCP_RESOURCE } }, oauth: { resource: PUBLIC_MCP_RESOURCE } }, null, 2)}\n`); return; }
  if (group === "update" && (subcommand === "check" || subcommand === "install")) { print(await (subcommand === "check" ? checkForUpdate() : installLatest({ automatic: rest.includes("--auto") })) as unknown as Json); return; }
  if (group === "agents" && subcommand === "reconcile") {
    const reason = parse(head.slice(2)).flags.reason ?? "explicit";
    if (!REASONS.includes(reason as Reason)) throw new Error(`--reason takes ${REASONS.join(", ")}`);
    const report = await new AgentSetup().reconcile(reason as Reason);
    print(report as unknown as Json);
    if (report.actions.some((action) => action.kind === "failed")) process.exitCode = 1;
    return;
  }
  if (group === "agents" && subcommand === "op") {
    const { flags, positional } = parse(head.slice(2));
    const operation = positional[0] ?? "";
    const request = requestFromInvocation<Json>({ operation, input: {}, request_id: newId("agents"), mutation_id: catalogById.get(operation as OperationId)?.idempotency === "required" ? newId("agents") : null });
    try {
      if (!isAgentSetupOperation(operation)) throw new ContractError("invalid_input", `agents op runs an agent setup operation, not ${operation || "nothing"}`);
      request.input = typeof flags["input-json"] === "string" ? JSON.parse(flags["input-json"]) as Json : {};
    } catch (error) { print(failure(request, error instanceof ContractError ? error : new ContractError("invalid_input", "--input-json takes JSON"))); return; }
    print(await run(request, undefined)); return;
  }
  if (group === "connector" && subcommand === "run") { const { runConnector } = await import("../../connector/src/index.js"); process.exit(await runConnector()); }
  if (group === "status") {
    const { flags } = parse(head.slice(1));
    try {
      const where = await target(typeof flags.sandbox === "string" ? flags.sandbox : undefined);
      print(await new AgentClient({ transport: where.local ? await localTransport() : await accountTransport(), sandboxId: where.sandboxId }).status());
    } catch (error) { print(failure(requestFromInvocation({ operation: "sandbox.status", input: {} }), error instanceof ContractError ? error : new ContractError("internal", String(error)))); }
    return;
  }
  if (group === "invoke" && subcommand) {
    const entry = catalogById.get(subcommand as OperationId);
    const { flags } = parse(head.slice(2));
    let input: Json = {};
    try { input = JSON.parse(typeof flags["input-json"] === "string" ? flags["input-json"] : "{}") as Json; } catch { input = null; }
    const request = requestFromInvocation({ operation: subcommand, input, request_id: typeof flags["request-id"] === "string" ? flags["request-id"] : newId("cli"), deadline_ms: typeof flags["deadline-ms"] === "string" ? Number(flags["deadline-ms"]) : undefined, mutation_id: typeof flags["mutation-id"] === "string" ? flags["mutation-id"] : null });
    if (!entry) { print(failure(request, new ContractError("invalid_input", `unknown operation: ${subcommand}`))); return; }
    print(await run(request, typeof flags.sandbox === "string" ? flags.sandbox : undefined)); return;
  }
  const found = catalogEntry(head);
  if (found) {
    try { await catalogCommand(found.entry, found.rest, found.input); }
    catch (error) { if (!(error instanceof ContractError)) throw error; print(failure(requestFromInvocation({ operation: found.entry.id, input: {} }), error)); }
    return;
  }
  process.stderr.write(usage()); process.exitCode = 2;
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
