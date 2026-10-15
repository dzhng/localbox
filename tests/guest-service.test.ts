import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION, type RequestEnvelope } from "../packages/contract/src/index.js";
import { GuestGateway } from "../packages/guest-gateway/src/index.js";
import { GuestService } from "../packages/guest-gateway/src/service.js";
import { decodeGuestFrames, encodeGuestFrame, inventoryDigest, type GuestFrame } from "../packages/guest-gateway/src/protocol.js";

const request = (operation: RequestEnvelope["operation"], input: RequestEnvelope["input"], requestId = operation, mutationId: string | null = null): RequestEnvelope => ({
  protocol_version: PROTOCOL_VERSION, request_id: requestId, operation, sandbox_id: "sandbox_test", deadline_ms: 500, mutation_id: mutationId, input,
});

async function waitForFrame(output: PassThrough, kind: GuestFrame["kind"]): Promise<GuestFrame> {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for (;;) {
    const chunk = output.read() as Buffer | null;
    if (chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeGuestFrames(buffer);
      buffer = decoded.remainder;
      const frame = decoded.frames.find((candidate) => candidate.kind === kind);
      if (frame) return frame;
    }
    await new Promise<void>((resolve) => output.once("readable", resolve));
  }
}

test("guest service emits readiness and dispatches framed requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-guest-service-"));
  const marker = join(root, "run", "ready");
  const input = new PassThrough();
  const output = new PassThrough();
  const service = new GuestService({ input, output, gateway: new GuestGateway({ root }), channelEpoch: 7, inventoryNames: ["python3", "node"], readinessMarker: marker });
  await service.start();
  const ready = await waitForFrame(output, "ready");
  assert.deepEqual(ready, { kind: "ready", channel_epoch: 7, inventory_digest: inventoryDigest(["node", "python3"]), readiness_marker: marker });
  assert.equal((await readFile(marker, "utf8")).split("\n")[0], "7");

  input.write(encodeGuestFrame({ kind: "request", channel_epoch: 7, request: request("system.info", {}, "info") }));
  const response = await waitForFrame(output, "response");
  assert.equal(response.kind, "response");
  if (response.kind === "response") {
    assert.equal(response.response.ok, true);
    assert.equal(response.response.request_id, "info");
  }
  service.stop();
});

test("guest service rejects stale epochs and cancels in-flight shell work", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-guest-service-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const service = new GuestService({ input, output, gateway: new GuestGateway({ root }), channelEpoch: 2, readinessMarker: join(root, "ready") });
  await service.start();
  await waitForFrame(output, "ready");
  input.write(encodeGuestFrame({ kind: "request", channel_epoch: 1, request: request("system.info", {}, "stale") }));
  const stale = await waitForFrame(output, "response");
  assert.equal(stale.kind, "response");
  if (stale.kind === "response") {
    assert.equal(stale.response.ok, false);
    if (!stale.response.ok) assert.equal(stale.response.error.code, "forbidden");
  }

  input.write(encodeGuestFrame({ kind: "request", channel_epoch: 2, request: request("shell.exec", { command: "sleep 5" }, "sleep", "sleep-mut") }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write(encodeGuestFrame({ kind: "cancel", channel_epoch: 2, request_id: "sleep" }));
  const cancelled = await waitForFrame(output, "response");
  assert.equal(cancelled.kind, "response");
  if (cancelled.kind === "response") {
    assert.equal(cancelled.response.ok, false);
    if (!cancelled.response.ok) assert.equal(cancelled.response.error.code, "operation_cancelled");
  }
  service.stop();
});

test("adopts newer epoch from hello, rejects older", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-guest-service-"));
  const input = new PassThrough();
  const output = new PassThrough();
  let clock = 0;
  let host = "";
  const service = new GuestService({ input, output, gateway: new GuestGateway({ root }), channelEpoch: 2, readinessMarker: join(root, "ready"), setClock: (value) => { clock = value; }, adoptIdentity: (sandboxId, hostname) => { host = `${sandboxId}/${hostname}`; } });
  await service.start();
  await waitForFrame(output, "ready");
  input.write(encodeGuestFrame({ kind: "hello", channel_epoch: 1, wall_clock_ms: 10, sandbox_id: "sandbox_1", hostname: "old" }));
  input.write(encodeGuestFrame({ kind: "hello", channel_epoch: 3, wall_clock_ms: 20, sandbox_id: "sandbox_1", hostname: "new" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(clock, 20);
  assert.equal(host, "sandbox_1/new");
  assert.equal((await readFile(join(root, "ready"), "utf8")).split("\n")[0], "3");
  service.stop();
});

test("guest service reports malformed or oversized streams without dispatching", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-guest-service-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const errors: Error[] = [];
  const service = new GuestService({ input, output, gateway: new GuestGateway({ root }), channelEpoch: 1, maxBufferedBytes: 1024, readinessMarker: join(root, "ready"), onProtocolError: (error) => errors.push(error) });
  await service.start();
  await waitForFrame(output, "ready");
  input.write(Buffer.alloc(1100));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(errors.some((error) => error.message.includes("buffer")));
  service.stop();
});
