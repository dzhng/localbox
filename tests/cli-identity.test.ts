import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machinePaths } from "../packages/config/src/index.js";
import { writeCredentials } from "../packages/credentials/src/index.js";

/** A stand-in identity API that records each path called and answers each with `answers[path]` (default 200 `{}`); no code is ever emailed. */
async function identityApi(answers: Record<string, [number, Record<string, unknown>]> = {}): Promise<{ origin: string; calls: string[]; close(): void }> {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url ?? "");
    const [status, body] = answers[request.url ?? ""] ?? [200, {}];
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, calls, close: () => server.close() };
}

async function scratchMac(): Promise<{ env: NodeJS.ProcessEnv; credentials: string }> {
  const home = await mkdtemp(join(tmpdir(), "localbox-cli-identity-"));
  const env = { HOME: home, LOCALBOX_MACHINE_ROOT: join(home, "machine") };
  return { env, credentials: machinePaths(env).credentials };
}

async function signedInMac(): Promise<{ env: NodeJS.ProcessEnv; credentials: string }> {
  const { env, credentials } = await scratchMac();
  await writeCredentials(credentials, { api_origin: "", convex_url: "", account_id: "account_1", account_name: "brave-walrus-482", machine_id: "machine_1", machine_name: "studio", secret: "s" });
  return { env, credentials };
}

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(process.execPath, ["bin/localbox.js", ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })));
}

const VERIFIED = { account_id: "account_1", account_name: "brave-walrus-482", machine_id: "machine_2", machine_name: "studio", machine_count: 2, secret: "s", convex_url: "" };

test("login --json answers each step with a state; text keeps the person's sentences", async () => {
  const api = await identityApi({ "/api/auth/email/verify": [200, VERIFIED] });
  try {
    const { env, credentials } = await scratchMac(); const run = (args: string[]) => cli(args, { ...env, LOCALBOX_API_ORIGIN: api.origin });
    const sent = await run(["login", "--email", "you@example.com", "--json"]);
    assert.equal(sent.code, 0, sent.stderr); assert.deepEqual(JSON.parse(sent.stdout), { state: "code_sent", email: "you@example.com" });
    assert.match((await run(["login", "--email", "you@example.com"])).stdout, /^Code sent to you@example\.com\. Ask the user for the 6-digit code/);
    const signed = await run(["login", "--email", "you@example.com", "--code", "123456", "--json"]);
    assert.equal(signed.code, 0, signed.stderr);
    assert.deepEqual(JSON.parse(signed.stdout), { state: "signed_in", email: "you@example.com", account_name: "brave-walrus-482", machine_name: "studio", machine_count: 2 });
    assert.ok(existsSync(credentials));
    assert.deepEqual(api.calls, ["/api/auth/email/start", "/api/auth/email/start", "/api/auth/email/verify"]);
  } finally { api.close(); }
});

test("login refusals are the CLI's error envelope with --json", async () => {
  const api = await identityApi({ "/api/auth/email/verify": [400, { error: "verification code is invalid or expired" }], "/api/auth/email/start": [429, { error: "too many" }] });
  try {
    const { env, credentials } = await scratchMac(); const run = (args: string[]) => cli(args, { ...env, LOCALBOX_API_ORIGIN: api.origin });
    const cases: Array<[string[], string, RegExp]> = [
      [["login", "--json"], "invalid_input", /login requires --email/],
      [["login", "--email", "you@example.com", "--code", "000000", "--json"], "invalid_input", /verification code is invalid or expired/],
      [["login", "--email", "you@example.com", "--json"], "rate_limited", /too many/],
    ];
    for (const [args, code, message] of cases) {
      const result = await run(args);
      assert.equal(result.code, 1, args.join(" "));
      const out = JSON.parse(result.stdout); assert.equal(out.ok, false); assert.equal(out.operation, "login"); assert.equal(out.error.code, code); assert.match(out.error.message, message);
    }
    assert.ok(!existsSync(credentials), "no credential is written by a refused code");
  } finally { api.close(); }
});

test("login on a signed-in Mac is refused before any code is sent or machine made", async () => {
  const api = await identityApi();
  try {
    const { env, credentials } = await signedInMac();
    for (const args of [["login", "--email", "you@example.com"], ["login", "--email", "other@example.com", "--code", "123456"]]) {
      const result = await cli(args, { ...env, LOCALBOX_API_ORIGIN: api.origin });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /this Mac is already signed in to brave-walrus-482; run localbox logout first/);
      const json = await cli([...args, "--json"], { ...env, LOCALBOX_API_ORIGIN: api.origin });
      assert.equal(JSON.parse(json.stdout).error.code, "conflict");
    }
    assert.deepEqual(api.calls, [], "neither start nor verify was called");
    assert.ok(existsSync(credentials));
  } finally { api.close(); }
});

test("logout on a Mac removed from another machine still deletes its credentials", async () => {
  const api = await identityApi({ "/api/auth/logout": [401, { error: "this machine was removed; run localbox login" }] });
  try {
    const { env, credentials } = await signedInMac();
    const result = await cli(["logout", "--json"], { ...env, LOCALBOX_API_ORIGIN: api.origin });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(api.calls, ["/api/auth/logout"]);
    assert.ok(!existsSync(credentials), "the credential file is gone");
    const out = JSON.parse(result.stdout);
    assert.equal(out.signed_out, true); assert.match(out.machine, /already removed/);
  } finally { api.close(); }
});

test("logout refused for another reason keeps the credentials", async () => {
  const api = await identityApi({ "/api/auth/logout": [500, { error: "internal_error", error_description: "the request failed on our side; try again" }] });
  try {
    const { env, credentials } = await signedInMac();
    const result = await cli(["logout", "--json"], { ...env, LOCALBOX_API_ORIGIN: api.origin });
    assert.equal(result.code, 1); assert.ok(existsSync(credentials));
    const out = JSON.parse(result.stdout); assert.equal(out.operation, "logout"); assert.equal(out.error.code, "internal"); assert.equal(out.error.retryable, true);
  } finally { api.close(); }
});
