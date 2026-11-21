import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../packages/state/src/index.js";
import { runOps, type Principal } from "../apps/relay/src/ops.js";
import { render } from "../apps/cli/src/render.js";
import { failure, success, type Json, type RequestEnvelope, type ResponseEnvelope } from "../packages/contract/src/index.js";
import { memoryMailbox } from "./fixtures/memory-mailbox.js";

const ref = (name: string) => makeFunctionReference(name) as any;
const GIB = 1024 ** 3; const MIB = 1024 ** 2;
const capacity = { cpus: 8, total_bytes: 16 * GIB, reserved_bytes: 0, room_bytes: 12 * GIB, running: 0, revision: 1, free_disk_bytes: 100 * GIB, macos_version: "27.0.1" };

/**
 * One fake Mac behind the relay, as its connector and daemon answer: it journals copy sides and chained creates, and
 * answers `image.wait` with whatever `journal` holds for the image (the record its daemon would follow).
 */
function mac() {
  const seen: RequestEnvelope[] = [];
  const state: { journal?: Record<string, Json>; online: boolean } = { online: true };
  const answer = async (request: RequestEnvelope): Promise<ResponseEnvelope | undefined> => {
    seen.push(request);
    const input = request.input as Record<string, Json>;
    if (request.operation === "image.copy") return success(request, { key: request.mutation_id, kind: "image.copy", subject: input.image, state: "running", progress: { phase: "waiting_for_peer" }, started_at: 1, updated_at: 1 });
    if (request.operation === "image.wait") return state.journal ? success(request, state.journal) : failure(request, { code: "image_not_found", message: "no operation", retryable: false });
    if (request.operation === "sandbox.create") return success(request, { requested: input, produced: { sandbox_id: request.sandbox_id, name: input.name, state: input.after_copy ? "copying" : "running" }, actions: input.after_copy ? [] : [{ kind: "created", detail: `created ${input.name}` }] });
    if (request.operation === "sandbox.delete") return failure(request, { code: "sandbox_not_found", message: `no sandbox ${request.sandbox_id} on this machine`, retryable: false });
    return success(request, { ran: request.operation });
  };
  return { seen, state, answer, ops: (operation: string) => seen.filter((request) => request.operation === operation) };
}

/**
 * Account a1: studio (m1) holds rails-dev (3 GiB) ready, attic (m2) does not. Requests go through the real relay and
 * Convex functions; each Mac's relayed requests reach its fake (`macs`), and a Mac taken out of `connectors` is offline.
 */
async function setup() {
  const t = createConvexTestHarness();
  const machines = [{ machineId: "m1", name: "studio", capacity }, { machineId: "m2", name: "attic", capacity }];
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("accounts", { accountId: "a1", email: "a@example.com", name: "a1", createdAt: now });
    for (const machine of machines) await ctx.db.insert("machines", { ...machine, accountId: "a1", credentialHash: `h-${machine.machineId}`, createdAt: now, lastSeenAt: now, capacityAt: now });
  });
  const studio = t.withIdentity({ subject: "machine:m1", account: "a1" }); const attic = t.withIdentity({ subject: "machine:m2", account: "a1" });
  const image = await studio.mutation(ref("images:reserve"), { machineId: "m1", name: "rails-dev", os: "linux", source: { kind: "sandbox", sandboxName: "bold-otter" }, createMutationId: "capture-1" }) as any;
  await studio.mutation(ref("images:setHolder"), { imageId: image.image_id, state: "ready", sizeBytes: 3 * GIB });
  const macs = { m1: mac(), m2: mac() };
  const connectors: Record<string, (request: RequestEnvelope) => Promise<ResponseEnvelope | undefined>> = { m1: macs.m1.answer, m2: macs.m2.answer };
  const { deps } = memoryMailbox({ machines, connectors });
  const clients: Record<string, any> = { m1: studio, m2: attic };
  deps.accountCall = async (principal, kind, name, args) => await clients[principal.machineId ?? "m1"][kind](ref(name), args);
  let calls = 0;
  const op = async (operation: string, body: Record<string, unknown> = {}, principal: Principal = { accountId: "a1", machineId: "m1" }): Promise<any> => {
    const result = await runOps(principal, { operation, request_id: `req-${++calls}`, input: {}, ...body }, deps);
    return (result.body as { response: ResponseEnvelope }).response;
  };
  const sandbox = async (name: string) => (await studio.query(ref("sandboxes:list"), {}) as any[]).find((row) => row.name === name);
  const copies = async () => await t.run(async (ctx) => await ctx.db.query("copies").collect());
  return { op, image, macs, connectors, studio, attic, sandbox, copies };
}

