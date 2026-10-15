import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  catalogById, catalogSnapshot, cliHelpSnapshot, mcpToolsSnapshot,
  ContractError, failure, PROTOCOL_VERSION, RELEASE_ID, requestFromInvocation, validateRequest,
  type Json, type OperationId, type ResponseEnvelope,
} from "../../../packages/contract/src/index.js";
import { FakeDispatcher } from "../../../packages/runtime/src/index.js";
import { AgentClient, fixtureTransport, LocalIPCTransport, RelayHttpTransport, type TransportKind } from "../../../packages/client/src/index.js";
import { recoveryProbe } from "../../../packages/recovery/src/index.js";
import { GuestGateway } from "../../../packages/guest-gateway/src/index.js";
import { SkillManager } from "./skill-manager.js";
import { checkForUpdate, installLatest } from "./updater.js";
import { machinePaths, PUBLIC_API_ORIGIN, PUBLIC_MCP_RESOURCE, PUBLIC_RELAY_URL } from "../../../packages/config/src/index.js";
import { readCredentials, writeCredentials, deleteCredentials, type Credentials } from "../../../packages/credentials/src/index.js";
import { machineName } from "../../../packages/names/src/index.js";
import { hostname } from "node:os";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const args = process.argv.slice(2);
const json = args.includes("--json");
const positional = args.filter((arg) => arg !== "--json");

function requestEnvelope(operation: string, result: Json): ResponseEnvelope {
  return { protocol_version: PROTOCOL_VERSION, request_id: "cli-local", operation, vm_id: "vm_01", release_id: RELEASE_ID, ok: true, result };
}

function printResponse(response: ResponseEnvelope, machine = json): void {
  if (machine) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    if (!response.ok) process.stderr.write(`${response.error.code}: ${response.error.message}\n`);
    return;
  }
  if (response.ok) process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
  else {
    process.stderr.write(`${response.error.code}: ${response.error.message}\n`);
    process.exitCode = response.error.code === "unauthorized" ? 2 : 1;
  }
}

function printUsage(): void {
  process.stdout.write([
    "localbox <command> [options]", "",
    "Commands:",
    "  status [--json]                 Show VM, relay, and egress status",
    "  vm probe [--json]               Run the host virtualization viability probe",
    "  recovery probe [--json]         Emit injected recovery timeline",
    "  vm start|stop|pause [--json]    Change VM lifecycle",
    "  shell exec [--json] -- CMD ...  Execute a guest shell command",
    "  login --email EMAIL [--code CODE]  Sign in with an email code",
    "  logout                            Revoke this machine",
    "  machines list|rename|remove       Manage account machines",
    "  account show|rename               Manage the account",
    "  mcp install [--json]             Print optional MCP installation config",
    "  update check|install [--json]    Check or install the latest GitHub release",
    "  skill status|install|update|uninstall  Manage the global Localbox skill",
    "  invoke OPERATION [options]       Invoke any catalog operation",
    "  help [OPERATION]                 Show catalog-generated schemas",
    "  contract probe|generate-snapshots  Inspect contract fixtures", "",
  ].join("\n"));
}

async function writeSnapshots(): Promise<void> {
  await Promise.all([
    writeFile(resolve(root, "snapshots/catalog.json"), `${JSON.stringify(catalogSnapshot(), null, 2)}\n`),
    writeFile(resolve(root, "snapshots/cli-help.json"), `${JSON.stringify(cliHelpSnapshot(), null, 2)}\n`),
    writeFile(resolve(root, "snapshots/mcp-tools.json"), `${JSON.stringify(mcpToolsSnapshot(), null, 2)}\n`),
  ]);
  process.stdout.write("Generated contract snapshots.\n");
}

async function makeClient(): Promise<AgentClient> {
  const kind: TransportKind = process.env.LOCALBOX_TRANSPORT === "remote" ? "remote" : "local";
  if (kind === "remote") {
    const credentials = await readCredentials(machinePaths().credentials);
    return new AgentClient({ transport: new RelayHttpTransport({ baseUrl: PUBLIC_RELAY_URL, accessToken: credentials?.secret }) });
  }
  if (kind === "local" && process.env.LOCALBOX_LOCAL_TRANSPORT !== "fixture") {
    return new AgentClient({ transport: new LocalIPCTransport() });
  }
  const guestRoot = resolve(root, ".localbox/guest");
  await mkdir(guestRoot, { recursive: true });
  const guest = new GuestGateway({ root: guestRoot });
  const transport = fixtureTransport(kind, new FakeDispatcher({ handlers: guest.handlers() }));
  return new AgentClient({ transport });
}

