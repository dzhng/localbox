import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { machineAccess } from "../lib/machine-access.js";
import { fixtureImages, machineRoot, startConnector, stopConnector } from "../lib/login.js";
import { cli, signedInWithSandboxes, waitConnected } from "../lib/sandboxes.js";

export const id = "30";
export const tiers = ["u", "l"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  for (const started = Date.now(); Date.now() - started < timeoutMs; await sleep(200)) if (condition()) return;
  throw new Error(`${what} within ${timeoutMs / 1000} s`);
}

export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "u") {
    return [await ctx.check("image catalog through the relay, CLI columns and text/JSON parity, CLI layout and client relay", async () => {
      const result = await ctx.exec("npx", ["tsx", "--test", "tests/image-catalog.test.ts", "tests/cli-output.test.ts", "tests/cli-layout.test.ts", "tests/client-relay.test.ts", "tests/images-convex.test.ts", "tests/connector.test.ts"]);
      assert.equal(result.code, 0, result.stdout.slice(-2500));
    })];
  }
  const up = await ctx.stack("up", ["a", "b"]);
  if (up.code !== 0) throw new Error(`blocked: local stack did not start: ${(up.stderr || up.stdout).trim()}`);
  const run = Date.now(); const connectors: Record<string, ChildProcess | undefined> = {};
  const first = `rails-${String(run).slice(-6)}`; const renamed = `${first}-app`;
  const a = (args: string[]) => cli(ctx.root, "a", args);
  try {
    const checks: Check[] = [];
    let b!: Awaited<ReturnType<typeof machineAccess>>; let files = "";
    checks.push(await ctx.check("A and B sign in; B holds an image (files on disk, holder ready) and its daemon's mirror marks the files as listed by B", async () => {
      const setup = await signedInWithSandboxes(ctx.root, ["a", "b"], `proof-30-${run}@example.com`, { create: false });
      Object.assign(connectors, setup.connectors);
      b = await machineAccess(ctx.root, "b");
      const image = await b.mutation("images:reserve", { machineId: b.machineId, name: first, os: "linux", source: { kind: "sandbox", sandboxName: "bold-otter" }, createMutationId: `p30-${run}` });
      files = join(fixtureImages(machineRoot(ctx.root, "b")), image.image_id);
      mkdirSync(files, { recursive: true }); writeFileSync(join(files, "disk.img"), Buffer.alloc(1024 * 1024));
      await b.mutation("images:setHolder", { imageId: image.image_id, state: "ready", sizeBytes: 3 * 1024 ** 3 });
      await until(() => existsSync(join(files, ".listed-by")) && readFileSync(join(files, ".listed-by"), "utf8") === b.machineId, "the mirror marked the files listed by B");
    }));
    checks.push(await ctx.check("from A, image list shows the whole account under NAME OS SIZE FROM ON DEFAULT: linux on every Mac and default, the image on B", async () => {
      const text = await a(["image", "list"]);
      assert.equal(text.code, 0, text.stderr);
      const [header, ...rows] = text.stdout.trimEnd().split("\n");
      assert.match(header, /^NAME\s+OS\s+SIZE\s+FROM\s+ON\s+DEFAULT$/);
      assert.match(rows[0], /^linux\s+linux\s+-\s+release\s+every Mac\s+yes$/);
      assert.match(rows[1], new RegExp(`^${first}\\s+linux\\s+3 GiB\\s+sandbox bold-otter\\s+${b.machineName}$`));
      const json = await a(["image", "list", "--json"]);
      assert.deepEqual(json.envelope.result.images[1], { name: first, os: "linux", size_bytes: 3 * 1024 ** 3, from: "sandbox bold-otter", on: [b.machineName], default: false });
      writeFileSync(join(ctx.evidence, "30-image-list.txt"), text.stdout);
    }));
    checks.push(await ctx.check("image rename and image default report what changed", async () => {
      const rename = await a(["image", "rename", first, renamed, "--json"]);
      assert.equal(rename.envelope.ok, true, rename.stdout + rename.stderr);
      assert.deepEqual([rename.envelope.result.produced.previous_name, rename.envelope.result.produced.name], [first, renamed]);
      const made = await a(["image", "default", renamed, "--json"]);
      assert.equal(made.envelope.result.actions[0].kind, "made_default", made.stdout);
      assert.equal((await a(["image", "rename", "linux", "mine", "--json"])).envelope.error?.code, "invalid_input");
    }));
    checks.push(await ctx.check("with B's connector stopped, image delete from A drops the catalog row, says B deletes later and the default reset to linux; B's files are still there", async () => {
      stopConnector(connectors.b); await sleep(500);
      const deleted = await a(["image", "delete", renamed, "--confirm", renamed]);
      assert.equal(deleted.code, 0, deleted.stderr);
      assert.match(deleted.stdout, new RegExp(`${b.machineName} did not answer and removes its files when it reconnects`));
      assert.match(deleted.stdout, /the default is now linux/);
      assert.match(deleted.stdout, /sandboxes made from .* are unaffected/);
      assert.ok(existsSync(files), "the offline holder still has the files");
      const listed = await a(["image", "list", "--json"]);
      assert.deepEqual(listed.envelope.result.images.map((row: any) => [row.name, row.default]), [["linux", true]]);
      writeFileSync(join(ctx.evidence, "30-image-delete.txt"), deleted.stdout);
    }));
    checks.push(await ctx.check("when B's connector reconnects, its daemon removes the image's files and the connector logs why", async () => {
      connectors.b = startConnector(ctx.root, "b"); await waitConnected(ctx.root, "b");
      await until(() => !existsSync(files), "B removed the deleted image's files");
      await until(() => readFileSync(join(machineRoot(ctx.root, "b"), "logs/connector.log"), "utf8").includes("the account catalog no longer lists it here"), "the connector logged the deletion", 5_000);
    }));
    return checks;
  } finally {
    for (const child of Object.values(connectors)) stopConnector(child);
    if (!ctx.keep) await ctx.stack("down");
  }
}
