import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../packages/state/src/index.js";
import { handleOps } from "../apps/relay/src/ops.js";
import { success, type Json, type RequestEnvelope, type ResponseEnvelope } from "../packages/contract/src/index.js";
import { memoryMailbox } from "./fixtures/memory-mailbox.js";

const ref = (name: string) => makeFunctionReference(name) as any;
const GIB = 1024 ** 3;

/** Account a1 with machines m1 and m2 and an agent token family f1; account a2 with machine m3. */
async function setup() {
  const t = createConvexTestHarness();
  await t.run(async (ctx) => {
    const now = Date.now();
    for (const [machineId, accountId, name] of [["m1", "a1", "studio"], ["m2", "a1", "attic"], ["m3", "a2", "garage"]]) await ctx.db.insert("machines", { machineId, accountId, credentialHash: `h-${machineId}`, name, createdAt: now, lastSeenAt: now });
    await ctx.db.insert("oauthTokens", { accountId: "a1", clientId: "c1", scopes: ["account"], constraints: null, familyId: "f1", accessTokenHash: "a", refreshTokenHash: "r", accessExpiresAt: now + 60_000, refreshExpiresAt: now + 60_000 });
  });
  const as = (machineId: string, accountId: string) => t.withIdentity({ subject: `machine:${machineId}`, account: accountId });
  return { t, m1: as("m1", "a1"), m2: as("m2", "a1"), m3: as("m3", "a2"), agent: t.withIdentity({ subject: "agent:f1", account: "a1" }) };
}
const create = (client: any, args: Record<string, unknown>) => client.mutation(ref("sandboxes:create"), { cpus: 2, memoryBytes: 2 * GIB, ...args });
const rows = async (t: ReturnType<typeof createConvexTestHarness>) => await t.run(async (ctx) => await ctx.db.query("sandboxes").collect());

test("generated names are adjective-animal and unique per account", async () => {
  const { m1 } = await setup();
  const names = [];
  for (let index = 0; index < 30; index++) names.push((await create(m1, { machineId: "m1" })).name);
  for (const name of names) assert.match(name, /^[a-z]+-[a-z]+$/);
  assert.equal(new Set(names).size, names.length);
});

test("a taken name fails name_conflict listing the account's names; another account may reuse it", async () => {
  const { m1, agent, m3 } = await setup();
  await create(m1, { machineId: "m1", name: "build-box" }); await create(agent, { machineId: "m2", name: "quiet-otter" });
  await assert.rejects(() => create(agent, { machineId: "m1", name: "build-box" }), /name_conflict: build-box is taken on this account; sandboxes: build-box, quiet-otter/);
  await assert.rejects(() => create(m1, { machineId: "m1", name: "Bad Name" }), /label must be/);
  assert.equal((await create(m3, { machineId: "m3", name: "build-box" })).name, "build-box");
  const sandbox = (await m1.query(ref("sandboxes:list"), {}))[0];
  await assert.rejects(() => m1.mutation(ref("sandboxes:rename"), { sandboxId: sandbox.sandbox_id, name: "quiet-otter" }), /name_conflict/);
  assert.equal((await m1.mutation(ref("sandboxes:rename"), { sandboxId: sandbox.sandbox_id, name: "renamed" })).previous_name, "build-box");
});

test("one account never sees, names, renames, removes or places on another account's sandboxes or machines", async () => {
  const { m1, m3 } = await setup();
  const ours = await create(m1, { machineId: "m1", name: "ours" });
  await assert.rejects(() => create(m3, { machineId: "m1" }), /machine_not_found/, "no placing on another account's machine");
  assert.deepEqual(await m3.query(ref("sandboxes:list"), {}), []);
  await assert.rejects(() => m3.mutation(ref("sandboxes:rename"), { sandboxId: ours.sandbox_id, name: "theirs" }), /sandbox_not_found/);
  await assert.rejects(() => m3.mutation(ref("sandboxes:remove"), { sandboxId: ours.sandbox_id }), /sandbox_not_found/);
  assert.deepEqual(await m3.query(ref("sandboxes:forMachine"), {}), []);
  assert.deepEqual((await m1.query(ref("sandboxes:list"), {})).map((row: any) => [row.name, row.machine_name]), [["ours", "studio"]]);
});

