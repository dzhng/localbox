import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GuestGateway } from "../packages/guest-gateway/src/index.js";
import { operationCatalog, PROTOCOL_VERSION, type Json, type RequestEnvelope } from "../packages/contract/src/index.js";
import { sampleInput } from "../packages/runtime/src/index.js";

const request = (operation: RequestEnvelope["operation"], input: RequestEnvelope["input"], mutation_id: string | null = null, request_id = `${operation}-${Math.random()}`): RequestEnvelope => ({ protocol_version: PROTOCOL_VERSION, request_id, operation, vm_id: "vm_01", deadline_ms: 500, mutation_id, input });

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

test("guest gateway accepts optional production handler overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-computer-guest-"));
  const gateway = new GuestGateway({ root, extraHandlers: { "desktop.status": async () => ({ backend: "production" }) } });
  const response = await gateway.dispatch(request("desktop.status", {}));
  assert.equal(response.ok, true);
  if (response.ok) assert.deepEqual(response.result, { backend: "production" });
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

test("guest gateway implements every catalog operation", async () => {
  for (const entry of operationCatalog) {
    if (entry.executor !== "guest") continue;
    const root = await mkdtemp(join(tmpdir(), "agent-computer-guest-catalog-"));
    await mkdir(join(root, "tmp", "fixture"), { recursive: true });
    await mkdir(join(root, "tmp", "remove"), { recursive: true });
    await writeFile(join(root, "tmp", "file"), "fixture");
    const gateway = new GuestGateway({ root });
    let input = sampleInput(entry.id);
    if (entry.id === "fs.list" || entry.id === "fs.stat") input = { path: "/tmp/fixture" };
    if (entry.id === "fs.read") input = { path: "/tmp/file" };
    if (entry.id === "fs.write") input = { path: "/tmp/write", content: "fixture" };
    if (entry.id === "fs.mkdir") input = { path: "/tmp/new-dir" };
    if (entry.id === "fs.remove") input = { path: "/tmp/remove", recursive: true };
    if (entry.id.startsWith("browser.") && entry.id !== "browser.list_tabs" && entry.id !== "browser.open") {
      const opened = await gateway.dispatch(request("browser.open", { url: "https://example.test" }, `open-${entry.id}`, `open-${entry.id}`));
      assert.equal(opened.ok, true, entry.id);
      if (opened.ok) input = { ...(input as Record<string, Json>), tab_id: (opened.result as { tab_id: string }).tab_id };
    }
    const response = await gateway.dispatch(request(entry.id, input, entry.idempotency === "required" ? `catalog-${entry.id}` : null, `catalog-${entry.id}`));
    assert.equal(response.ok, true, entry.id);
  }
});
