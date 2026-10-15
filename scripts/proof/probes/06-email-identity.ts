import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { asMachine } from "../lib/as-machine.js";
import { waitForCode } from "../lib/codes.js";
import { login as signIn } from "../lib/login.js";

export const id = "06";
export const tiers = ["u", "l"];

const devLog = (root: string) => join(root, ".localbox/proof/dev-local.log");
const logSize = (root: string) => statSync(devLog(root)).size;
const codeLines = (root: string, email: string, since: number) =>
  readFileSync(devLog(root)).subarray(since).toString("utf8").split("\n").filter((line) => line.includes("localbox.dev.email_code") && line.includes(email)).length;

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("sign-in, names, credentials and mailer unit tests", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/signin.test.ts", "tests/names.test.ts", "tests/credentials-file.test.ts", "tests/mailer.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2000));
    })];
  }
  const up = await ctx.stack("up", ["a", "b"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const run = Date.now();
  const env = (machine: string) => ({ LOCALBOX_API_ORIGIN: "http://127.0.0.1:3000", LOCALBOX_TRANSPORT: "remote", LOCALBOX_MACHINE_ROOT: join(ctx.evidence, "machines", machine) });
  const cli = (machine: string, args: string[]) => asMachine(machine, args, { cwd: ctx.root, env: env(machine) });
  const login = (machine: string, email: string) => signIn(ctx.root, machine, email, env(machine));
  const startCode = (email: string) => fetch("http://127.0.0.1:3000/api/auth/email/start", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "6.6.6.6" }, body: JSON.stringify({ email }) });
  try {
    const email = `proof-${run}@example.com`;
    const checks: Check[] = [];
    checks.push(await ctx.check("machines A and B sign in with one email; B sees 2 machines", async () => {
      const a = await login("a", email); assert.equal(a.code, 0, a.stderr);
      const b = await login("b", email); assert.equal(b.code, 0, b.stderr); assert.match(b.stdout, /2 machines/);
    }));
    checks.push(await ctx.check("login again on a signed-in Mac is refused before a code is sent; the account keeps 2 machines", async () => {
      const since = logSize(ctx.root);
      const again = await cli("a", ["login", "--email", email]); assert.equal(again.code, 1);
      assert.match(again.stderr, /this Mac is already signed in to [a-z0-9-]+; run localbox logout first/);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(codeLines(ctx.root, email, since), 0, "no code was sent");
      const listed = await cli("a", ["machine", "list", "--json"]); assert.equal(JSON.parse(listed.stdout).result.length, 2);
    }));
    checks.push(await ctx.check("credentials.json is mode 0600", () => {
      assert.equal(statSync(join(ctx.evidence, "machines/a/credentials.json")).mode & 0o777, 0o600);
    }));
    checks.push(await ctx.check("removing machine B from A revokes B", async () => {
      const listed = await cli("a", ["machine", "list", "--json"]); assert.equal(listed.code, 0, listed.stderr);
      const b = JSON.parse(readFileSync(join(ctx.evidence, "machines/b/credentials.json"), "utf8"));
      assert.match(listed.stdout, new RegExp(b.machine_id));
      const removed = await cli("a", ["machine", "remove", b.machine_id, "--json"]); assert.equal(removed.code, 0, removed.stderr);
      const denied = await cli("b", ["machine", "list"]); assert.notEqual(denied.code, 0); assert.match(denied.stderr + denied.stdout, /removed|login/);
      const loggedOut = await cli("b", ["logout", "--json"]); assert.equal(loggedOut.code, 0, loggedOut.stderr);
      assert.match(JSON.parse(loggedOut.stdout).machine, /already removed/); assert.ok(!existsSync(join(ctx.evidence, "machines/b/credentials.json")), "a removed Mac can still log out");
    }));
    checks.push(await ctx.check("a sixth send in an hour still says 'code sent' but issues no code", async () => {
      const limited = `proof-limit-${run}@example.com`; const since = logSize(ctx.root);
      for (let index = 0; index < 6; index++) { const response = await startCode(limited); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { message: "code sent" }); }
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(codeLines(ctx.root, limited, since), 5);
    }));
    checks.push(await ctx.check("five wrong guesses kill the code", async () => {
      const guessed = `proof-guess-${run}@example.com`; const since = logSize(ctx.root);
      // A Mac that is not signed in: a signed-in one refuses login before sending a code.
      assert.equal((await cli("guess", ["login", "--email", guessed])).code, 0);
      const code = await waitForCode(guessed, { sinceByte: since, logPath: devLog(ctx.root) });
      const wrong = code === "000000" ? "000001" : "000000";
      for (let index = 0; index < 5; index++) assert.notEqual((await cli("guess", ["login", "--email", guessed, "--code", wrong])).code, 0);
      assert.notEqual((await cli("guess", ["login", "--email", guessed, "--code", code])).code, 0, "the real code still worked after five wrong guesses");
    }));
    checks.push(await ctx.check("a spoofed x-forwarded-for does not become the rate-limit key", async () => {
      await startCode(`proof-ip-${run}@example.com`);
      const data = await ctx.exec("npx", ["convex", "data", "rateLimits", "--format", "jsonLines", "--limit", "1000"], { env: { CONVEX_AGENT_MODE: "anonymous" } });
      assert.equal(data.code, 0, data.stderr);
      assert.doesNotMatch(data.stdout, /6\.6\.6\.6/); assert.match(data.stdout, /127\.0\.0\.1/);
    }));
    return checks;
  } finally { if (!ctx.keep) await ctx.stack("down"); }
}
