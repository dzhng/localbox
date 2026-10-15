import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "../apps/cli/src/render.js";
import { failure, requestFromInvocation, success, type Json, type ResponseEnvelope } from "../packages/contract/src/index.js";
import { FakeDispatcher } from "../packages/runtime/src/index.js";

const GIB = 1024 ** 3;
const envelope = (operation: string, result: Json): ResponseEnvelope => success(requestFromInvocation({ operation, input: {}, sandbox_id: "sandbox_1", request_id: `cli-${operation}` }), result);
const failed = (operation: string, code: "name_conflict" | "sandbox_ambiguous", message: string, details?: Json) => failure(requestFromInvocation({ operation, input: {}, request_id: `cli-${operation}` }), { code, message, retryable: false, ...(details === undefined ? {} : { details }) });

/** One sample result per CLI command, shaped like what the agent API and HostDaemon answer. */
const samples: Array<[string, ResponseEnvelope | Json]> = [
  ["sandbox create", envelope("sandbox.create", { requested: { name: "build-box" }, produced: { sandbox_id: "sandbox_1", name: "build-box", machine: "attic", cpus: 6, memory_bytes: 6 * GIB, size_reason: "default for attic: half its 12 CPUs and a quarter of its 24 GiB, at least 2 CPUs and 2 GiB" }, actions: [{ kind: "created", detail: "created build-box with 6 CPUs and 6 GiB" }, { kind: "cold_booted", detail: "cold-booted the runtime" }] })],
  ["sandbox create --name taken", failed("sandbox.create", "name_conflict", "build-box is taken on this account; sandboxes: build-box, quiet-otter")],
  ["sandbox list", envelope("sandbox.list", { sandboxes: [{ sandbox_id: "sandbox_1", name: "build-box", machine_id: "machine_1", machine_name: "attic", cpus: 6, memory_bytes: 6 * GIB, state: "running", reported_at: 1_760_000_000_000 }, { sandbox_id: "sandbox_2", name: "quiet-otter", machine_id: "machine_2", machine_name: null, cpus: 2, memory_bytes: 2 * GIB, state: "unknown", reported_at: null }] })],
  ["sandbox rename", envelope("sandbox.rename", { requested: { name: "calm-heron" }, produced: { sandbox_id: "sandbox_1", name: "calm-heron", previous_name: "build-box", machine: "attic" }, actions: [{ kind: "renamed", detail: "renamed build-box to calm-heron on attic" }] })],
  ["sandbox delete", envelope("sandbox.delete", { requested: {}, produced: { sandbox_id: "sandbox_1", name: "calm-heron", machine: "attic", removed: ["account catalog entry", "sandbox identity on attic"] }, actions: [{ kind: "deleted", detail: "deleted calm-heron: removed account catalog entry, sandbox identity on attic" }] })],
  ["sandbox status", envelope("sandbox.status", { sandbox_id: "sandbox_1", name: "build-box", cpus: 6, memory_bytes: 6 * GIB, state: "running", lifecycle: "ready", channel_epoch: 3 })],
  ["sandbox stop", envelope("sandbox.stop", { requested: {}, produced: { sandbox_id: "sandbox_1", state: "stopped" }, actions: [] })],
  ["sandbox sleep", envelope("sandbox.sleep", { requested: {}, produced: { sandbox_id: "sandbox_1", state: "sleeping" }, actions: [{ kind: "slept", detail: "build-box is asleep", made_room_for: "quiet-otter" }] })],
  ["shell exec", envelope("shell.exec", { stdout: "hello\nworld\n", stderr: "", exit_code: 0, truncated: false })],
  ["shell exec without --sandbox", failed("shell.exec", "sandbox_ambiguous", "2 sandboxes; pass --sandbox with one of: build-box, quiet-otter", { names: ["build-box", "quiet-otter"] })],
  ["fs read", envelope("fs.read", { path: "/big.txt", content: "zzzz", offset: 0, next_offset: 4, eof: false, truncated: { original_bytes: 2_097_152, returned_bytes: 921_600 } })],
  ["machine list", envelope("machine.list", [{ machineId: "machine_1", name: "attic", lastSeenAt: 1_760_000_000_000, capacity: { cpus: 12, total_bytes: 24 * GIB, reserved_bytes: 0, room_bytes: 18 * GIB, running: 0, revision: 1 } }])],
  ["account status", envelope("account.status", { accountId: "account_1", email: "you@example.com", name: "brave-walrus-482", createdAt: 1_760_000_000_000 })],
  ["login", { account_name: "brave-walrus-482", machine_name: "studio", machine_count: 2 }],
];

/** Every scalar in a JSON value. */
function leaves(value: Json): Json[] {
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (value && typeof value === "object") return Object.values(value).flatMap(leaves);
  return [value];
}
const facts = (value: ResponseEnvelope | Json): Json[] => {
  const response = value as ResponseEnvelope;
  if (response && typeof response === "object" && "release_id" in response) return response.ok ? leaves(response.result) : leaves({ code: response.error.code, message: response.error.message, details: response.error.details ?? null }).filter((leaf) => leaf !== null);
  return leaves(value as Json);
};
function assertSameFacts(name: string, value: ResponseEnvelope | Json): void {
  const text = render(value, { json: false }); const json = render(value, { json: true });
  const shown = text.stdout + text.stderr;
  for (const leaf of facts(value)) assert.ok(shown.includes(String(leaf)), `${name}: text lacks ${JSON.stringify(leaf)}\n${shown}`);
  assert.deepEqual(JSON.parse(json.stdout), value, `${name}: --json prints the whole envelope`);
  assert.equal(text.exitCode, json.exitCode, name);
}

test("text output carries every fact --json does, for every command", () => {
  for (const [name, value] of samples) assertSameFacts(name, value);
});

test("text output carries every fact for every catalog operation's result", async () => {
  for (const response of await new FakeDispatcher().invokeAll()) assertSameFacts(response.operation, response);
});

test("an action report leads with what was done, one line per action", () => {
  const out = render(samples[0][1], { json: false }).stdout.split("\n");
  assert.deepEqual(out.slice(0, 2), ["- created: created build-box with 6 CPUs and 6 GiB", "- cold_booted: cold-booted the runtime"]);
  assert.ok(out.includes("  memory_bytes: 6442450944 (6 GiB)"));
  assert.equal(render(samples.find(([name]) => name === "sandbox stop")![1], { json: false }).stdout.split("\n")[0], "- no changes");
});

test("errors go to stderr with the code first and exit 1; unauthorized exits 2", () => {
  const ambiguous = render(samples.find(([name]) => name === "shell exec without --sandbox")![1], { json: false });
  assert.equal(ambiguous.stdout, ""); assert.match(ambiguous.stderr, /^sandbox_ambiguous: 2 sandboxes/); assert.equal(ambiguous.exitCode, 1);
  const signedOut = failure(requestFromInvocation({ operation: "sandbox.list", input: {} }), { code: "unauthorized", message: "run localbox login", retryable: false });
  assert.equal(render(signedOut, { json: true }).exitCode, 2);
});
