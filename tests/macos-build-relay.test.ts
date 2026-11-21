import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../packages/state/src/index.js";
import { runOps } from "../apps/relay/src/ops.js";
import { failure, success, type CapacityReport, type Json, type RequestEnvelope, type ResponseEnvelope } from "../packages/contract/src/index.js";
import { memoryMailbox } from "./fixtures/memory-mailbox.js";

const ref = (name: string) => makeFunctionReference(name) as any;
const GIB = 1024 ** 3;
type Machine = (request: RequestEnvelope) => Promise<ResponseEnvelope | undefined>;
const capacity = (macos_version: string): CapacityReport => ({ cpus: 10, total_bytes: 32 * GIB, reserved_bytes: 0, room_bytes: 24 * GIB, running: 0, revision: 1, free_disk_bytes: 200 * GIB, macos_version });

/**
 * Account a1 with studio (m1, macOS 27.0.1), attic (m2, macOS 27.1) and an old Mac (m3, macOS 26.4), the catalog
 * answered by the real Convex functions and relayed requests by `connectors`. `op` runs `image.create` as `caller`.
 */
async function setup(connectors: Record<string, Machine> = {}) {
  const machines = [{ machineId: "m1", name: "studio", capacity: capacity("27.0.1") }, { machineId: "m2", name: "attic", capacity: capacity("27.1") }, { machineId: "m3", name: "old-mini", capacity: capacity("26.4") }];
  const t = createConvexTestHarness();
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("accounts", { accountId: "a1", email: "a@example.com", name: "brave-walrus-100", createdAt: now });
    for (const { machineId, name, capacity } of machines) await ctx.db.insert("machines", { machineId, accountId: "a1", credentialHash: `h-${machineId}`, name, createdAt: now, lastSeenAt: now, capacity, capacityAt: now });
    await ctx.db.insert("oauthTokens", { accountId: "a1", clientId: "c1", scopes: ["account"], constraints: null, familyId: "f1", accessTokenHash: "a", refreshTokenHash: "r", accessExpiresAt: now + 60_000, refreshExpiresAt: now + 60_000 });
  });
  const studio = t.withIdentity({ subject: "machine:m1", account: "a1" });
  const agent = t.withIdentity({ subject: "agent:f1", account: "a1" });
  const { deps } = memoryMailbox({ machines, connectors });
  let calls = 0;
  const op = async (input: Record<string, unknown>, options: { machine?: string; caller?: "studio" | "agent"; mutationId?: string } = {}): Promise<any> => {
    const caller = options.caller ?? "studio";
    deps.accountCall = async (_principal, kind, name, args) => await ((caller === "studio" ? studio : agent) as any)[kind](ref(name), args);
    const principal = caller === "studio" ? { accountId: "a1", machineId: "m1" } : { accountId: "a1", familyId: "f1" };
    const result = await runOps(principal, { operation: "image.create", input, request_id: `req-${++calls}`, mutation_id: options.mutationId ?? `mut-${calls}`, ...(options.machine ? { machine: options.machine } : {}) }, deps);
    return (result.body as { response: ResponseEnvelope }).response;
  };
  const images = async () => (await studio.query(ref("images:list"), {}) as any[]).filter((row) => row.image_id !== "linux");
  return { op, images, studio };
}

/** A Mac whose build stands as `record` says, recording each request it was told. */
const building = (told: RequestEnvelope[], record: { state?: "running" | "succeeded"; phase?: string; result?: Json } = {}): Machine => async (request) => {
  told.push(request);
  const input = request.input as { image: string };
  const state = record.state ?? "running";
  return success(request, { key: request.mutation_id, kind: "macos.build", subject: input.image, state, progress: { phase: record.phase ?? "install", completed: 0, total: 0 }, ...(record.result ? { result: record.result } : {}), started_at: 1, updated_at: 2 });
};