test("a machine mirrors and reports only its own sandboxes, and unchanged reports write nothing", async () => {
  const { t, m1, m2, m3 } = await setup();
  const one = await create(m1, { machineId: "m1", name: "one" }); const two = await create(m1, { machineId: "m2", name: "two" });
  assert.deepEqual((await m1.query(ref("sandboxes:forMachine"), {})).map((row: any) => row.name), ["one"]);
  assert.deepEqual(await m2.mutation(ref("sandboxes:reportState"), { states: [{ sandboxId: one.sandbox_id, state: "running" }, { sandboxId: two.sandbox_id, state: "running", cpus: 3 }] }), { written: 1 });
  assert.deepEqual(await m3.mutation(ref("sandboxes:reportState"), { states: [{ sandboxId: two.sandbox_id, state: "error" }] }), { written: 0 });
  const after = await rows(t);
  assert.equal(after.find((row: any) => row.name === "one").reportedState, undefined, "m2 cannot report m1's sandbox");
  assert.deepEqual([after.find((row: any) => row.name === "two").reportedState, after.find((row: any) => row.name === "two").cpus], ["running", 3]);
  const before = (await rows(t)).find((row: any) => row.name === "two").reportedAt;
  assert.deepEqual(await m2.mutation(ref("sandboxes:reportState"), { states: [{ sandboxId: two.sandbox_id, state: "running", cpus: 3 }] }), { written: 0 });
  assert.equal((await rows(t)).find((row: any) => row.name === "two").reportedAt, before, "the row is not rewritten");
});

/** Machine m_b answers host sandbox operations like HostDaemon; `refuse` makes it fail the create. */
function machine(refuse = false) {
  const seen: RequestEnvelope[] = [];
  const answer = async (request: RequestEnvelope): Promise<ResponseEnvelope> => {
    seen.push(request);
    if (refuse) return { protocol_version: "v1", request_id: request.request_id, operation: request.operation, sandbox_id: request.sandbox_id, release_id: "agent-computer-contract-v1", ok: false, error: { code: "sandbox_not_ready", message: "could not start", retryable: false } };
    const removed: Record<string, Json> = request.operation === "sandbox.delete" ? { removed: ["sandbox identity"] } : {};
    return success(request, { requested: request.input, produced: { sandbox_id: request.sandbox_id, ...removed }, actions: request.operation === "sandbox.create" ? [{ kind: "created" }, { kind: "cold_booted" }] : [] });
  };
  return { seen, answer };
}
const machines = [{ machineId: "m_a", name: "studio", lastSeenAt: Date.now() }, { machineId: "m_b", name: "attic", lastSeenAt: Date.now(), capacity: { cpus: 12, total_bytes: 24 * GIB, reserved_bytes: 0, room_bytes: 18 * GIB, running: 0, revision: 1 } }];
const fromA = { accountId: "acct", machineId: "m_a" };
const ops = async (deps: any, body: Record<string, unknown>, principal: any = fromA) => ((await handleOps(principal, { request_id: `r-${Math.random()}`, mutation_id: `m-${Math.random()}`, ...body }, deps)).body as { response: ResponseEnvelope }).response;

test("sandbox.create reserves the name, has the machine create it, and reports the size and why", async () => {
  const b = machine(); const { deps, sandboxes } = memoryMailbox({ machines, connectors: { m_b: b.answer } });
  const created = await ops(deps, { operation: "sandbox.create", input: { machine: "attic", name: "build-box" } });
  assert.equal(created.ok, true, JSON.stringify(created));
  const report = (created as any).result;
  assert.deepEqual(report.produced, { sandbox_id: "sandbox_1", name: "build-box", machine: "attic", placement_reason: "on attic, as asked (18 GiB free)", cpus: 6, memory_bytes: 6 * GIB, size_reason: "default for attic: half its 12 CPUs and a quarter of its 24 GiB, at least 2 CPUs and 2 GiB" });
  assert.deepEqual(report.actions.map((action: any) => action.kind), ["created", "cold_booted"]);
  assert.deepEqual([b.seen[0].operation, b.seen[0].sandbox_id, b.seen[0].input], ["sandbox.create", "sandbox_1", { name: "build-box", cpus: 6, memory_bytes: 6 * GIB }]);
  assert.equal(sandboxes.length, 1);
  const taken = await ops(deps, { operation: "sandbox.create", input: { machine: "attic", name: "build-box" } });
  assert.equal(!taken.ok && taken.error.code, "name_conflict"); assert.match(!taken.ok ? taken.error.message : "", /sandboxes: build-box/);
  const agent = await ops(deps, { operation: "sandbox.create", input: {} }, { accountId: "acct", familyId: "f" });
  assert.equal(!agent.ok && agent.error.code, "invalid_input"); assert.match(!agent.ok ? agent.error.message : "", /name a machine/);
});

