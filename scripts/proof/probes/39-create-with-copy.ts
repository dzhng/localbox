import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { machineAccess } from "../lib/machine-access.js";
import { startConnector, stopConnector } from "../lib/login.js";
import { cli, sandboxRecords, signedInWithSandboxes, waitConnected } from "../lib/sandboxes.js";

export const id = "39";
export const tiers = ["u", "l"];

const MiB = 1024 ** 2;
/** Long enough over the loopback transport (1 MiB every 50 ms, about 10 s) to act on the sandbox mid-copy. */
const SIZE = 192 * MiB;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `sandbox create --image X --machine B` where only A holds X: the create starts the copy, answers at once with the
 * sandbox `copying`, every operation on it answers `sandbox_not_ready` with the copy's progress, B's connector restarts
 * mid-copy, `image wait X` follows the copy until the sandbox is created, and then `shell exec` runs in it. Fixture
 * daemons copy over the loopback transport.
 */
export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("create with copy in the relay and Convex (copying state, sandbox_not_ready with progress, P7's local default), the chained create's report, placement", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/sandbox-create-copy.test.ts", "tests/connector.test.ts", "tests/sandbox-catalog.test.ts", "tests/placement.test.ts", "tests/image-copy-relay.test.ts", "tests/convex-auth.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2500));
    })];
  }
  return await fixtureStack(ctx);
}

