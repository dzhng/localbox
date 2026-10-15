import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  catalogById, catalogSnapshot, cliHelpSnapshot, mcpToolsSnapshot,
  ContractError, failure, PROTOCOL_VERSION, RELEASE_ID, requestFromInvocation, validateRequest,
  type Json, type OperationId, type ResponseEnvelope,
} from "../../../packages/contract/src/index.js";
import { FakeDispatcher } from "../../../packages/runtime/src/index.js";
import { AgentClient, fixtureTransport, LocalIPCTransport, RelayHttpTransport, type TransportKind } from "../../../packages/client/src/index.js";
import { authorizationUrl, createPkcePair, exchangeAuthorizationCode, refreshAccessToken, type OAuthTokenResponse } from "../../../packages/client/src/auth.js";
import { recoveryProbe } from "../../../packages/recovery/src/index.js";
import { GuestGateway } from "../../../packages/guest-gateway/src/index.js";
import { SkillManager } from "./skill-manager.js";
import { checkForUpdate, installLatest } from "./updater.js";
import { PUBLIC_MCP_RESOURCE, PUBLIC_RELAY_URL } from "../../../packages/config/src/index.js";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const execFileAsync = promisify(execFile);
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
    "  auth login [TOKEN]               Authenticate remote transport",
    "  login [TOKEN]                    Alias for auth login",
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

