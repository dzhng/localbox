import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { runConnector } from "../apps/connector/src/index.js";
import { writeCredentials } from "../packages/credentials/src/index.js";

// The machine-token endpoint refuses every secret, as it does for a removed machine: the connector's first token
// request fails with RevokedError. The secrets it was asked for say which sign-in each connection used.
let server: Server, origin = "";
const asked: string[] = [];
before(async () => {
  server = createServer((request, response) => { asked.push(request.headers.authorization ?? ""); response.writeHead(401).end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => { server.close(); });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const machine = async () => {
  const root = await mkdtemp(join(tmpdir(), "localbox-connector-"));
  const signIn = (secret: string) => writeCredentials(join(root, "credentials.json"), { api_origin: origin, convex_url: "http://127.0.0.1:1", account_id: "a", account_name: "A", machine_id: "m", machine_name: "mac", secret });
  return { env: { LOCALBOX_MACHINE_ROOT: root, LOCALBOX_API_ORIGIN: origin }, signIn };
};
async function until(check: () => boolean, what: string): Promise<void> {
  for (const deadline = Date.now() + 5_000; !check(); await sleep(20)) if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
}

test("supervised, the connector waits for a sign-in, waits again after a revoke, and exits 0 when stdin closes", async () => {
  asked.length = 0;
  const { env, signIn } = await machine();
  const input = new PassThrough();
  let code: number | undefined;
  const running = runConnector(env, { supervised: true, input, pollMs: 50 }).then((value) => { code = value; });
  await sleep(300);
  assert.equal(code, undefined, "signed out, it keeps running");
  assert.deepEqual(asked, []);

  await signIn("first");
  await until(() => asked.length === 1, "the first sign-in's token request");
  assert.equal(asked[0], "Bearer first");
  await sleep(300);
  assert.equal(code, undefined, "revoked, it keeps running");
  assert.equal(asked.length, 1, "the revoked credential is not retried");

  await signIn("second");
  await until(() => asked.length === 2, "the second sign-in's token request");
  assert.equal(asked[1], "Bearer second");

  input.end();
  await running;
  assert.equal(code, 0);
});

test("unsupervised (the launchd job), it exits 0 when signed out and when revoked, as before", async () => {
  asked.length = 0;
  const { env, signIn } = await machine();
  assert.equal(await runConnector(env), 0);
  assert.deepEqual(asked, []);
  await signIn("only");
  assert.equal(await runConnector(env), 0);
  assert.deepEqual(asked, ["Bearer only"]);
});