test("sandbox.create places by the caller's machine, --machine or --placement, and says why", async () => {
  const capacity = (total: number, room: number) => ({ cpus: 8, total_bytes: total * GIB, reserved_bytes: (total * 0.75 - room) * GIB, room_bytes: room * GIB, running: 0, revision: 1 });
  const fleet = [
    { machineId: "m_a", name: "studio", lastSeenAt: Date.now(), capacity: capacity(8, 6) },
    { machineId: "m_b", name: "attic", lastSeenAt: Date.now(), capacity: capacity(16, 12) },
    // Reported once, quiet since (idle Macs make no calls) and in fact gone: auto tries it, then moves on.
    { machineId: "m_c", name: "garage", lastSeenAt: Date.now() - 31 * 60_000, capacity: capacity(64, 48) },
  ];
  const a = machine(); const b = machine();
  const { deps } = memoryMailbox({ machines: fleet, connectors: { m_a: a.answer, m_b: b.answer } });
  const where = async (body: Record<string, unknown>, principal: any = fromA) => { const response = await ops(deps, { operation: "sandbox.create", ...body }, principal); return response.ok ? (response.result as any).produced : response.error; };
  assert.deepEqual(pick(await where({ input: {}, caller_machine_id: "m_a" })), ["studio", "on studio, this machine (6 GiB free)"]);
  assert.deepEqual(pick(await where({ input: { placement: "auto" }, caller_machine_id: "m_a" })), ["attic", "on attic, the machine with the most room (12 GiB free); skipped offline garage"]);
  assert.deepEqual(pick(await where({ input: { placement: "remote" }, caller_machine_id: "m_b" }, { accountId: "acct", machineId: "m_b" })), ["studio", "on studio, the remote machine with the most room (6 GiB free); skipped offline garage"]);
  const offline = await where({ input: { machine: "garage" } });
  assert.equal(offline.code, "machine_offline"); assert.match(offline.message, /did not pick up the request/);
  // No caller machine (an agent, or a CLI whose local daemon did not answer): the error lists every machine with its room.
  const agent = await where({ input: {} }, { accountId: "acct", familyId: "f" });
  assert.equal(agent.code, "invalid_input"); assert.match(agent.message, /name a machine or use --placement auto: attic \(12 GiB free of 16 GiB\), garage \(48 GiB free of 64 GiB\), studio \(6 GiB free of 8 GiB\)/);
  assert.deepEqual(agent.details.machines.map((row: any) => [row.name, row.room_bytes / GIB]), [["attic", 12], ["garage", 48], ["studio", 6]]);
  const spoofed = await where({ input: {}, caller_machine_id: "m_b" });
  assert.equal(spoofed.code, "invalid_input", "a machine can only name itself as the caller");
});
const pick = (produced: any) => [produced.machine, produced.placement_reason];

test("a machine that refuses the create releases the reserved name", async () => {
  const b = machine(true); const { deps, sandboxes } = memoryMailbox({ machines, connectors: { m_b: b.answer } });
  const refused = await ops(deps, { operation: "sandbox.create", input: { machine: "attic", cpus: 2, memory_bytes: 2 * GIB } });
  assert.equal(!refused.ok && refused.error.code, "sandbox_not_ready");
  assert.equal(sandboxes.length, 0);
});

test("operations find the sandbox's machine; omitting the sandbox needs exactly one; delete reports what it removed", async () => {
  const b = machine(); const { deps, sandboxes } = memoryMailbox({ machines, sandboxes: [{ sandbox_id: "sandbox_1", name: "quiet-otter", machine_id: "m_b", machine_name: "attic" }], connectors: { m_b: b.answer } });
  assert.equal((await ops(deps, { operation: "sandbox.status", input: {} })).ok, true, "the only sandbox is used");
  assert.equal(b.seen.at(-1)!.sandbox_id, "sandbox_1");
  sandboxes.push({ sandbox_id: "sandbox_2", name: "brave-fox", machine_id: "m_b", machine_name: "attic", cpus: 2, memory_bytes: 2 * GIB, state: "running" });
  const ambiguous = await ops(deps, { operation: "sandbox.status", input: {} });
  assert.equal(!ambiguous.ok && ambiguous.error.code, "sandbox_ambiguous"); assert.deepEqual(!ambiguous.ok && ambiguous.error.details, { names: ["quiet-otter", "brave-fox"] });
  const renamed = await ops(deps, { operation: "sandbox.rename", sandbox: "brave-fox", input: { name: "calm-heron" } });
  assert.deepEqual((renamed as any).result.produced, { sandbox_id: "sandbox_2", name: "calm-heron", previous_name: "brave-fox", machine: "attic" });
  assert.equal(b.seen.at(-1)!.operation, "sandbox.rename", "the machine's mirror is told");
  const refused = await ops(deps, { operation: "sandbox.delete", sandbox: "calm-heron", input: { confirm: "quiet-otter" } });
  assert.equal(!refused.ok && refused.error.code, "invalid_input");
  const deleted = await ops(deps, { operation: "sandbox.delete", sandbox: "calm-heron", input: {} });
  assert.deepEqual((deleted as any).result.produced.removed, ["account catalog entry", "sandbox identity on attic"]);
  assert.deepEqual((deleted as any).result.actions.map((action: any) => action.kind), ["deleted"]);
  assert.deepEqual(sandboxes.map((row) => row.name), ["quiet-otter"]);
});
