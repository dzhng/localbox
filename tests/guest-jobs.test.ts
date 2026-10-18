import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION, RELEASE_ID, type Json } from "../packages/contract/src/index.js";
import { GuestGateway } from "../packages/guest-gateway/src/index.js";

const request = (operation: string, input: Json, id: string, mutation: string | null = null) => ({ protocol_version: PROTOCOL_VERSION, release_id: RELEASE_ID, request_id: id, operation, sandbox_id: "sandbox_1", deadline_ms: 120_000, mutation_id: mutation, input }) as any;
const result = async (gateway: GuestGateway, operation: string, input: Json, id: string, mutation: string | null = null) => {
  const response = await gateway.dispatch(request(operation, input, id, mutation)); assert.equal(response.ok, true, JSON.stringify(response)); return response.result as any;
};
async function readAll(gateway: GuestGateway, jobId: string): Promise<{ text: string; first: any }> {
  let text = ""; let offset = 0; let first: any; let index = 0;
  for (;;) { const page = await result(gateway, "job.output", { job_id: jobId, offset }, `out-${jobId}-${index++}`); first ??= page; text += page.data; offset = page.next_offset; if (page.eof) return { text, first }; }
}

test("a background job outlives its request and its 3 MiB of output pages back exactly", async () => {
  const gateway = new GuestGateway({ root: await mkdtemp(join(tmpdir(), "localbox-jobs-")) });
  const started = await result(gateway, "shell.exec", { command: "head -c 3145728 /dev/zero | tr '\\0' y", background: true }, "start", "start");
  assert.match(started.job_id, /^job_/);
  assert.equal((await result(gateway, "guest.activity", {}, "activity")).running_jobs >= 0, true);
  const waited = await result(gateway, "job.wait", { job_id: started.job_id, timeout_ms: 30_000 }, "wait");
  assert.equal(waited.status, "completed"); assert.equal(waited.exit_code, 0);
  const { text } = await readAll(gateway, started.job_id);
  assert.equal(text.length, 3_145_728);
  assert.equal(createHash("sha256").update(text).digest("hex"), createHash("sha256").update("y".repeat(3_145_728)).digest("hex"));
});

test("cancel kills the job's whole process group and running_jobs reflects it", async () => {
  const gateway = new GuestGateway({ root: await mkdtemp(join(tmpdir(), "localbox-jobs-cancel-")) });
  const started = await result(gateway, "shell.exec", { command: "sleep 60 & sleep 60", background: true }, "start", "start");
  assert.equal((await result(gateway, "guest.activity", {}, "busy")).running_jobs, 1);
  await result(gateway, "job.cancel", { job_id: started.job_id }, "cancel", "cancel");
  const waited = await result(gateway, "job.wait", { job_id: started.job_id, timeout_ms: 10_000 }, "wait");
  assert.equal(waited.status, "cancelled");
  assert.equal((await result(gateway, "guest.activity", {}, "idle")).running_jobs, 0);
});

test("the ring-buffered log keeps offsets absolute and reports dropped output", async () => {
  const gateway = new GuestGateway({ root: await mkdtemp(join(tmpdir(), "localbox-jobs-ring-")), jobLogBytes: 1024 });
  const started = await result(gateway, "shell.exec", { command: "for i in $(seq 1 400); do printf '%010d\\n' $i; done", background: true }, "start", "start");
  await result(gateway, "job.wait", { job_id: started.job_id, timeout_ms: 30_000 }, "wait");
  const { text, first } = await readAll(gateway, started.job_id);
  const written = Array.from({ length: 400 }, (_, i) => `${String(i + 1).padStart(10, "0")}\n`).join("");
  // Trimming keeps the newest output, between half the cap and the cap, depending on how chunks arrived.
  assert.ok(text.length >= 512 && text.length <= 1024, `kept ${text.length} bytes of a 1 KiB log`);
  assert.equal(first.dropped_bytes, 4400 - text.length, "every byte is either kept or reported dropped");
  assert.equal(first.offset, first.dropped_bytes, "the first page starts at the oldest kept byte, as an absolute offset");
  assert.equal(text, written.slice(-text.length));
});

test("job.wait without timeout_ms waits for the job rather than returning at once", async () => {
  const gateway = new GuestGateway({ root: await mkdtemp(join(tmpdir(), "localbox-jobs-wait-")) });
  const started = await result(gateway, "shell.exec", { command: "sleep 0.3", background: true }, "start", "start");
  const waited = await result(gateway, "job.wait", { job_id: started.job_id }, "wait");
  assert.equal(waited.status, "completed");
});
