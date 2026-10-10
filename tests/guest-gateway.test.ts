import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GuestGateway } from "../packages/guest-gateway/src/index.js";
import { PROTOCOL_VERSION, type RequestEnvelope } from "../packages/contract/src/index.js";

const request = (operation: RequestEnvelope["operation"], input: RequestEnvelope["input"], mutation_id: string | null = null): RequestEnvelope => ({ protocol_version: PROTOCOL_VERSION, request_id: `${operation}-${Math.random()}`, operation, vm_id: "vm_01", deadline_ms: 500, mutation_id, input });

test("guest gateway confines filesystem operations to its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-guest-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-computer-outside-"));
  await writeFile(join(outside, "secret"), "host-secret");
  await symlink(outside, join(root, "escape"));
  const gateway = new GuestGateway({ root });
  const denied = await gateway.dispatch(request("fs.read", { path: "/escape/secret" }));
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "forbidden");
  const traversal = await gateway.dispatch(request("fs.read", { path: "/../secret" }));
  assert.equal(traversal.ok, false);
  if (!traversal.ok) assert.equal(traversal.error.code, "forbidden");
});

test("guest mutation journal replays a write after gateway restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-guest-"));
  const first = new GuestGateway({ root });
  const req = request("fs.write", { path: "/marker", content: "persisted" }, "write-1");
  const one = await first.dispatch(req);
  assert.equal(one.ok, true);
  const second = await new GuestGateway({ root }).dispatch({ ...req, request_id: "different" });
  assert.deepEqual(second, one);
});

test("shell timeout terminates and reports bounded execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-guest-"));
  const gateway = new GuestGateway({ root, maxOutputBytes: 64 });
  const timed = await gateway.dispatch(request("shell.exec", { command: "sleep 5" }, "sleep-1"));
  assert.equal(timed.ok, false);
  if (!timed.ok) assert.equal(timed.error.code, "operation_timeout");
});
