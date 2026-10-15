import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { machineRoot, stopConnector } from "../lib/login.js";
import { cli, createSandbox, guestRoot, sandboxRecords, signedInWithSandboxes } from "../lib/sandboxes.js";

export const id = "09";
export const tiers = ["u", "l"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NAME = /^[a-z]+-[a-z]+$/;
type Leaf = { key: string; value: unknown; inAction: boolean };

/** Every scalar of a result (or error) with the key it sits under. */
function leaves(value: unknown, key = "", inAction = false): Leaf[] {
  if (Array.isArray(value)) return value.flatMap((item) => leaves(item, key, inAction || key === "actions"));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([child, item]) => leaves(item, child, inAction || key === "actions"));
  return [{ key, value, inAction }];
}
const factsOf = (envelope: any) => leaves(envelope.ok ? envelope.result : { code: envelope.error.code, message: envelope.error.message, details: envelope.error.details });

/**
 * Text and `--json` carry the same facts: every value of the JSON result appears in the text, except `volatile` keys
 * when the text comes from a twin run (a second create, a rename back); then the key names must still appear.
 */
function sameFacts(label: string, envelope: any, text: string, volatile: string[] = []): void {
  for (const leaf of factsOf(envelope)) {
    if (leaf.value === null || leaf.value === undefined) continue;
    if (volatile.includes(leaf.key)) { if (!leaf.inAction && leaf.key) assert.ok(text.includes(`${leaf.key}:`), `${label}: text lacks the fact ${leaf.key}\n${text}`); continue; }
    assert.ok(text.includes(String(leaf.value)), `${label}: text lacks ${leaf.key} = ${JSON.stringify(leaf.value)}\n${text}`);
  }
}

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("catalog executors and sandbox_id rule, Convex sandbox catalog, CLI text/JSON parity, regenerated snapshots", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/contract-executor.test.ts", "tests/sandbox-catalog.test.ts", "tests/cli-output.test.ts", "tests/contract.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2000));
    })];
  }
  const up = await ctx.stack("up", ["a", "b"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const run = Date.now(); const transcript: string[] = [];
  const as = async (machine: string, args: string[]) => {
    const result = await cli(ctx.root, machine, args);
    transcript.push(`$ [${machine}] localbox ${args.join(" ")}\n${result.stdout}${result.stderr}(exit ${result.code})\n`);
    return result;
  };
  /** A read-only or failing command, run once each way. */
  const both = async (label: string, machine: string, args: string[], volatile: string[] = []) => {
    const split = args.includes("--") ? args.indexOf("--") : args.length;
    const json = await as(machine, [...args.slice(0, split), "--json", ...args.slice(split)]); const text = await as(machine, args);
    sameFacts(label, json.envelope, text.stdout + text.stderr, volatile);
    assert.equal(json.code, text.code, `${label}: both modes exit alike`);
    return json.envelope;
  };
  let setup: Awaited<ReturnType<typeof signedInWithSandboxes>> | undefined;
  let machineA = ""; const names: string[] = [];
  try {
    const checks: Check[] = [];
    checks.push(await ctx.check("A and B sign in with one email and their connectors connect", async () => {
      setup = await signedInWithSandboxes(ctx.root, ["a", "b"], `proof-09-${run}@example.com`, { create: false });
      machineA = JSON.parse(readFileSync(join(machineRoot(ctx.root, "a"), "credentials.json"), "utf8")).machine_name;
    }));
    checks.push(await ctx.check("two sandbox creates on A get distinct adjective-animal names; each cold-boots its own runtime and explains its size", async () => {
      const first = await createSandbox(ctx.root, "a");
      transcript.push(`$ [a] localbox sandbox create --json\n${first.stdout}`);
      const second = await as("a", ["sandbox", "create"]);
      assert.equal(second.code, 0, second.stderr);
      const report = first.envelope.result;
      names.push(report.produced.name, second.stdout.match(/^\s*name: (\S+)$/m)?.[1] ?? "");
      assert.match(names[0], NAME); assert.match(names[1], NAME); assert.notEqual(names[0], names[1]);
      assert.deepEqual(report.actions.map((action: any) => action.kind), ["created", "cold_booted"]);
      assert.match(report.produced.size_reason, /^default for .+: half its \d+ CPUs and a quarter of its/);
      assert.equal(report.produced.machine, machineA);
      assert.match(second.stdout, /^- created: /m); assert.match(second.stdout, /^- cold_booted: /m, "each sandbox boots its own runtime");
      sameFacts("sandbox create", first.envelope, second.stdout, ["sandbox_id", "name", "kind", "detail"]);
    }));
    checks.push(await ctx.check("sandbox create --name <taken> fails name_conflict listing the names", async () => {
      const envelope = await both("sandbox create --name taken", "a", ["sandbox", "create", "--name", names[0]]);
      assert.equal(envelope.error.code, "name_conflict");
      for (const name of names) assert.match(envelope.error.message, new RegExp(name));
    }));
    checks.push(await ctx.check("shell exec without --sandbox fails sandbox_ambiguous listing both", async () => {
      const envelope = await both("shell exec (ambiguous)", "a", ["shell", "exec", "--", "echo", "hi"]);
      assert.equal(envelope.error.code, "sandbox_ambiguous"); assert.deepEqual([...envelope.error.details.names].sort(), [...names].sort());
    }));
    checks.push(await ctx.check("from B, shell exec --sandbox <A's sandbox> runs on A without naming a machine", async () => {
      const marker = `from-b-${run}`;
      const envelope = await both("shell exec (remote)", "b", ["shell", "exec", "--sandbox", names[0], "--", "sh", "-c", `touch ${marker}; echo ran-${run}`], ["duration_ms"]);
      assert.equal(envelope.ok, true, JSON.stringify(envelope)); assert.equal(envelope.result.stdout.trim(), `ran-${run}`);
      assert.ok(existsSync(join(guestRoot(ctx.root, "a", names[0]), marker)), "it ran in that sandbox's own root");
      assert.ok(!existsSync(join(guestRoot(ctx.root, "a", names[1]), marker)), "and not in A's other sandbox");
    }));
    checks.push(await ctx.check("rename on A shows in sandbox list on B, with A's reported state", async () => {
      const renamed = `renamed-${run % 100000}`;
      const result = await as("a", ["sandbox", "rename", names[0], renamed, "--json"]);
      assert.equal(result.envelope.ok, true, result.stdout + result.stderr);
      assert.deepEqual(result.envelope.result.produced, { sandbox_id: result.envelope.result.produced.sandbox_id, name: renamed, previous_name: names[0], machine: machineA });
      const back = await as("a", ["sandbox", "rename", renamed, names[0]]);
      sameFacts("sandbox rename", result.envelope, back.stdout, ["name", "previous_name", "detail"]);
      const again = await as("a", ["sandbox", "rename", names[0], renamed, "--json"]); assert.equal(again.envelope.ok, true);
      names[0] = renamed;
      let listed: any;
      for (let attempt = 0; attempt < 40; attempt++) { listed = await both("sandbox list", "b", ["sandbox", "list"], ["reported_at"]); if (listed.result.sandboxes.every((row: any) => row.state === "running")) break; await sleep(250); }
      assert.deepEqual(listed.result.sandboxes.map((row: any) => row.name).sort(), [...names].sort());
      assert.ok(listed.result.sandboxes.every((row: any) => row.machine_name === machineA && row.state === "running"), JSON.stringify(listed.result));
      assert.deepEqual(sandboxRecords(ctx.root, "a").map((row) => row.name).sort(), [...names].sort(), "A's sandbox records follow the catalog");
    }));
    checks.push(await ctx.check("delete reports exactly what was removed, from the account and from A", async () => {
      const deleted = await as("a", ["sandbox", "delete", names[0], "--json"]);
      assert.equal(deleted.envelope.ok, true, deleted.stdout + deleted.stderr);
      assert.deepEqual(deleted.envelope.result.produced.removed, ["account catalog entry", `sandbox identity on ${machineA}`, `guest root on ${machineA}`]);
      assert.deepEqual(deleted.envelope.result.actions.map((action: any) => action.kind), ["deleted"]);
      const text = await as("a", ["sandbox", "delete", names[1], "--confirm", names[1]]);
      assert.equal(text.code, 0, text.stderr); assert.match(text.stdout, /^- deleted: /m);
      sameFacts("sandbox delete", deleted.envelope, text.stdout, ["sandbox_id", "name", "detail", "confirm"]);
      const listed = await both("sandbox list (empty)", "b", ["sandbox", "list"]);
      assert.deepEqual(listed.result.sandboxes, []);
      assert.deepEqual(sandboxRecords(ctx.root, "a"), [], "delete removed A's sandbox directories");
      const none = await both("shell exec (no sandboxes)", "a", ["shell", "exec", "--", "true"]);
      assert.equal(none.error.code, "sandbox_not_found");
    }));
    return checks;
  } finally {
    writeFileSync(join(ctx.evidence, "09-transcript.txt"), transcript.join("\n"));
    for (const child of Object.values(setup?.connectors ?? {})) stopConnector(child);
    if (!ctx.keep) await ctx.stack("down");
  }
}
