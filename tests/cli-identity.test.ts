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

/** A stand-in identity API that records each path called and answers `logout` with `logoutStatus`. */
async function identityApi(logoutStatus: number): Promise<{ origin: string; calls: string[]; close(): void }> {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url ?? "");
    const status = request.url === "/api/auth/logout" ? logoutStatus : 200;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(status === 401 ? { error: "this machine was removed; run localbox login" } : { message: "code sent", revoked: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, calls, close: () => server.close() };
}

async function signedInMac(): Promise<{ env: NodeJS.ProcessEnv; credentials: string }> {
  const home = await mkdtemp(join(tmpdir(), "localbox-cli-identity-"));
  const env = { HOME: home, LOCALBOX_MACHINE_ROOT: join(home, "machine"), LOCALBOX_SKIP_LAUNCHD: "1" };
  const credentials = machinePaths(env).credentials;
  await writeCredentials(credentials, { api_origin: "", convex_url: "", account_id: "account_1", account_name: "brave-walrus-482", machine_id: "machine_1", machine_name: "studio", secret: "s" });
  return { env, credentials };
}

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(process.execPath, ["bin/localbox.js", ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })));
}

test("login on a signed-in Mac is refused before any code is sent or machine made", async () => {
  const api = await identityApi(200);
  try {
    const { env, credentials } = await signedInMac();
    for (const args of [["login", "--email", "you@example.com"], ["login", "--email", "other@example.com", "--code", "123456"]]) {
      const result = await cli(args, { ...env, LOCALBOX_API_ORIGIN: api.origin });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /this Mac is already signed in to brave-walrus-482; run localbox logout first/);
    }
    assert.deepEqual(api.calls, [], "neither start nor verify was called");
    assert.ok(existsSync(credentials));
  } finally { api.close(); }
});

test("logout on a Mac removed from another machine still deletes its credentials", async () => {
  const api = await identityApi(401);
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
  const api = await identityApi(500);
  try {
    const { env, credentials } = await signedInMac();
    const result = await cli(["logout"], { ...env, LOCALBOX_API_ORIGIN: api.origin });
    assert.equal(result.code, 1); assert.ok(existsSync(credentials));
  } finally { api.close(); }
});
