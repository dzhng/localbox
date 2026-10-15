import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { waitForCode } from "../lib/codes.js";
import { API_ORIGIN, machineRoot, stopConnector } from "../lib/login.js";
import { guestRoot, signedInWithSandboxes } from "../lib/sandboxes.js";
import { shootSignInPages } from "../lib/shoot.js";

export const id = "08";
export const tiers = ["u", "l"];

const MCP = `${API_ORIGIN}/api/mcp`;
const REDIRECT = "http://127.0.0.1:47123/callback";
const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const form = (fields: Record<string, string>): RequestInit => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(), redirect: "manual" });

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("account OAuth, email sign-in flow, MCP adapter and MCP entry unit tests", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/repository-oauth.test.ts", "tests/oauth-mcp.test.ts", "tests/mcp-vercel-oauth.test.ts", "tests/oauth-email-flow.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2000));
    })];
  }
  const checks: Check[] = [];
  checks.push(await ctx.check("both sign-in pages are captured at 390 and 1280 px", async () => {
    const shots = await shootSignInPages(ctx.evidence);
    assert.equal(shots.length, 4);
    for (const shot of shots) assert.ok(existsSync(shot) && statSync(shot).size > 5_000, shot);
  }));
  const up = await ctx.stack("up", ["a", "b"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const run = Date.now(); const devLog = join(ctx.root, ".localbox/proof/dev-local.log");
  const email = `proof-08-${run}@example.com`;
  let machineB = ""; let sandboxB = ""; let sandboxIdB = ""; let connector: ChildProcess | undefined;
  let metadata: Record<string, any> = {}; let clientId = "";
  let tokens: Record<string, any> = {}; let refreshed: Record<string, any> = {};
  const mcp = async (token: string, method: string, params?: unknown) => {
    const response = await fetch(MCP, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return { status: response.status, body: response.status === 200 ? await response.json() as any : undefined };
  };
  /** Authorize by email code as a scripted MCP client; returns the token response. */
  const signInAgent = async (address: string, client: string, check?: (codePage: string) => void) => {
    const verifier = randomBytes(32).toString("base64url"); const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = { response_type: "code", client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: MCP, scope: "account", state: `st-${run}` };
    const page = await fetch(`${metadata.authorization_endpoint}?${new URLSearchParams(params)}`);
    assert.equal(page.status, 200); assert.match(await page.text(), /Sign in to Localbox/);
    const since = statSync(devLog).size;
    const codePage = await fetch(metadata.authorization_endpoint, form({ ...params, step: "email", email: address }));
    assert.equal(codePage.status, 200); check?.(text(await codePage.text()));
    const code = await waitForCode(address, { sinceByte: since, logPath: devLog });
    const redirected = await fetch(metadata.authorization_endpoint, form({ ...params, step: "code", email: address, code }));
    assert.equal(redirected.status, 302);
    const location = new URL(redirected.headers.get("location")!);
    assert.equal(`${location.origin}${location.pathname}`, REDIRECT); assert.equal(location.searchParams.get("state"), params.state);
    const exchanged = await fetch(metadata.token_endpoint, form({ grant_type: "authorization_code", code: location.searchParams.get("code")!, client_id: client, redirect_uri: REDIRECT, code_verifier: verifier, resource: MCP }));
    assert.equal(exchanged.status, 200);
    return await exchanged.json() as Record<string, any>;
  };
  try {
    checks.push(await ctx.check("B signs in, its connector connects, and it gets a sandbox", async () => {
      const setup = await signedInWithSandboxes(ctx.root, ["b"], email);
      connector = setup.connectors.b; sandboxB = setup.sandboxes.b;
      machineB = JSON.parse(readFileSync(join(machineRoot(ctx.root, "b"), "credentials.json"), "utf8")).machine_id;
      sandboxIdB = JSON.parse(readFileSync(join(machineRoot(ctx.root, "b"), "sandboxes.json"), "utf8"))[0].sandbox_id;
    }));
    checks.push(await ctx.check("a client discovers metadata from the 401 and registers", async () => {
      const unauthenticated = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
      assert.equal(unauthenticated.status, 401);
      const resourceUrl = unauthenticated.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1]; assert.ok(resourceUrl);
      const resource = await (await fetch(resourceUrl)).json() as any;
      assert.equal(resource.resource, MCP); assert.deepEqual(resource.scopes_supported, ["account"]);
      const issuer = new URL(resource.authorization_servers[0]);
      metadata = await (await fetch(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`)).json() as any;
      assert.deepEqual(await (await fetch(`${issuer.href}/.well-known/oauth-authorization-server`)).json(), metadata, "both discovery paths agree");
      assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]); assert.ok(metadata.registration_endpoint);
      const registered = await fetch(metadata.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Proof Agent", redirect_uris: [REDIRECT] }) });
      assert.equal(registered.status, 201); clientId = (await registered.json() as any).client_id;
    }));
    checks.push(await ctx.check("authorize by email code (read from the dev log), redirect with code and state, exchange with PKCE", async () => {
      tokens = await signInAgent(email, clientId, (page) => assert.match(page, /Signing in gives Proof Agent \(127\.0\.0\.1:47123\) full access to account [a-z]+-[a-z]+-\d+: it can create, use and delete sandboxes on all your machines\./));
      assert.equal(tokens.scope, "account"); assert.equal(tokens.token_type, "Bearer");
    }));
    checks.push(await ctx.check("MCP tools/call shell.exec with sandbox = B's sandbox runs on B; with one sandbox it may be left out", async () => {
      const listed = await mcp(tokens.access_token, "tools/list");
      assert.ok(listed.body.result.tools.find((tool: any) => tool.name === "shell.exec").inputSchema.properties.sandbox);
      assert.ok(!listed.body.result.tools.find((tool: any) => tool.name === "shell.exec").inputSchema.properties.machine);
      const marker = `mcp-${run}`;
      const called = await mcp(tokens.access_token, "tools/call", { name: "shell.exec", arguments: { sandbox: sandboxB, command: "touch", args: [marker], cwd: "/" } });
      assert.equal(called.status, 200); assert.notEqual(called.body.result.isError, true, JSON.stringify(called.body));
      assert.ok(existsSync(join(guestRoot(ctx.root, "b"), marker)), "the command ran in B's guest"); assert.ok(!existsSync(join(guestRoot(ctx.root, "a"), marker)), "and not in A's");
      const unnamed = await mcp(tokens.access_token, "tools/call", { name: "fs.stat", arguments: { path: `/${marker}` } });
      assert.notEqual(unnamed.body.result.isError, true, JSON.stringify(unnamed.body)); assert.equal(unnamed.body.result.structuredContent.exists, true);
    }));
    checks.push(await ctx.check("the agent token also works on the agent API (/api/v1/ops)", async () => {
      const response = await fetch(`${API_ORIGIN}/api/v1/ops`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ operation: "machine.list", input: {} }) });
      assert.equal(response.status, 200); assert.ok((await response.json() as any[]).some((row) => row.machineId === machineB));
    }));
    checks.push(await ctx.check("another account's agent cannot reach B's sandbox by name or id, nor create one on B", async () => {
      const other = await signInAgent(`proof-08-other-${run}@example.com`, clientId, (page) => assert.match(page, /full access to your new account/));
      for (const sandbox of [sandboxB, sandboxIdB, undefined]) {
        const called = await mcp(other.access_token, "tools/call", { name: "fs.stat", arguments: { ...(sandbox ? { sandbox } : {}), path: "/" } });
        assert.equal(called.body.result.isError, true); assert.equal(called.body.result.structuredContent?.code, "sandbox_not_found", JSON.stringify(called.body));
      }
      const created = await mcp(other.access_token, "tools/call", { name: "sandbox.create", arguments: { machine: machineB } });
      assert.equal(created.body.result.isError, true); assert.equal(created.body.result.structuredContent?.code, "machine_not_found", JSON.stringify(created.body));
    }));
    checks.push(await ctx.check("refresh rotates; replaying the old refresh token is refused and revokes the family", async () => {
      const refresh = (token: string) => fetch(metadata.token_endpoint, form({ grant_type: "refresh_token", refresh_token: token, client_id: clientId }));
      const rotated = await refresh(tokens.refresh_token); assert.equal(rotated.status, 200); refreshed = await rotated.json() as any;
      assert.equal((await mcp(refreshed.access_token, "tools/call", { name: "machine.list", arguments: {} })).status, 200);
      const replay = await refresh(tokens.refresh_token);
      assert.equal(replay.status, 400); assert.equal((await replay.json() as any).error, "invalid_grant");
      assert.equal((await mcp(refreshed.access_token, "tools/list")).status, 401, "the newest access token stops working");
      assert.equal((await refresh(refreshed.refresh_token)).status, 400, "and so does the newest refresh token");
    }));
    checks.push(await ctx.check("authorize refuses an unregistered redirect and a request without S256", async () => {
      const base = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: "A".repeat(43), code_challenge_method: "S256", resource: MCP };
      for (const params of [{ ...base, redirect_uri: "http://127.0.0.1:47124/callback" }, { ...base, code_challenge_method: "plain" }]) {
        const response = await fetch(`${metadata.authorization_endpoint}?${new URLSearchParams(params)}`, { redirect: "manual" });
        assert.equal(response.status, 400); assert.equal(response.headers.get("location"), null);
      }
    }));
    return checks;
  } finally {
    stopConnector(connector);
    if (!ctx.keep) await ctx.stack("down");
  }
}