function authPath(): string { return process.env.LOCALBOX_AUTH_FILE ?? resolve(homedir(), ".config", "localbox", "auth.json"); }
interface SavedAuth { token: string; refresh_token?: string; expires_at?: number; saved_at: string }
async function saveAuth(token: string, refreshToken?: string, expiresIn?: number): Promise<void> {
  const serialized = JSON.stringify({ token, ...(refreshToken ? { refresh_token: refreshToken } : {}), ...(expiresIn ? { expires_at: Date.now() + expiresIn * 1000 } : {}), saved_at: new Date().toISOString() } satisfies SavedAuth);
  if (process.platform === "darwin" && !process.env.LOCALBOX_AUTH_FILE) {
    try { await execFileAsync("security", ["add-generic-password", "-a", process.env.USER ?? "agent", "-s", "localbox-access", "-w", serialized, "-U"]); return; } catch { /* fall back to the platform config file */ }
  }
  const path = authPath(); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${serialized}\n`, { mode: 0o600 });
}

async function loginWithPkce(): Promise<{ access_token: string; refresh_token?: string }> {
  const authorizeEndpoint = `${PUBLIC_MCP_RESOURCE}/oauth/authorize`;
  const tokenEndpoint = `${PUBLIC_MCP_RESOURCE}/oauth/token`;
  const resource = PUBLIC_MCP_RESOURCE;
  const clientId = process.env.LOCALBOX_OAUTH_CLIENT_ID ?? "localbox-cli";
  const pair = createPkcePair(); const state = randomBytes(18).toString("base64url"); let redirectUri = "";
  const callback = createServer();
  const code = await new Promise<string>((resolveCode, reject) => {
    callback.once("error", reject);
    callback.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth/callback") { response.writeHead(404); response.end(); return; }
      if (url.searchParams.get("state") !== state) { response.writeHead(400); response.end("state mismatch"); reject(new Error("OAuth state mismatch")); return; }
      const value = url.searchParams.get("code"); if (!value) { response.writeHead(400); response.end("missing code"); reject(new Error("OAuth callback did not contain a code")); return; }
      response.writeHead(200, { "content-type": "text/plain" }); response.end("Localbox login complete. You can close this window."); resolveCode(value); callback.close();
    });
    callback.listen(0, "127.0.0.1", () => {
      const address = callback.address(); if (!address || typeof address === "string") { reject(new Error("OAuth callback listener failed")); return; }
      redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
      const url = authorizationUrl({ endpoint: authorizeEndpoint, clientId, redirectUri, resource, challenge: pair.challenge, state });
      process.stdout.write(`Open this URL to sign in:\n${url}\n`);
      try { if (process.platform === "darwin") execFileSync("open", [url], { stdio: "ignore" }); } catch { /* copy the URL into a browser */ }
    });
  });
  if (!redirectUri) throw new Error("OAuth callback listener did not produce a redirect URI");
  return exchangeAuthorizationCode({ endpoint: tokenEndpoint, code, clientId, redirectUri, verifier: pair.verifier, resource });
}
async function hasAuth(): Promise<boolean> {
  if (process.env.LOCALBOX_TOKEN) return true;
  if (process.platform === "darwin" && !process.env.LOCALBOX_AUTH_FILE) {
    try { await execFileAsync("security", ["find-generic-password", "-a", process.env.USER ?? "agent", "-s", "localbox-access", "-w"]); return true; } catch { /* use config file */ }
  }
  try { const value = JSON.parse(await readFile(authPath(), "utf8")) as { token?: string }; return typeof value.token === "string" && value.token.length > 0; }
  catch { return false; }
}

async function readAuth(): Promise<SavedAuth | undefined> {
  if (process.platform === "darwin" && !process.env.LOCALBOX_AUTH_FILE) {
    try { const result = await execFileAsync("security", ["find-generic-password", "-a", process.env.USER ?? "agent", "-s", "localbox-access", "-w"]); const value = result.stdout.trim(); const parsed = JSON.parse(value) as SavedAuth; return parsed.token ? parsed : { token: value, saved_at: "" }; } catch { /* use config file */ }
  }
  try { return JSON.parse(await readFile(authPath(), "utf8")) as SavedAuth; } catch { return undefined; }
}

async function makeClient(): Promise<AgentClient> {
  const kind: TransportKind = process.env.LOCALBOX_TRANSPORT === "remote" ? "remote" : "local";
  if (kind === "remote") {
    const initial = await readAuth();
    let credentials = initial;
    const accessTokenProvider = async () => {
      if (process.env.LOCALBOX_TOKEN) return process.env.LOCALBOX_TOKEN;
      if (credentials?.refresh_token && credentials.expires_at && credentials.expires_at <= Date.now() + 30_000) {
        const tokenEndpoint = `${PUBLIC_MCP_RESOURCE}/oauth/token`;
        const resource = PUBLIC_MCP_RESOURCE;
        const refreshed = await refreshAccessToken({ endpoint: tokenEndpoint, refreshToken: credentials.refresh_token, clientId: process.env.LOCALBOX_OAUTH_CLIENT_ID ?? "localbox-cli", resource });
        credentials = { token: refreshed.access_token, refresh_token: refreshed.refresh_token ?? credentials.refresh_token, expires_at: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : undefined, saved_at: new Date().toISOString() };
        await saveAuth(credentials.token, credentials.refresh_token, refreshed.expires_in);
      }
      return credentials?.token;
    };
    return new AgentClient({ transport: new RelayHttpTransport({ baseUrl: PUBLIC_RELAY_URL, accessTokenProvider }) });
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

async function readSavedToken(): Promise<string | undefined> {
  return (await readAuth())?.token;
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
  if ((group === "auth" && subcommand === "login") || group === "login") {
    let token = (group === "login" ? subcommand : rest[0]) ?? process.env.LOCALBOX_TOKEN;
    let refreshToken: string | undefined; let expiresIn: number | undefined;
    if (!token) {
      const credentials: OAuthTokenResponse = await loginWithPkce(); token = credentials.access_token; refreshToken = credentials.refresh_token; expiresIn = credentials.expires_in;
    }
    if (!token) { process.stderr.write("login requires an OAuth access token or a successful browser login\n"); process.exitCode = 2; return; }
    await saveAuth(token, refreshToken, expiresIn);
    printResponse(requestEnvelope("system.info", { authenticated: true, transport: process.env.LOCALBOX_TRANSPORT === "remote" ? "remote" : "local" })); return;
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
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return;
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