async function fixtureStack(ctx: ProofContext): Promise<Check[]> {
  const up = await ctx.stack("up", ["a", "b"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const run = Date.now(); const suffix = String(run).slice(-6);
  const connectors: Record<string, ChildProcess | undefined> = {};
  const image = `copy-${suffix}`; const sandbox = `waits-${suffix}`; const mutation = `p39-${run}`;
  const aName = `studio-${suffix}`; const bName = `attic-${suffix}`;
  const evidence: string[] = [];
  const a = (args: string[]) => cli(ctx.root, "a", args);
  try {
    const checks: Check[] = [];
    let b!: Awaited<ReturnType<typeof machineAccess>>; let imageId = "";
    const journal = (key: string) => { const path = join(b.paths.operations, `${key}.json`); return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined; };
    const copyKey = `${mutation}-copy`;

    checks.push(await ctx.check("A and B sign in; only A holds a 192 MiB image (its files in A's store, its holding ready)", async () => {
      const setup = await signedInWithSandboxes(ctx.root, ["a", "b"], `proof-39-${run}@example.com`, { create: false });
      Object.assign(connectors, setup.connectors);
      const access = await machineAccess(ctx.root, "a"); b = await machineAccess(ctx.root, "b");
      // Proof machines share this Mac's host name; distinct names make `--machine` unambiguous.
      for (const [machine, id, wanted] of [["a", access.machineId, aName], ["b", b.machineId, bName]]) {
        const renamed = await cli(ctx.root, machine, ["machine", "rename", id, wanted]);
        assert.equal(renamed.code, 0, renamed.stdout + renamed.stderr);
      }
      const reserved = await access.mutation("images:reserve", { machineId: access.machineId, name: image, os: "linux", source: { kind: "sandbox", sandboxName: "bold-otter" }, createMutationId: `p39-capture-${run}` });
      imageId = reserved.image_id;
      const files = join(access.paths.images, imageId);
      mkdirSync(join(files, "boot"), { recursive: true });
      writeFileSync(join(files, "disk.img"), randomBytes(SIZE)); writeFileSync(join(files, "boot", "efi-vars"), "efi");
      writeFileSync(join(files, "image.json"), JSON.stringify({ image_id: imageId, os: "linux", size_bytes: SIZE, agent_version: "probe" }));
      await access.mutation("images:setHolder", { imageId, state: "ready", sizeBytes: SIZE });
    }));

    checks.push(await ctx.check("sandbox create --image X --machine B answers at once: copying, with the waiting line; B journals the copy and the create chained to it", async () => {
      const started = await a(["sandbox", "create", "--name", sandbox, "--image", image, "--machine", bName, "--mutation-id", mutation, "--json"]);
      assert.equal(started.envelope.ok, true, started.stdout + started.stderr);
      const report = started.envelope.result;
      assert.deepEqual([report.produced.state, report.produced.machine, report.produced.copying_from], ["copying", bName, aName], JSON.stringify(report));
      assert.equal(report.actions[0].detail, `sandbox ${sandbox} on ${bName} is waiting for image ${image} to copy (192 MiB); localbox image wait ${image}`);
      assert.equal(journal(copyKey)?.kind, "image.copy");
      assert.deepEqual([journal(mutation)?.kind, journal(mutation)?.subject], ["sandbox.create_after_copy", imageId]);
      assert.equal(sandboxRecords(ctx.root, "b").some((row) => row.name === sandbox), false, "nothing is laid down before the image is there");
      evidence.push(`$ localbox sandbox create --name ${sandbox} --image ${image} --machine ${bName} --json\n${started.stdout}`);
    }));

    checks.push(await ctx.check("mid-copy, shell exec answers sandbox_not_ready with the copy's progress (from the relay) and sandbox status shows it", async () => {
      for (let waited = 0; (journal(copyKey)?.progress?.completed ?? 0) < 8 * MiB; waited += 50) {
        if (waited > 30_000) throw new Error(`the copy never started moving bytes: ${JSON.stringify(journal(copyKey))}`);
        await sleep(50);
      }
      const exec = await a(["shell", "exec", "--sandbox", sandbox, "--json", "--", "echo", "hi"]);
      assert.equal(exec.envelope.error?.code, "sandbox_not_ready", exec.stdout + exec.stderr);
      assert.match(exec.envelope.error.message, new RegExp(`^${sandbox} on ${bName} is waiting for image ${image} to copy \\((\\d+ MiB of 192 MiB|[a-z ]+)\\); follow it with: localbox image wait ${image}$`));
      assert.ok(exec.envelope.error.details.progress, JSON.stringify(exec.envelope.error));
      const status = await a(["sandbox", "status", sandbox, "--json"]);
      assert.deepEqual([status.envelope.result?.state, status.envelope.result?.next_step], ["copying", `localbox image wait ${image}`], status.stdout + status.stderr);
      evidence.push(`$ localbox shell exec --sandbox ${sandbox} -- echo hi --json\n${exec.stdout}${exec.stderr}`, `$ localbox sandbox status ${sandbox} --json\n${status.stdout}`);
      assert.equal(journal(copyKey).state, "running", "still copying after both answers");
    }));

    checks.push(await ctx.check("B's connector restarts mid-copy: while it is down the relay still answers from the catalog, and the copy carries on", async () => {
      stopConnector(connectors.b); connectors.b = undefined;
      const down = await a(["shell", "exec", "--sandbox", sandbox, "--json", "--", "echo", "hi"]);
      assert.equal(down.envelope.error?.code, "sandbox_not_ready", down.stdout + down.stderr);
      assert.match(down.envelope.error.message, /\(the copy has not reported progress yet\)/, "B can't be asked, so the catalog answers");
      writeFileSync(join(b.paths.logs, "connector.log"), "");
      connectors.b = startConnector(ctx.root, "b");
      await waitConnected(ctx.root, "b");
      assert.notEqual(journal(mutation).state, "failed", JSON.stringify(journal(mutation)));
    }));

    checks.push(await ctx.check("image wait follows the copy until the sandbox is created: the copy's line, then the sandbox's", async () => {
      let done: any;
      for (let attempt = 0; ; attempt++) {
        const waited = await a(["image", "wait", image, "--timeout-ms", "20000", "--json"]);
        assert.equal(waited.envelope.ok, true, waited.stdout + waited.stderr);
        done = waited.envelope.result;
        if (done.state === "ready") break;
        assert.equal(done.state, "copying", JSON.stringify(done));
        if (attempt > 8) throw new Error(`still copying after ${attempt} waits: ${JSON.stringify(done)}`);
      }
      // The real transport can land the copy and the create before this wait starts; the catalog then answers where the
      // image is, and the sandbox's own record proves the create.
      if (done.report[0].startsWith("copied image")) {
        assert.match(done.report[0], new RegExp(`^copied image ${image} from ${aName} to ${bName} \\(192 MiB, [\\d.]+ s, local network\\)$`), JSON.stringify(done));
        assert.match(done.report[1], new RegExp(`^created sandbox ${sandbox} on ${bName}: \\d+ CPUs and [\\d.]+ GiB, running$`));
      } else {
        assert.match(done.report[0], new RegExp(`^image ${image} is ready on .*${bName}`), JSON.stringify(done));
      }
      assert.equal(sandboxRecords(ctx.root, "b").find((row) => row.name === sandbox)?.image_id, imageId, "B's record names the copied image");
      evidence.push(`$ localbox image wait ${image}\n${done.report.join("\n")}`);
    }));

    checks.push(await ctx.check("once B reports the create, shell exec runs in the new sandbox", async () => {
      for (let waited = 0; ; waited += 250) {
        const listed = await a(["sandbox", "list", "--json"]);
        const row = listed.envelope.result?.sandboxes?.find((candidate: any) => candidate.name === sandbox);
        if (row && row.state !== "copying") { assert.equal(row.error, null, JSON.stringify(row)); break; }
        if (waited > 15_000) throw new Error(`the sandbox still reads copying: ${listed.stdout}`);
        await sleep(250);
      }
      const exec = await a(["shell", "exec", "--sandbox", sandbox, "--json", "--", "echo", `ran-${suffix}`]);
      assert.equal(exec.envelope.ok, true, exec.stdout + exec.stderr);
      assert.match(JSON.stringify(exec.envelope.result), new RegExp(`ran-${suffix}`));
      assert.equal(journal(mutation).state, "succeeded");
      evidence.push(`$ localbox shell exec --sandbox ${sandbox} -- echo ran-${suffix} --json\n${exec.stdout}`);
    }));
    return checks;
  } finally {
    writeFileSync(join(ctx.evidence, "39-create-with-copy.txt"), evidence.join("\n\n"));
    for (const child of Object.values(connectors)) stopConnector(child);
    if (!ctx.keep) await ctx.stack("down");
  }
}