const createOnAttic = (op: Awaited<ReturnType<typeof setup>>["op"], name: string, mutation: string) => op("sandbox.create", { machine: "attic", mutation_id: mutation, input: { name, image: "rails-dev" } });

test("on a Mac without the image the create starts a copy, reserves the sandbox copying and answers at once", async () => {
  const { op, image, macs, sandbox, copies, attic } = await setup();
  const created = await createOnAttic(op, "rails-box", "cli-create-1");
  assert.equal(created.ok, true, JSON.stringify(created));
  const report = created.result;
  assert.deepEqual([report.produced.state, report.produced.machine, report.produced.copying_from], ["copying", "attic", "studio"]);
  assert.match(report.produced.placement_reason, /copying rails-dev \(3 GiB\) there from studio first$/);
  assert.deepEqual(report.actions, [{ kind: "waiting", detail: "sandbox rails-box on attic is waiting for image rails-dev to copy (3 GiB); localbox image wait rails-dev" }]);
  assert.match(render(created, { json: false }).stdout, /^- waiting: sandbox rails-box on attic is waiting for image rails-dev to copy \(3 GiB\); localbox image wait rails-dev\n/);

  const row = await sandbox("rails-box");
  assert.deepEqual([row.state, row.copy_operation_id, row.machine_name, row.image_id], ["copying", "cli-create-1-copy", "attic", image.image_id]);
  const [copy] = await copies();
  assert.deepEqual([copy.fromMachineId, copy.toMachineId, copy.createMutationId], ["m1", "m2", "cli-create-1-copy"]);
  for (const side of [macs.m1, macs.m2]) assert.deepEqual(side.ops("image.copy").map((request) => [request.mutation_id, request.input]), [["cli-create-1-copy", { image: image.image_id, to: "m2" }]], "both Macs journal their side under the copy's mutation id");
  const [chained] = macs.m2.ops("sandbox.create");
  assert.deepEqual([chained.mutation_id, chained.sandbox_id, (chained.input as any).after_copy, (chained.input as any).image], ["cli-create-1", row.sandbox_id, "cli-create-1-copy", image.image_id], "attic chains its create to the copy, keyed by the create's mutation id");
  assert.equal(macs.m1.ops("sandbox.create").length, 0, "nothing is created on the holder");
  assert.deepEqual((await attic.query(ref("images:get"), { image: "rails-dev" }) as any).holders.map((holder: any) => [holder.machine_name, holder.state]).sort(), [["attic", "copying"], ["studio", "ready"]]);

  const replay = await createOnAttic(op, "rails-box", "cli-create-1");
  assert.deepEqual([replay.ok, replay.result.produced.sandbox_id, replay.result.produced.state], [true, row.sandbox_id, "copying"], "a replay answers for the same sandbox");
  assert.equal((await copies()).length, 1, "and starts no second copy");
  assert.equal(macs.m2.ops("sandbox.create").length, 1, "the relay's dedupe answered the chained create again");
});

test("while copying, every operation on the sandbox is sandbox_not_ready with the copy's progress, answered without reaching it; sandbox status shows it", async () => {
  const { op, macs, connectors, sandbox } = await setup();
  await createOnAttic(op, "rails-box", "cli-create-2");
  macs.m2.state.journal = { key: "cli-create-2", kind: "sandbox.create_after_copy", subject: "image_x", state: "running", progress: { phase: "receiving", completed: 12 * MIB, total: 64 * MIB }, started_at: 2, updated_at: 3 };

  const exec = await op("shell.exec", { sandbox: "rails-box", mutation_id: `exec-${Math.random()}`, input: { command: "echo", args: ["hi"] } });
  assert.equal(exec.ok, false);
  assert.deepEqual([exec.error.code, exec.error.retryable], ["sandbox_not_ready", true]);
  assert.equal(exec.error.message, "rails-box on attic is waiting for image rails-dev to copy (12 MiB of 64 MiB); follow it with: localbox image wait rails-dev");
  assert.deepEqual(exec.error.details.progress, { phase: "receiving", done_bytes: 12 * MIB, total_bytes: 64 * MIB });
  for (const operation of ["sandbox.delete", "sandbox.rename", "sandbox.start"]) {
    const refused = await op(operation, { sandbox: "rails-box", input: operation === "sandbox.rename" ? { name: "other" } : {} });
    assert.equal(refused.error?.code, "sandbox_not_ready", `${operation}: ${JSON.stringify(refused)}`);
  }
  assert.deepEqual(macs.m2.seen.map((request) => request.operation).filter((name) => !["image.copy", "sandbox.create", "image.wait"].includes(name)), [], "nothing but progress reads reached attic");
  assert.ok(macs.m2.ops("image.wait").every((request) => (request.input as any).timeout_ms === 1), "progress is read without waiting");
  assert.ok(await sandbox("rails-box"), "a refused delete leaves the sandbox");

  const status = await op("sandbox.status", { sandbox: "rails-box" });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.deepEqual([status.result.state, status.result.image, status.result.progress.done_bytes, status.result.next_step], ["copying", "rails-dev", 12 * MIB, "localbox image wait rails-dev"]);
  const listed = await op("sandbox.list");
  assert.equal(listed.result.sandboxes.find((row: any) => row.name === "rails-box").state, "copying");

  delete connectors.m2;
  const offline = await op("shell.exec", { sandbox: "rails-box", mutation_id: `exec-${Math.random()}`, input: { command: "true" } });
  assert.equal(offline.error.message, "rails-box on attic is waiting for image rails-dev to copy (the copy has not reported progress yet); follow it with: localbox image wait rails-dev", "an unreachable target still gets an answer from the catalog");
});

