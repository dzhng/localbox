import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capResult, OUTPUT_CAP_BYTES, PROTOCOL_VERSION, RELEASE_ID, type Json } from "../packages/contract/src/index.js";
import { GuestGateway } from "../packages/guest-gateway/src/index.js";

const request = (operation: string, input: Json, id: string, mutation: string | null = null) => ({ protocol_version: PROTOCOL_VERSION, release_id: RELEASE_ID, request_id: id, operation, sandbox_id: "sandbox_1", deadline_ms: 30_000, mutation_id: mutation, input }) as any;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test("capResult trims oversized string fields on a UTF-8 boundary and reports both sizes", () => {
  const value = { stdout: "é".repeat(OUTPUT_CAP_BYTES), exit_code: 0 };
  const capped = capResult(value);
  assert.ok(bytes(capped.result) <= OUTPUT_CAP_BYTES);
  assert.equal(capped.truncated?.original_bytes, bytes(value));
  assert.equal(capped.truncated?.returned_bytes, bytes(capped.result));
  assert.doesNotMatch((capped.result as { stdout: string }).stdout, /�/);
  assert.equal((capped.result as { exit_code: number }).exit_code, 0);
  assert.deepEqual(capResult({ small: "ok" }), { result: { small: "ok" } });
});

test("a 2 MiB fs.read returns one page under the cap and pages back to the exact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "localbox-cap-"));
  const content = Buffer.from(Array.from({ length: 2 * 1024 * 1024 }, (_, index) => 97 + (index % 26)));
  await writeFile(join(root, "big.txt"), content);
  const gateway = new GuestGateway({ root });
  const first = await gateway.dispatch(request("fs.read", { path: "/big.txt" }, "read-0"));
  assert.equal(first.ok, true);
  assert.ok(bytes(first) <= OUTPUT_CAP_BYTES, "the whole response envelope fits one Convex document");
  const page = first.result as { content: string; next_offset: number; eof: boolean; truncated: { original_bytes: number } };
  assert.equal(page.truncated.original_bytes, content.byteLength);
  let assembled = page.content; let offset = page.next_offset; let eof = page.eof; let pages = 1;
  while (!eof) {
    const next = await gateway.dispatch(request("fs.read", { path: "/big.txt", offset }, `read-${pages}`));
    assert.equal(next.ok, true); const result = (next as { result: unknown }).result as { content: string; next_offset: number; eof: boolean };
    assembled += result.content; offset = result.next_offset; eof = result.eof; pages++;
  }
  assert.equal(pages, 3);
  assert.equal(createHash("sha256").update(assembled).digest("hex"), createHash("sha256").update(content).digest("hex"));
});

test("shell output larger than the cap still produces a response that fits", async () => {
  const gateway = new GuestGateway({ root: await mkdtemp(join(tmpdir(), "localbox-cap-shell-")) });
  const response = await gateway.dispatch(request("shell.exec", { command: "head -c 3000000 /dev/zero | tr '\\0' x" }, "shell-big", "shell-big"));
  assert.equal(response.ok, true);
  assert.ok(bytes(response) <= OUTPUT_CAP_BYTES);
  assert.equal((response.result as { truncated: boolean }).truncated, true);
});
