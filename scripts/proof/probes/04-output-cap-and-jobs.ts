import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { asMachine } from "../lib/as-machine.js";

export const id = "04";
export const tiers = ["u", "l"];

const CAP_BYTES = 900 * 1024;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("900 KiB cap, fs.read and job.output paging, real background jobs", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/output-cap.test.ts", "tests/guest-jobs.test.ts", "tests/guest-gateway.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2000));
    })];
  }
  // Tier l: the same contract through fixture machine A's CLI, over local IPC and the guest frame protocol.
  const up = await ctx.stack("up", ["a"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const run = Date.now(); let call = 0;
  const invoke = async (operation: string, input: unknown, mutating = false): Promise<any> => {
    const args = ["invoke", "--json", operation, "--input-json", JSON.stringify(input), "--request-id", `p04-${run}-${call++}`, ...(mutating ? ["--mutation-id", `p04-${run}-${call}`] : [])];
    const result = await asMachine("a", args, { cwd: ctx.root, env: { LOCALBOX_TRANSPORT: "local" } });
    const envelope = JSON.parse(result.stdout.trim() || "{}");
    assert.equal(envelope.ok, true, `${operation}: ${result.stdout.slice(0, 1500)}${result.stderr}`);
    return envelope.result;
  };
  const guestRoot = join(ctx.root, ".localbox/proof/machines/a/sandboxes/vm_01/root");
  try {
    const checks: Check[] = [];
    checks.push(await ctx.check("a 2 MiB fs.read is capped at 900 KiB and pages back to the exact sha256", async () => {
      await invoke("shell.exec", { command: "head -c 1572864 /dev/urandom | base64 | tr -d '\\n' | head -c 2097152 > big.txt", cwd: "/" }, true);
      const first = await invoke("fs.read", { path: "/big.txt" });
      assert.equal(first.truncated?.original_bytes, 2_097_152);
      assert.ok(first.truncated.returned_bytes <= CAP_BYTES, `returned ${first.truncated.returned_bytes} bytes`);
      let text = first.content as string; let page = first;
      while (!page.eof) { page = await invoke("fs.read", { path: "/big.txt", offset: page.next_offset }); text += page.content; }
      assert.equal(sha256(text), sha256(readFileSync(join(guestRoot, "big.txt"))));
    }));
    checks.push(await ctx.check("a background job writing 3 MiB pages back fully", async () => {
      const started = await invoke("shell.exec", { command: "head -c 3145728 /dev/zero | tr '\\0' y", background: true }, true);
      const waited = await invoke("job.wait", { job_id: started.job_id, timeout_ms: 30_000 });
      assert.equal(waited.status, "completed");
      let text = ""; let offset = 0;
      for (;;) { const page = await invoke("job.output", { job_id: started.job_id, offset }); text += page.data; offset = page.next_offset; if (page.eof) break; }
      assert.equal(text.length, 3_145_728); assert.equal(sha256(text), sha256("y".repeat(3_145_728)));
    }));
    checks.push(await ctx.check("cancel kills the job's process group", async () => {
      const seconds = 3000 + (run % 997); // a distinctive duration, so pgrep finds only this job's sleeps
      const started = await invoke("shell.exec", { command: `sleep ${seconds} & sleep ${seconds}`, background: true }, true);
      assert.equal((await invoke("guest.activity", {})).running_jobs, 1);
      await invoke("job.cancel", { job_id: started.job_id }, true);
      assert.equal((await invoke("job.wait", { job_id: started.job_id, timeout_ms: 10_000 })).status, "cancelled");
      assert.equal((await invoke("guest.activity", {})).running_jobs, 0);
      const survivors = await ctx.exec("pgrep", ["-f", `sleep ${seconds}`]);
      assert.equal(survivors.stdout.trim(), "", "no process from the cancelled job's group survives");
    }));
    return checks;
  } finally { if (!ctx.keep) await ctx.stack("down"); }
}