test("image wait follows the chained create: copying with progress, then the copy and the created sandbox; after that the sandbox works", async () => {
  const { op, image, macs, attic, sandbox } = await setup();
  await createOnAttic(op, "rails-box", "cli-create-3");
  macs.m2.state.journal = { key: "cli-create-3", kind: "sandbox.create_after_copy", subject: image.image_id, state: "running", progress: { phase: "receiving", completed: GIB, total: 3 * GIB }, started_at: 2, updated_at: 3 };
  const copying = await op("image.wait", { input: { image: "rails-dev", timeout_ms: 1000 } });
  assert.deepEqual([copying.result.state, copying.result.progress], ["copying", { phase: "receiving", done_bytes: GIB, total_bytes: 3 * GIB }]);
  assert.equal(macs.m2.ops("image.wait").at(-1)?.input && (macs.m2.ops("image.wait").at(-1)!.input as any).timeout_ms, 1000, "attic, where the copy goes, answers the wait");

  macs.m2.state.journal = { key: "cli-create-3", kind: "sandbox.create_after_copy", subject: image.image_id, state: "succeeded", progress: { phase: "creating" }, result: { sandbox_id: "s", name: "rails-box", cpus: 4, memory_bytes: 4 * GIB, state: "running", copy_operation_id: "cli-create-3-copy", copy: { role: "receiver", bytes: 3 * GIB, duration_ms: 42_000, path: "local_network", size_bytes: 3 * GIB } }, started_at: 2, updated_at: 4 };
  // attic's connector reports the copy before the create, as it finishes first: the holding turns ready.
  await attic.mutation(ref("images:endCopy"), { operationId: "cli-create-3-copy", state: "succeeded", sizeBytes: 3 * GIB, result: { bytes: 3 * GIB, durationMs: 42_000, path: "local_network" } });
  const done = await op("image.wait", { input: { image: "rails-dev" } });
  assert.equal(done.result.state, "ready", JSON.stringify(done.result));
  assert.deepEqual(done.result.report, [
    "copied image rails-dev from studio to attic (3 GiB, 42 s, local network)",
    "created sandbox rails-box on attic: 4 CPUs and 4 GiB, running",
    "run a command in it: localbox shell exec --sandbox rails-box -- CMD",
  ], "the wait still goes to attic while the sandbox reads copying, though no holder is copying any more");
  assert.equal(render(done, { json: false }).stdout, `${done.result.report.join("\n")}\n`);

  const reported = await attic.mutation(ref("sandboxes:endCreate"), { operationId: "cli-create-3", state: "succeeded" });
  assert.deepEqual([reported.reported, reported.state], [true, "created"]);
  await attic.mutation(ref("sandboxes:reportState"), { states: [{ sandboxId: (await sandbox("rails-box")).sandbox_id, state: "running" }] });
  assert.deepEqual([(await sandbox("rails-box")).state, (await sandbox("rails-box")).error], ["running", null]);
  const exec = await op("shell.exec", { sandbox: "rails-box", mutation_id: `exec-${Math.random()}`, input: { command: "true" } });
  assert.deepEqual([exec.ok, exec.result.ran], [true, "shell.exec"], "relayed to attic once created");
  const settled = await op("image.wait", { input: { image: "rails-dev" } });
  assert.equal(settled.result.state, "ready", "with nothing copying, the catalog answers");
});

