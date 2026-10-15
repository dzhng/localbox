import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { asMachine } from "../lib/as-machine.js";
import { API_ORIGIN, stopConnector } from "../lib/login.js";
import { guestRoot, signedInWithSandboxes } from "../lib/sandboxes.js";
import { machinePaths } from "../../../packages/config/src/machine-paths.js";
import { LocalIPCTransport } from "../../../packages/client/src/index.js";
import { requestFromInvocation } from "../../../packages/contract/src/index.js";

export const id = "03";
export const tiers = ["u", "l"];

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("fixture backend round trip and opt-in refusal (Swift)", async () => {
      const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "testProcessFixtureSandboxesEachRunTheirOwnGuest|testFixtureBackendRefusedWithoutOptIn"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2000));
      assert.match(result.stdout + result.stderr, /Executed 2 tests, with 0 failures/);
    })];
  }
  const up = await ctx.stack("up", ["a", "b"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const paths = (machine: string) => machinePaths({ LOCALBOX_MACHINE_ROOT: join(ctx.root, ".localbox/proof/machines", machine) });
  const cli = (machine: string, args: string[]) => asMachine(machine, args, { cwd: ctx.root, env: { LOCALBOX_API_ORIGIN: API_ORIGIN } });
  // Sandboxes are created through the account, so both machines sign in and each gets one sandbox.
  let setup: Awaited<ReturnType<typeof signedInWithSandboxes>> | undefined;
  const exec = async (machine: string, command: string[]) => {
    const result = await cli(machine, ["shell", "exec", "--sandbox", setup!.sandboxes[machine], "--json", "--", ...command]);
    return { ...result, envelope: JSON.parse(result.stdout.trim() || "{}") as { ok?: boolean; result?: { stdout?: string }; error?: { code?: string; message?: string } } };
  };
  try {
    const checks: Check[] = [];
    checks.push(await ctx.check("A and B sign in and each gets a sandbox", async () => { setup = await signedInWithSandboxes(ctx.root, ["a", "b"], `proof-03-${Date.now()}@example.com`); }));
    checks.push(await ctx.check("machines A and B both run shell exec -- echo", async () => {
      for (const machine of ["a", "b"]) {
        const result = await exec(machine, ["echo", `hello from ${machine}`]);
        assert.equal(result.envelope.ok, true, result.stdout + result.stderr);
        assert.equal(result.envelope.result?.stdout?.trim(), `hello from ${machine}`);
      }
    }));
    checks.push(await ctx.check("each machine has its own guest root", async () => {
      const marker = `only-a-${Date.now()}`;
      const result = await exec("a", ["touch", marker]); assert.equal(result.envelope.ok, true, result.stdout + result.stderr);
      assert.ok(existsSync(join(guestRoot(ctx.root, "a", setup!.sandboxes.a), marker)), "A's file is in A's guest root");
      assert.ok(!existsSync(join(guestRoot(ctx.root, "b", setup!.sandboxes.b), marker)), "A's file must not appear in B's guest root");
    }));
    // The daemons themselves, over local IPC: a CLI whose daemon refuses it goes on to the agent API instead.
    const daemonB = (token?: string) => new LocalIPCTransport({ socketPath: paths("b").socket, ...(token ? { token } : { tokenFile: paths("b").ipcToken }) }).dispatch(requestFromInvocation({ operation: "sandbox.list", input: {} }));
    checks.push(await ctx.check("A's IPC token is refused on B's socket", async () => {
      const tokenA = readFileSync(paths("a").ipcToken, "utf8").trim();
      assert.notEqual(tokenA, readFileSync(paths("b").ipcToken, "utf8").trim());
      const refused = await daemonB(tokenA);
      assert.equal(refused.ok, false, JSON.stringify(refused)); assert.equal(!refused.ok && refused.error.code, "unauthorized");
      assert.equal((await daemonB()).ok, true, "B's own token is accepted");
    }));
    checks.push(await ctx.check("killing B's daemon leaves A working; B reports guest_unreachable naming its socket", async () => {
      const pid = Number(readFileSync(join(ctx.root, ".localbox/proof/pids/hostd-b.pid"), "utf8"));
      process.kill(-pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const a = await exec("a", ["echo", "still here"]); assert.equal(a.envelope.ok, true, a.stdout + a.stderr); assert.equal(a.envelope.result?.stdout?.trim(), "still here");
      const b = await daemonB();
      assert.equal(b.ok, false, JSON.stringify(b)); assert.equal(!b.ok && b.error.code, "guest_unreachable");
      assert.ok(!b.ok && b.error.message.includes(paths("b").socket), `message names the socket: ${JSON.stringify(b)}`);
    }));
    return checks;
  } finally {
    for (const child of Object.values(setup?.connectors ?? {})) stopConnector(child);
    if (!ctx.keep) await ctx.stack("down");
  }
}
