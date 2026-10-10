import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentClient, LocalFixtureTransport, LocalIPCTransport, RemoteFixtureTransport } from "../packages/client/src/index.js";
import { operationCatalog } from "../packages/contract/src/index.js";

test("local and remote fixture transports have semantic parity for the catalog", async () => {
  const local = new AgentClient({ transport: new LocalFixtureTransport(), requestIds: () => "parity" });
  const remote = new AgentClient({ transport: new RemoteFixtureTransport(), requestIds: () => "parity" });
  for (const entry of operationCatalog) {
    let input: import("../packages/contract/src/index.js").Json = {};
    if (entry.id === "shell.exec") input = { command: "true" };
    else if (entry.id.startsWith("job.")) input = { job_id: "job_fixture" };
    const options = { mutationId: entry.idempotency === "required" ? `mutation-${entry.id}` : null };
    const [left, right] = await Promise.all([local.invoke(entry.id, input, options), remote.invoke(entry.id, input, options)]);
    assert.deepEqual(left && "ok" in left ? { ok: left.ok, result: left.ok ? left.result : left.error } : left, right && "ok" in right ? { ok: right.ok, result: right.ok ? right.result : right.error } : right, entry.id);
  }
});

test("local IPC transport speaks the HostDaemon length-prefixed protocol", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-computer-ipc-"));
  const socketPath = join(directory, "agent.sock");
  const server = createServer((socket) => {
    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (received.length < 4) return;
      const length = received.readUInt32BE(0);
      if (received.length < length + 4) return;
      const request = JSON.parse(received.subarray(4, length + 4).toString("utf8")) as { token: string; envelope: string };
      assert.equal(request.token, "socket-secret");
      const envelope = JSON.parse(Buffer.from(request.envelope, "base64").toString("utf8"));
      const response = Buffer.from(JSON.stringify({ envelope: Buffer.from(JSON.stringify({ ...envelope, ok: true, result: { ready: true } })).toString("base64") }));
      const frame = Buffer.allocUnsafe(response.length + 4); frame.writeUInt32BE(response.length, 0); response.copy(frame, 4); socket.end(frame);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try {
    const response = await new AgentClient({ transport: new LocalIPCTransport({ socketPath, token: "socket-secret", timeoutMs: 1_000 }) }).invoke("system.info");
    assert.equal(response.ok, true);
    assert.deepEqual(response.ok && response.result, { ready: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a dropped response is an explicit uncertain mutation", async () => {
  const transport = new LocalFixtureTransport();
  transport.dropNextResponse();
  const response = await new AgentClient({ transport }).invoke("vm.start", {}, { mutationId: "uncertain-1" });
  assert.equal(response.ok, false);
  if (!response.ok) { assert.equal(response.error.code, "operation_uncertain"); assert.equal(response.error.retryable, true); }
});

test("remote authentication expiry is recoverable and visible", async () => {
  const transport = new RemoteFixtureTransport();
  transport.setUnauthorized();
  const response = await new AgentClient({ transport }).invoke("vm.status");
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, "unauthorized");
  transport.setUnauthorized(false);
  const recovered = await new AgentClient({ transport }).invoke("vm.status");
  assert.equal(recovered.ok, true);
});
