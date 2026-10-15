import test from "node:test";
import assert from "node:assert/strict";
import { place, type PlacementInput, type PlacementMachine } from "../packages/placement/src/index.js";

const GIB = 1024 ** 3;
const machine = (id: string, name: string, room: number, total: number, reported = true): PlacementMachine => ({ id, name, reported, roomBytes: room * GIB, totalBytes: total * GIB, lastReportAt: Date.UTC(2026, 9, 15) });
const studio = machine("m_studio", "Studio", 4, 8); const attic = machine("m_attic", "attic", 10, 16); const garage = machine("m_garage", "garage", 20, 32, false);
const fleet = [studio, attic, garage];
const where = (input: Partial<PlacementInput>) => place({ flags: {}, machines: fleet, neededBytes: 2 * GIB, ...input });
const chosen = (input: Partial<PlacementInput>) => { const result = where(input); assert.ok("machineId" in result, JSON.stringify(result)); return result.machineId; };
const refused = (input: Partial<PlacementInput>) => { const result = where(input); assert.ok("error" in result, JSON.stringify(result)); return result; };

test("each rule picks the machine it names", () => {
  const cases: Array<[string, Partial<PlacementInput>, string]> = [
    ["no flags: the caller's own machine", { callerMachineId: "m_studio" }, "m_studio"],
    ["no flags, own machine full: still the caller's (its host makes room)", { callerMachineId: "m_studio", neededBytes: 6 * GIB }, "m_studio"],
    ["--machine by name, any case", { callerMachineId: "m_studio", flags: { machine: "ATTIC" } }, "m_attic"],
    ["--machine by id", { flags: { machine: "m_attic" } }, "m_attic"],
    ["--machine full: still that machine", { flags: { machine: "studio" }, neededBytes: 6 * GIB }, "m_studio"],
    ["auto: the online machine with the most room (offline garage skipped)", { callerMachineId: "m_studio", flags: { placement: "auto" } }, "m_attic"],
    ["auto with no caller machine", { flags: { placement: "auto" } }, "m_attic"],
    ["remote: most room excluding the caller", { callerMachineId: "m_attic", flags: { placement: "remote" } }, "m_studio"],
    ["auto: a machine too small for the sandbox is skipped", { flags: { placement: "auto" }, machines: [machine("m_small", "small", 6, 6), studio], neededBytes: 7 * GIB }, "m_studio"],
  ];
  for (const [label, input, expected] of cases) assert.equal(chosen(input), expected, label);
});

test("ties go to the caller's machine, then name order", () => {
  const twins = [machine("m_b", "bravo", 8, 16), machine("m_a", "alpha", 8, 16), machine("m_c", "charlie", 8, 16)];
  assert.equal(chosen({ machines: twins, callerMachineId: "m_c", flags: { placement: "auto" } }), "m_c");
  assert.equal(chosen({ machines: twins, flags: { placement: "auto" } }), "m_a");
  assert.equal(chosen({ machines: twins, callerMachineId: "m_a", flags: { placement: "remote" } }), "m_b");
});

test("the reason is one sentence naming the machine, its room and what was skipped", () => {
  const auto = where({ callerMachineId: "m_studio", flags: { placement: "auto" } });
  assert.ok("reason" in auto);
  assert.equal(auto.reason, "on attic, the machine with the most room (10 GiB free); skipped offline garage");
  const full = where({ flags: { placement: "auto" }, neededBytes: 12 * GIB });
  assert.ok("reason" in full); assert.match(full.reason, /none has 12 GiB free, so attic makes room/);
  const own = where({ callerMachineId: "m_studio" });
  assert.ok("reason" in own); assert.equal(own.reason, "on Studio, this machine (4 GiB free)");
});

test("refusals name the code and list every machine with its room", () => {
  const cases: Array<[string, Partial<PlacementInput>, string, RegExp]> = [
    ["no caller machine and no flags", {}, "invalid_input", /name a machine or use --placement auto: attic \(10 GiB free of 16 GiB\), garage \(offline, last report 2026-10-15T00:00:00.000Z\), Studio \(4 GiB free of 8 GiB\)/],
    ["a named machine that is offline", { flags: { machine: "garage" } }, "machine_offline", /garage is offline \(last report 2026-10-15/],
    ["an unknown machine", { flags: { machine: "attic2" } }, "machine_not_found", /no machine attic2 on this account; machines: attic/],
    ["remote with only the caller's machine", { machines: [studio], callerMachineId: "m_studio", flags: { placement: "remote" } }, "machine_not_found", /no machine other than this one/],
    ["remote where every other machine is offline", { callerMachineId: "m_studio", machines: [studio, garage], flags: { placement: "remote" } }, "machine_offline", /no other machine is online/],
    ["auto where no machine is big enough", { flags: { placement: "auto" }, neededBytes: 40 * GIB }, "machine_full", /no online machine has 40 GiB in all/],
    ["a named machine smaller than the sandbox", { flags: { machine: "studio" }, neededBytes: 9 * GIB }, "machine_full", /Studio has 8 GiB in all/],
    ["machine and placement together", { flags: { machine: "studio", placement: "auto" } }, "invalid_input", /either a machine or a placement/],
  ];
  for (const [label, input, code, message] of cases) {
    const result = refused(input);
    assert.equal(result.error, code, label); assert.match(result.message, message, label);
  }
  const listed = refused({}).machines;
  assert.deepEqual(listed.map((row) => [row.name, row.reported, row.room_bytes / GIB, row.total_bytes / GIB]), [["attic", true, 10, 16], ["garage", false, 20, 32], ["Studio", true, 4, 8]]);
});

test("auto placement moves on when the roomiest machine does not answer, and says so", async () => {
  const { runOps } = await import("../apps/relay/src/ops.js");
  const { memoryMailbox } = await import("./fixtures/memory-mailbox.js");
  const capacity = (gib: number) => ({ total_bytes: gib * 2 ** 30, reserved_bytes: 0, room_bytes: gib * 0.75 * 2 ** 30, running: 0, revision: 1, cpus: 8 });
  const machines = [{ machineId: "m_a", name: "studio", capacity: capacity(8) }, { machineId: "m_b", name: "attic", capacity: capacity(16) }];
  const { deps } = memoryMailbox({ machines, connectors: { m_a: async (request) => ({ protocol_version: "v1", request_id: request.request_id, operation: request.operation, sandbox_id: request.sandbox_id, release_id: "localbox-contract-v1", ok: true, result: { requested: {}, produced: {}, actions: [] } }) } });
  const removed: string[] = [];
  const accountCall = deps.accountCall;
  deps.accountCall = async (principal, kind, name, args) => {
    if (name === "sandboxes:create") return { sandbox_id: `sandbox_${args.machineId}`, name: "brisk-otter", machine_id: args.machineId };
    if (name === "sandboxes:remove") { removed.push(String(args.sandboxId)); return null; }
    return accountCall(principal, kind, name, args);
  };
  const result = await runOps({ accountId: "acct", machineId: "m_a" }, { operation: "sandbox.create", input: { placement: "auto", cpus: 1, memory_bytes: 2 ** 31 } }, deps);
  const response = (result.body as any).response;
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.produced.machine, "studio");
  assert.match(response.result.produced.placement_reason, /skipped offline attic/);
  assert.deepEqual(removed, ["sandbox_m_b"], "the offline machine's reservation is released");
});