test("image create --macos reserves an IPSW image on the caller's own Mac and answers with the build's phase", async () => {
  const told: RequestEnvelope[] = [];
  const { op, images } = await setup({ m1: building(told) });
  const created = await op({ macos: true, name: "mac-base" }, { mutationId: "cli-build-1" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(told.length, 1, "studio, the caller, builds it");
  assert.deepEqual(told[0].input, { macos: true, image: created.result.image });
  assert.equal(told[0].mutation_id, "cli-build-1", "the Mac journals the build under the create's mutation id");
  assert.deepEqual([created.result.state, created.result.os, created.result.progress], ["building", "macos", { phase: "install", done_bytes: 0, total_bytes: 0 }]);
  const [row] = await images();
  assert.deepEqual([row.name, row.os, row.source, row.min_macos], ["mac-base", "macos", { kind: "ipsw" }, null]);
  assert.deepEqual(row.holders.map((holder: any) => [holder.machine_name, holder.state, holder.operation_id]), [["studio", "building", "cli-build-1"]]);
});

test("--machine routes the build there; an agent with several Macs must name one", async () => {
  const told: RequestEnvelope[] = [];
  const { op, images } = await setup({ m2: building(told) });
  const created = await op({ macos: true }, { machine: "attic" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(told.length, 1);
  assert.deepEqual((await images())[0].holders.map((holder: any) => holder.machine_name), ["attic"]);

  const ambiguous = await op({ macos: true }, { caller: "agent" });
  assert.equal(ambiguous.error.code, "invalid_input");
  assert.match(ambiguous.error.message, /3 machines; name one with machine: studio, attic, old-mini/);
  assert.equal((await images()).length, 1, "nothing reserved for the ambiguous call");
});

test("a Mac older than macOS 27 is refused before anything is reserved; a Mac's own refusal releases the reservation", async () => {
  const told: RequestEnvelope[] = [];
  const { op, images } = await setup({ m3: building(told), m1: async (request) => failure(request, { code: "disk_full", message: "building a macOS image on this Mac needs 46.6 GiB free for its disk, and 41 GiB is free", retryable: false }) });
  const old = await op({ macos: true }, { machine: "old-mini" });
  assert.equal(old.error.code, "image_incompatible");
  assert.equal(old.error.message, "old-mini runs macOS 26.4; building a macOS image needs macOS 27 or later on that Mac");
  assert.equal(told.length, 0, "old-mini was never told");
  const full = await op({ macos: true });
  assert.equal(full.error.code, "disk_full");
  assert.equal((await images()).length, 0, "both refusals left nothing reserved");

  const offline = await op({ macos: true }, { machine: "attic" });
  assert.equal(offline.error.code, "machine_offline");
  assert.equal((await images()).length, 0);
});

test("a build the Mac may still be running keeps its reservation and says how to follow it", async () => {
  const { op, images } = await setup({ m1: async (request) => failure(request, { code: "internal", message: "the daemon lost track", retryable: false }) });
  const kept = await op({ macos: true, name: "maybe-mac" });
  assert.match(kept.error.message, /the build may still be running on studio: image maybe-mac stays reserved \(follow it with localbox image wait maybe-mac\)$/);
  assert.equal((await images()).length, 1);
});

test("a finished build reports the release, what the image holds and where it runs, line by line", async () => {
  const { op } = await setup({ m1: building([], { state: "succeeded", phase: "finish", result: { size_bytes: 31.5 * GIB, ipsw_version: "27.2.1", ipsw_build: "26B131", min_macos: "27.0", chrome_version: "142.0.7444.60", os: "macos" } }) });
  const built = await op({ macos: true, name: "mac-base" });
  assert.equal(built.result.state, "ready");
  assert.deepEqual(built.result.report, [
    "image mac-base built from the macOS 27.2.1 (26B131) IPSW (macos, 31.5 GiB)",
    "SIP is disabled, Google Chrome 142.0.7444.60 is installed, Remote Login is off, and there is no Xcode",
    "on machine studio; runs on Macs with macOS 27.0 or later",
    "start a sandbox from it: localbox sandbox create --image mac-base",
  ]);
});
