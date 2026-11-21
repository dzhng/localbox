import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { GuestControl, syncOnlyCommands, type AgentUpdateOptions } from "../packages/guest-gateway/src/index.js";
import { decodeGuestFrames, encodeGuestFrame, type ControlFrame } from "../packages/guest-gateway/src/protocol.js";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** An agent installed at `<dir>/localbox-agent` holding `old`, with an update hook that records exits and jobs. */
async function installed(old = Buffer.from("old agent")) {
  const directory = await mkdtemp(join(tmpdir(), "localbox-self-update-"));
  const binary = join(directory, "localbox-agent");
  await writeFile(binary, old, { mode: 0o755 });
  const state = { jobs: 0, exits: 0, swapped: [] as string[] };
  const update: AgentUpdateOptions = { binary, runningJobs: () => state.jobs, exit: () => { state.exits += 1; }, afterSwap: async (path) => { state.swapped.push(path); } };
  return { directory, binary, state, control: new GuestControl({ commands: syncOnlyCommands, update }) };
}

function connect(control: GuestControl) {
  const toGuest = new PassThrough(); const fromGuest = new PassThrough();
  const served = control.serve(toGuest, fromGuest);
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0); const answers: ControlFrame[] = []; const waiters: Array<() => void> = [];
  fromGuest.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); const decoded = decodeGuestFrames<ControlFrame>(buffer); buffer = decoded.remainder; answers.push(...decoded.frames); waiters.splice(0).forEach((wake) => wake()); });
  const ask = async (frame: ControlFrame): Promise<ControlFrame> => {
    toGuest.write(encodeGuestFrame(frame));
    while (!answers.length) await new Promise<void>((wake) => waiters.push(wake));
    return answers.shift()!;
  };
  return { served, ask, drop: () => toGuest.end() };
}

/** Sends `binary` as the host does: the header, then chunks of `chunkBytes`. Returns every answer. */
async function push(lane: ReturnType<typeof connect>, binary: Buffer, chunkBytes: number, announced = sha256(binary)): Promise<ControlFrame[]> {
  const answers = [await lane.ask({ kind: "agent.update", version: "0.2.0+abcdefabcdef", sha256: announced, size: binary.byteLength })];
  if (answers[0].kind !== "agent.receiving") return answers;
  for (let offset = 0; offset < binary.byteLength; offset += chunkBytes) {
    answers.push(await lane.ask({ kind: "agent.chunk", offset, data: binary.subarray(offset, offset + chunkBytes).toString("base64") }));
  }
  return answers;
}

test("chunks reassemble into the announced binary, which replaces the agent; it exits only after answering", async () => {
  const agent = await installed();
  const lane = connect(agent.control);
  const next = randomBytes(300_001);
  const answers = await push(lane, next, 100_000);
  assert.deepEqual(answers.map((answer) => answer.kind), ["agent.receiving", "agent.received", "agent.received", "agent.received", "updated"]);
  assert.deepEqual(answers.at(-1), { kind: "updated", version: "0.2.0+abcdefabcdef" });
  assert.deepEqual(answers[2], { kind: "agent.received", bytes: 200_000 });
  assert.ok((await readFile(agent.binary)).equals(next), "the new binary is in place, byte for byte");
  assert.equal((await stat(agent.binary)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(agent.directory), ["localbox-agent"], "no temp file is left beside it");
  assert.deepEqual(agent.state.swapped, [agent.binary], "the after-swap hook ran on the installed path");
  assert.equal(agent.state.exits, 1);
});

test("the running binary is untouched until the last chunk verifies, and a sha mismatch keeps it", async () => {
  const old = Buffer.from("old agent");
  const agent = await installed(old);
  const lane = connect(agent.control);
  const next = randomBytes(64_000);
  await lane.ask({ kind: "agent.update", version: "0.2.0+abcdefabcdef", sha256: sha256(Buffer.from("something else")), size: next.byteLength });
  await lane.ask({ kind: "agent.chunk", offset: 0, data: next.subarray(0, 32_000).toString("base64") });
  assert.ok((await readFile(agent.binary)).equals(old), "mid-transfer the path still holds the running agent");
  const refused = await lane.ask({ kind: "agent.chunk", offset: 32_000, data: next.subarray(32_000).toString("base64") });
  assert.equal(refused.kind, "control_error");
  assert.match((refused as { message: string }).message, /sha256 .* not the announced .*; kept the running agent/);
  assert.ok((await readFile(agent.binary)).equals(old));
  assert.deepEqual(await readdir(agent.directory), ["localbox-agent"]);
  assert.equal(agent.state.exits, 0, "a refused update never exits");
});

test("an out-of-order or overrunning chunk drops the update, and a dropped connection discards its temp file", async () => {
  const agent = await installed();
  const lane = connect(agent.control);
  const next = randomBytes(10_000);
  await lane.ask({ kind: "agent.update", version: "v", sha256: sha256(next), size: next.byteLength });
  assert.equal((await lane.ask({ kind: "agent.chunk", offset: 5, data: next.toString("base64") })).kind, "control_error");
  assert.equal((await lane.ask({ kind: "agent.chunk", offset: 0, data: next.toString("base64") })).kind, "control_error", "the update was dropped, so later chunks have nothing to join");
  await lane.ask({ kind: "agent.update", version: "v", sha256: sha256(next), size: 100 });
  assert.equal((await lane.ask({ kind: "agent.chunk", offset: 0, data: next.toString("base64") })).kind, "control_error");
  await lane.ask({ kind: "agent.update", version: "v", sha256: sha256(next), size: next.byteLength });
  assert.equal((await readdir(agent.directory)).length, 2, "a transfer in progress writes beside the binary");
  lane.drop(); await lane.served;
  assert.deepEqual(await readdir(agent.directory), ["localbox-agent"]);
});

test("an update waits while a job runs, and is refused while frozen or when the agent runs from source", async () => {
  const agent = await installed();
  const lane = connect(agent.control);
  agent.state.jobs = 2;
  assert.deepEqual(await lane.ask({ kind: "agent.update", version: "v", sha256: "a".repeat(64), size: 10 }), { kind: "deferred", running_jobs: 2 });
  assert.deepEqual(await readdir(agent.directory), ["localbox-agent"], "a deferred update writes nothing");
  agent.state.jobs = 0;
  await lane.ask({ kind: "freeze", timeout_ms: 5_000 });
  assert.match(JSON.stringify(await lane.ask({ kind: "agent.update", version: "v", sha256: "a".repeat(64), size: 10 })), /frozen/);
  await lane.ask({ kind: "thaw" });
  const next = randomBytes(1_000);
  assert.equal((await push(lane, next, 4_096)).at(-1)?.kind, "updated", "once the jobs ended the same update lands");

  const source = connect(new GuestControl({ commands: syncOnlyCommands }));
  assert.match(JSON.stringify(await source.ask({ kind: "agent.update", version: "v", sha256: "a".repeat(64), size: 10 })), /runs from source/);
});

test("a temp file a crash left beside the binary is swept when the agent starts", async () => {
  const agent = await installed();
  await writeFile(join(agent.directory, ".localbox-agent.update-1234"), "half");
  await writeFile(join(agent.directory, "unrelated"), "keep");
  new GuestControl({ commands: syncOnlyCommands, update: { binary: agent.binary, runningJobs: () => 0, exit: () => undefined } });
  assert.deepEqual((await readdir(agent.directory)).sort(), ["localbox-agent", "unrelated"]);
});