test("a failed copy leaves the sandbox failed with the reason and next step until it is deleted, which needs nothing from its Mac", async () => {
  const { op, attic, sandbox, macs } = await setup();
  await createOnAttic(op, "rails-box", "cli-create-4");
  const error = { code: "copy_unreachable", message: "image image_x did not arrive, so rails-box was not created: no direct path between the two Macs", nextStep: "put both Macs on the same network once, then copy; then delete it with localbox sandbox delete rails-box --confirm rails-box, then create it again" };
  await assert.rejects(() => attic.mutation(ref("sandboxes:endCreate"), { operationId: "cli-create-4", state: "failed" }), (thrown: any) => thrown.data?.code === "invalid_input");
  await attic.mutation(ref("sandboxes:endCreate"), { operationId: "cli-create-4", state: "failed", error });
  const row = await sandbox("rails-box");
  assert.deepEqual([row.state, row.error], ["failed", { code: error.code, message: error.message, next_step: error.nextStep }]);

  const status = await op("sandbox.status", { sandbox: "rails-box" });
  assert.deepEqual([status.ok, status.result.state, status.result.error.next_step], [true, "failed", error.nextStep]);
  const exec = await op("shell.exec", { sandbox: "rails-box", mutation_id: `exec-${Math.random()}`, input: { command: "true" } });
  assert.deepEqual([exec.error.code, exec.error.retryable, exec.error.details.next_step], ["sandbox_not_ready", false, error.nextStep]);
  assert.equal(exec.error.message, `rails-box on attic was not created: ${error.message}`);
  const replay = await createOnAttic(op, "rails-box", "cli-create-4");
  assert.deepEqual([replay.ok, replay.error.code], [false, "sandbox_not_ready"], "a replay of the create answers its failure");

  const deleted = await op("sandbox.delete", { sandbox: "rails-box", input: { confirm: "rails-box" } });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(await sandbox("rails-box"), undefined);
  assert.equal(macs.m2.ops("sandbox.delete").length, 1, "its Mac was told and had nothing to remove");
});

test("no flag puts the sandbox on the caller's own Mac, copying there (P7); a second create there follows the same copy", async () => {
  const { op, sandbox, copies } = await setup();
  const fromAttic = { accountId: "a1", machineId: "m2" };
  const own = await op("sandbox.create", { caller_machine_id: "m2", mutation_id: "cli-own-1", input: { name: "own-box", image: "rails-dev" } }, fromAttic);
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.deepEqual([own.result.produced.machine, own.result.produced.state], ["attic", "copying"]);
  assert.match(own.result.produced.placement_reason, /copying rails-dev/);
  const second = await op("sandbox.create", { caller_machine_id: "m2", mutation_id: "cli-own-2", input: { name: "own-two", image: "rails-dev" } }, fromAttic);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal((await sandbox("own-two")).copy_operation_id, "cli-own-1-copy", "it waits for the copy already running");
  assert.equal((await copies()).length, 1);
});

test("a target that never takes its side releases the sandbox and cancels the copy; callers can't set after_copy", async () => {
  const { op, connectors, sandbox, copies } = await setup();
  delete connectors.m2;
  const refused = await createOnAttic(op, "rails-box", "cli-create-6");
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "machine_offline");
  assert.match(refused.error.message, /^attic did not start its side of the copy, so nothing was copied: .*; rails-box was not created$/);
  assert.equal(await sandbox("rails-box"), undefined, "the reservation is released");
  assert.equal((await copies())[0].state, "failed");

  const smuggled = await op("sandbox.create", { machine: "studio", input: { image: "rails-dev", after_copy: "anything" } });
  assert.deepEqual([smuggled.error.code, smuggled.error.message], ["invalid_input", "after_copy is set by the agent API; leave it out"]);
});

test("a create refused after its copy was started (a taken name) cancels that copy, so the target isn't left copying", async () => {
  const { op, studio, copies, attic } = await setup();
  await studio.mutation(ref("sandboxes:create"), { machineId: "m1", name: "taken", imageId: "linux", cpus: 2, memoryBytes: 2 * GIB });
  const refused = await createOnAttic(op, "taken", "cli-create-7");
  assert.equal(refused.error?.code, "name_conflict", JSON.stringify(refused));
  assert.equal((await copies())[0].state, "failed");
  assert.deepEqual((await attic.query(ref("images:get"), { image: "rails-dev" }) as any).holders.map((holder: any) => holder.machine_name), ["studio"]);
});
