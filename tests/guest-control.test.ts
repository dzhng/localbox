import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { PROTOCOL_VERSION, type RequestEnvelope } from "../packages/contract/src/index.js";
import { GuestControl, GuestGateway, GuestService, type FreezeCommands } from "../packages/guest-gateway/src/index.js";
import { decodeGuestFrames, encodeGuestFrame, type ControlFrame, type GuestFrame } from "../packages/guest-gateway/src/protocol.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Commands that record what the guest did to its filesystem, in order. */
function recording(): FreezeCommands & { log: string[] } {
  const log: string[] = [];
  return { log, sync: async () => { log.push("sync"); }, freeze: async () => { log.push("freeze"); }, thaw: async () => { log.push("thaw"); } };
}

/** A control connection: frames written to the guest, answers read back in order. */
function connect(control: GuestControl) {
  const toGuest = new PassThrough(); const fromGuest = new PassThrough();
  const served = control.serve(toGuest, fromGuest);
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0); const answers: ControlFrame[] = []; const waiters: Array<() => void> = [];
  fromGuest.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); const decoded = decodeGuestFrames<ControlFrame>(buffer); buffer = decoded.remainder; answers.push(...decoded.frames); waiters.splice(0).forEach((wake) => wake()); });
  return {
    served,
    ask: async (frame: ControlFrame): Promise<ControlFrame> => {
      toGuest.write(encodeGuestFrame(frame));
      while (!answers.length) await new Promise<void>((wake) => waiters.push(wake));
      return answers.shift()!;
    },
    drop: () => toGuest.end(),
  };
}

test("a freeze answers frozen, and thaws itself after its timeout when no thaw comes", async () => {
  const commands = recording(); const control = new GuestControl({ commands });
  const lane = connect(control);
  assert.deepEqual(await lane.ask({ kind: "freeze", timeout_ms: 80 }), { kind: "frozen", timeout_ms: 80 });
  assert.deepEqual(commands.log, ["sync", "freeze"]); assert.equal(control.frozen, true);
  // The host goes away mid-clone: its connection drops and nothing else ever arrives.
  lane.drop(); await lane.served;
  await sleep(30);
  assert.equal(control.frozen, true, "dropping the connection alone does not thaw");
  await sleep(120);
  assert.deepEqual(commands.log, ["sync", "freeze", "thaw"]); assert.equal(control.frozen, false);
});

test("a thaw cancels the self-thaw, and a repeated freeze extends the hold without freezing twice", async () => {
  const commands = recording(); const control = new GuestControl({ commands });
  const lane = connect(control);
  await lane.ask({ kind: "freeze", timeout_ms: 60 });
  await sleep(40);
  assert.deepEqual(await lane.ask({ kind: "freeze", timeout_ms: 60 }), { kind: "frozen", timeout_ms: 60 });
  await sleep(40);
  assert.equal(control.frozen, true, "the second freeze restarted the timer");
  assert.deepEqual(await lane.ask({ kind: "thaw" }), { kind: "thawed" });
  await sleep(100);
  assert.deepEqual(commands.log, ["sync", "freeze", "thaw"], "one freeze, one thaw, and the cancelled timer never thaws again");
  assert.deepEqual(await lane.ask({ kind: "thaw" }), { kind: "thawed" }, "a thaw of a thawed guest is a no-op");
  assert.deepEqual(commands.log, ["sync", "freeze", "thaw"]);
});

test("a bad timeout, an unknown kind and a failing freeze answer control_error and leave the guest thawed", async () => {
  const failing: FreezeCommands = { sync: async () => undefined, freeze: async () => { throw new Error("fsfreeze: Operation not supported"); }, thaw: async () => undefined };
  const control = new GuestControl({ commands: failing }); const lane = connect(control);
  assert.equal((await lane.ask({ kind: "freeze", timeout_ms: 60_000 })).kind, "control_error");
  assert.equal((await lane.ask({ kind: "explode" } as unknown as ControlFrame)).kind, "control_error");
  assert.deepEqual(await lane.ask({ kind: "freeze" }), { kind: "control_error", message: "fsfreeze: Operation not supported" });
  assert.equal(control.frozen, false);
});

test("freeze answers while a request is in flight on the request lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "localbox-guest-control-"));
  const input = new PassThrough(); const output = new PassThrough();
  const service = new GuestService({ input, output, gateway: new GuestGateway({ root }), channelEpoch: 1, readinessMarker: join(root, "ready") });
  const frames: GuestFrame[] = []; let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  output.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); const decoded = decodeGuestFrames(buffer); buffer = decoded.remainder; frames.push(...decoded.frames); });
  await service.start();
  const request: RequestEnvelope = { protocol_version: PROTOCOL_VERSION, request_id: "slow", operation: "shell.exec", sandbox_id: "sandbox_test", deadline_ms: 10_000, mutation_id: "slow", input: { command: "sleep 1; echo done" } };
  input.write(encodeGuestFrame({ kind: "request", channel_epoch: 1, request }));
  await sleep(100);
  const commands = recording(); const lane = connect(new GuestControl({ commands }));
  const asked = Date.now();
  assert.equal((await lane.ask({ kind: "freeze", timeout_ms: 5_000 })).kind, "frozen");
  assert.ok(Date.now() - asked < 500, "the freeze did not wait for the request");
  assert.equal(frames.some((frame) => frame.kind === "response"), false, "the request is still running");
  assert.equal((await lane.ask({ kind: "thaw" })).kind, "thawed");
  for (let waited = 0; waited < 5_000 && !frames.some((frame) => frame.kind === "response"); waited += 20) await sleep(20);
  const response = frames.find((frame) => frame.kind === "response");
  assert.ok(response?.kind === "response" && response.response.ok, JSON.stringify(response));
  service.stop();
});