async function apiCall(path: string, method: string, body?: Record<string, unknown>): Promise<any> {
  const credentials = await readCredentials(machinePaths().credentials);
  const response = await fetch(`${PUBLIC_API_ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...(credentials ? { authorization: `Bearer ${credentials.secret}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error_description ?? result.error ?? `request failed (${response.status})`); return result;
}
function printCatalogResult(result: any): void {
  if (json) { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return; }
  if (Array.isArray(result)) { for (const machine of result) process.stdout.write(`${machine.machineId ?? machine.machine_id}  ${machine.name ?? machine.machine_name}\n`); return; }
  if (result?.name && result?.email) { process.stdout.write(`${result.name} (${result.email})\n`); return; }
  if (result?.machine_id && result?.removed) { process.stdout.write(`Removed ${result.machine_id}.\n`); return; }
  if (result?.machine_id && result?.machine_name) { process.stdout.write(`Renamed ${result.machine_id} to ${result.machine_name}.\n`); return; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function vmProbe(): Promise<void> {
  const fixture = resolve(root, "apps/macos/VMProbe/Fixtures/fake-probe.json");
  const report = JSON.parse(await readFile(fixture, "utf8")) as Json;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function optionValue(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

async function invokeOperation(operationName: string, values: string[]): Promise<void> {
  const operation = catalogById.get(operationName as OperationId);
  const vmId = optionValue(values, "--vm-id") ?? "vm_01";
  const requestId = optionValue(values, "--request-id") ?? "cli-invoke-1";
  const deadlineRaw = optionValue(values, "--deadline-ms");
  const mutationId = optionValue(values, "--mutation-id") ?? null;
  const inputRaw = optionValue(values, "--input-json") ?? "{}";
  let input: Json;
  try { input = JSON.parse(inputRaw) as Json; }
  catch { input = null; }
  const request = requestFromInvocation({ operation: operationName, vm_id: vmId, request_id: requestId, deadline_ms: deadlineRaw ? Number(deadlineRaw) : undefined, mutation_id: mutationId, input });
  if (!operation) {
    printResponse(failure(request, new ContractError("invalid_input", `unknown operation: ${operationName}`)));
    return;
  }
  if (vmId !== "vm_01") {
    printResponse(failure(request, { code: "vm_not_found", message: `unknown VM: ${vmId}`, retryable: false }));
    return;
  }
  try { validateRequest(request); }
  catch (error) {
    printResponse(failure(request, error instanceof ContractError ? error : new ContractError("invalid_input", "invalid invocation")));
    return;
  }
  const client = await makeClient();
  printResponse(await client.invoke(operation.id, input, { vmId, requestId, deadlineMs: request.deadline_ms, mutationId }));
}

async function main(): Promise<void> {
  if (positional.length === 0 || positional[0] === "--help" || positional[0] === "-h") { printUsage(); return; }
  const [group, subcommand, ...rest] = positional;
  if (group === "help") {
    const operation = subcommand;
    if (!operation) { process.stdout.write(`${JSON.stringify(cliHelpSnapshot(), null, 2)}\n`); return; }
    const entry = catalogById.get(operation as OperationId);
    if (!entry) { printResponse({ ...requestEnvelope("system.info", null), ok: false, error: { code: "invalid_input", message: `unknown operation: ${operation}`, retryable: false } }); return; }
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`); return;
  }
  if (group === "contract" && (!subcommand || subcommand === "probe")) {
    const dispatcher = new FakeDispatcher();
    const response = await dispatcher.dispatch({ protocol_version: PROTOCOL_VERSION, request_id: "probe-0001", operation: "system.info", vm_id: "vm_01", deadline_ms: 30_000, mutation_id: null, input: {} });
    if (response.ok) printResponse({ ...response, result: ({ catalog: catalogSnapshot(), cli_help: cliHelpSnapshot(), mcp_tools: mcpToolsSnapshot(), system_info: response.result } as unknown as Json) });
    else printResponse(response);
    return;
  }
  if (group === "contract" && subcommand === "generate-snapshots") { await writeSnapshots(); return; }
  if (group === "vm" && subcommand === "probe") { await vmProbe(); return; }
  if (group === "recovery" && subcommand === "probe") { process.stdout.write(`${JSON.stringify(recoveryProbe(), null, 2)}\n`); return; }
  if (group === "login") {
    const email = optionValue(positional.slice(1), "--email"); const code = optionValue(positional.slice(1), "--code");
    if (!email) throw new Error("login requires --email");
    if (!code) { await apiCall("/api/auth/email/start", "POST", { email }); process.stdout.write(`Code sent to ${email}. Ask the user for the 6-digit code, then run: localbox login --email ${email} --code NNNNNN\n`); return; }
    const result = await apiCall("/api/auth/email/verify", "POST", { email, code, machine_name: machineName(hostname()) });
    const current = await readCredentials(machinePaths().credentials); if (current && current.account_id !== result.account_id) throw new Error(`this Mac is already signed in to account ${current.account_name}`);
    const credentials: Credentials = { api_origin: result.api_origin ?? PUBLIC_API_ORIGIN, convex_url: result.convex_url, account_id: result.account_id, account_name: result.account_name, machine_id: result.machine_id, machine_name: result.machine_name, secret: result.secret };
    await writeCredentials(machinePaths().credentials, credentials);
    const facts = { account_name: credentials.account_name, machine_name: credentials.machine_name, machine_count: result.machine_count };
    if (json) process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`); else process.stdout.write(`Signed in to ${facts.account_name} as ${facts.machine_name}. ${facts.machine_count} machine${facts.machine_count === 1 ? "" : "s"}.\n`);
    return;
  }
  if (group === "logout") { await apiCall("/api/auth/logout", "POST"); await deleteCredentials(machinePaths().credentials); process.stdout.write(json ? `${JSON.stringify({ revoked: true })}\n` : "Logged out.\n"); return; }
  if (group === "machines" && subcommand) {
    let machineId = rest[0] ?? optionValue(rest, "--machine-id");
    if (subcommand !== "list" && machineId && !machineId.startsWith("machine_")) {
      const machines = await apiCall("/api/v1/ops", "POST", { operation: "machine.list", input: {} }) as any[];
      machineId = machines.find((machine) => machine.machineId === machineId || machine.name === machineId)?.machineId ?? machineId;
    }
    const result = subcommand === "list" ? await apiCall("/api/v1/ops", "POST", { operation: "machine.list", input: {} }) : subcommand === "rename" ? await apiCall("/api/v1/ops", "POST", { operation: "machine.rename", input: { machine_id: machineId, name: optionValue(rest, "--name") ?? rest[1] } }) : await apiCall("/api/v1/ops", "POST", { operation: "machine.remove", input: { machine_id: machineId } });
    printCatalogResult(result); return;
  }
  if (group === "account" && subcommand) {
    const result = subcommand === "show" ? await apiCall("/api/v1/ops", "POST", { operation: "account.status", input: {} }) : await apiCall("/api/v1/ops", "POST", { operation: "account.rename", input: { name: optionValue(rest, "--name") ?? rest[0] } });
    printCatalogResult(result); return;
  }
  if (group === "mcp" && subcommand === "install") {
    const endpoint = PUBLIC_MCP_RESOURCE;
    const config = { mcpServers: { "localbox": { url: endpoint } }, oauth: { resource: endpoint } };
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`); return;
  }
  if (group === "update" && (subcommand === "check" || subcommand === "install")) {
    const result = subcommand === "check" ? await checkForUpdate() : await installLatest({ automatic: rest.includes("--auto") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return;
  }
  if (group === "skill" && ["status", "install", "update", "uninstall"].includes(subcommand ?? "")) {
    const manager = new SkillManager();
    const result = subcommand === "status" ? await manager.status() : subcommand === "install" ? await manager.install() : subcommand === "update" ? await manager.update() : await manager.uninstall();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (subcommand !== "status" && result.state === "needs_attention") process.exitCode = 1;
    return;
  }
  if (group === "invoke" && subcommand) { await invokeOperation(subcommand, rest); return; }
  const client = await makeClient();
  if (group === "status") { printResponse(await client.status()); return; }
  if (group === "vm" && ["start", "stop", "pause"].includes(subcommand ?? "")) {
    const operation = `vm.${subcommand}` as OperationId;
    printResponse(await client.invoke(operation, {}, { mutationId: `cli-${operation}-vm_01` })); return;
  }
  if (group === "shell" && subcommand === "exec") {
    const commandArgs = rest[0] === "--" ? rest.slice(1) : rest;
    const [command, ...commandRest] = commandArgs;
    if (!command) { printResponse({ ...requestEnvelope("shell.exec", null), ok: false, error: { code: "invalid_input", message: "shell exec requires a command", retryable: false } }); return; }
    printResponse(await client.invoke("shell.exec", { command, args: commandRest, cwd: "/", env: {} }, { mutationId: `cli-shell-${Date.now()}` })); return;
  }
  printUsage(); process.exitCode = 2;
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
