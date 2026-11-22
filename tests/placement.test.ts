import test from "node:test";
import assert from "node:assert/strict";
import { atLeast, place, type PlacementImage, type PlacementInput, type PlacementMachine } from "../packages/placement/src/index.js";
import { imageDiskNeedBytes } from "../packages/contract/src/index.js";

const GIB = 1024 ** 3;
const machine = (id: string, name: string, room: number, total: number, reported = true): PlacementMachine => ({ id, name, reported, roomBytes: room * GIB, totalBytes: total * GIB, lastReportAt: Date.UTC(2026, 9, 15) });
const studio = machine("m_studio", "Studio", 4, 8); const attic = machine("m_attic", "attic", 10, 16); const garage = machine("m_garage", "garage", 20, 32, false);
const fleet = [studio, attic, garage];
const linux: PlacementImage = { id: "linux", name: "linux", os: "linux", sizeBytes: 0 };
const where = (input: Partial<PlacementInput>) => place({ machines: fleet, neededBytes: 2 * GIB, image: linux, ...input });
const chosen = (input: Partial<PlacementInput>) => { const result = where(input); assert.ok("machineId" in result, JSON.stringify(result)); return result.machineId; };
const refused = (input: Partial<PlacementInput>) => { const result = where(input); assert.ok("error" in result, JSON.stringify(result)); return result; };

test("each rule picks the machine it names", () => {
  const cases: Array<[string, Partial<PlacementInput>, string]> = [
    ["no machine or placement: the caller's own machine", { callerMachineId: "m_studio" }, "m_studio"],
    ["no machine or placement, own machine full: still the caller's (its host makes room)", { callerMachineId: "m_studio", neededBytes: 6 * GIB }, "m_studio"],
    ["a named machine, by name in any case", { callerMachineId: "m_studio", machine: "ATTIC" }, "m_attic"],
    ["a named machine, by id", { machine: "m_attic" }, "m_attic"],
    ["a named machine that is full: still that machine", { machine: "studio", neededBytes: 6 * GIB }, "m_studio"],
    ["auto: the online machine with the most room (offline garage skipped)", { callerMachineId: "m_studio", placement: "auto" }, "m_attic"],
    ["auto with no caller machine", { placement: "auto" }, "m_attic"],
    ["remote: most room excluding the caller", { callerMachineId: "m_attic", placement: "remote" }, "m_studio"],
    ["auto: a machine too small for the sandbox is skipped", { placement: "auto", machines: [machine("m_small", "small", 6, 6), studio], neededBytes: 7 * GIB }, "m_studio"],
  ];
  for (const [label, input, expected] of cases) assert.equal(chosen(input), expected, label);
});

test("ties go to the caller's machine, then name order", () => {
  const twins = [machine("m_b", "bravo", 8, 16), machine("m_a", "alpha", 8, 16), machine("m_c", "charlie", 8, 16)];
  assert.equal(chosen({ machines: twins, callerMachineId: "m_c", placement: "auto" }), "m_c");
  assert.equal(chosen({ machines: twins, placement: "auto" }), "m_a");
  assert.equal(chosen({ machines: twins, callerMachineId: "m_a", placement: "remote" }), "m_b");
});

test("the reason is one sentence naming the machine, its room and what was skipped", () => {
  const auto = where({ callerMachineId: "m_studio", placement: "auto" });
  assert.ok("reason" in auto);
  assert.equal(auto.reason, "on attic, the machine with the most room (10 GiB free); skipped offline garage");
  const full = where({ placement: "auto", neededBytes: 12 * GIB });
  assert.ok("reason" in full); assert.match(full.reason, /none has 12 GiB free, so attic makes room/);
  const own = where({ callerMachineId: "m_studio" });
  assert.ok("reason" in own); assert.equal(own.reason, "on Studio, this machine (4 GiB free)");
});

test("refusals name the code and list every machine with its room", () => {
  const cases: Array<[string, Partial<PlacementInput>, string, RegExp]> = [
    ["no caller machine, no machine and no placement", {}, "invalid_input", /name a machine or use --placement auto: attic \(10 GiB free of 16 GiB\), garage \(offline, last report 2026-10-15T00:00:00.000Z\), Studio \(4 GiB free of 8 GiB\)/],
    ["a named machine that is offline", { machine: "garage" }, "machine_offline", /garage is offline \(last report 2026-10-15/],
    ["an unknown machine", { machine: "attic2" }, "machine_not_found", /no machine attic2 on this account; machines: attic/],
    ["remote with only the caller's machine", { machines: [studio], callerMachineId: "m_studio", placement: "remote" }, "machine_not_found", /no machine other than this one/],
    ["remote where every other machine is offline", { callerMachineId: "m_studio", machines: [studio, garage], placement: "remote" }, "machine_offline", /no other machine is online/],
    ["auto where no machine is big enough", { placement: "auto", neededBytes: 40 * GIB }, "machine_full", /no online machine has 40 GiB in all/],
    ["a named machine smaller than the sandbox", { machine: "studio", neededBytes: 9 * GIB }, "machine_full", /Studio has 8 GiB in all/],
    ["machine and placement together", { machine: "studio", placement: "auto" }, "invalid_input", /either a machine or a placement/],
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
    if (name === "sandboxes:create") return { sandbox_id: `sandbox_${args.machineId}`, name: "brisk-otter", machine_id: args.machineId, image_id: args.imageId, cpus: args.cpus, memory_bytes: args.memoryBytes, sleep_after_ms: 1_800_000, delete_after_ms: null };
    if (name === "sandboxes:remove") { removed.push(String(args.sandboxId)); return null; }
    return accountCall(principal, kind, name, args);
  };
  const result = await runOps({ accountId: "acct", machineId: "m_a" }, { operation: "sandbox.create", mutation_id: "cli-auto", input: { placement: "auto", cpus: 1, memory_bytes: 2 ** 31 } }, deps);
  const response = (result.body as any).response;
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result.produced.machine, "studio");
  assert.match(response.result.produced.placement_reason, /skipped offline attic/);
  assert.deepEqual(removed, ["sandbox_m_b"], "the offline machine's reservation is released");
});

const railsDev: PlacementImage = { id: "image_rails", name: "rails-dev", os: "linux", sizeBytes: 8 * GIB };
const macBase: PlacementImage = { id: "image_mac", name: "mac-base", os: "macos", minMacOS: "27.0", sizeBytes: 40 * GIB };
/** Studio holds rails-dev (most recently), attic doesn't, garage holds it but is offline. All run macOS 27.0.1 except garage (26.4). */
const imaged = (overrides: Record<string, Partial<PlacementMachine>> = {}) => [
  { ...studio, holds: true, heldAt: 200, freeDiskBytes: 100 * GIB, macOSVersion: "27.0.1", ...overrides.studio },
  { ...attic, holds: false, freeDiskBytes: 100 * GIB, macOSVersion: "27.0.1", ...overrides.attic },
  { ...garage, holds: true, heldAt: 100, freeDiskBytes: 100 * GIB, macOSVersion: "26.4", ...overrides.garage },
];
const planned = (input: Partial<PlacementInput>) => { const result = where({ image: railsDev, machines: imaged(), ...input }); assert.ok("machineId" in result, JSON.stringify(result)); return result; };

test("an image goes to a holder first, and a copy is planned only when no holder fits", () => {
  const cases: Array<[string, Partial<PlacementInput>, string, string | undefined]> = [
    ["auto: the holder with room beats a roomier non-holder", { placement: "auto" }, "m_studio", undefined],
    ["auto: no holder has room, so the roomiest non-holder with disk gets a copy", { placement: "auto", neededBytes: 6 * GIB }, "m_attic", "m_studio"],
    ["auto: no holder has room and the non-holder lacks disk, so the holder makes room", { placement: "auto", neededBytes: 6 * GIB, machines: imaged({ attic: { freeDiskBytes: 1 * GIB } }) }, "m_studio", undefined],
    ["a named machine without the image copies, from the holder that changed most recently", { machine: "attic" }, "m_attic", "m_studio"],
    ["a named machine holding the image needs no copy", { machine: "studio" }, "m_studio", undefined],
    ["no flag copies to the caller's own machine", { callerMachineId: "m_attic" }, "m_attic", "m_studio"],
    ["linux never copies, even to a machine reporting no disk", { image: linux, machine: "attic", machines: imaged({ attic: { freeDiskBytes: undefined } }) }, "m_attic", undefined],
  ];
  for (const [label, input, machineId, from] of cases) {
    const result = planned(input);
    assert.equal(result.machineId, machineId, label);
    assert.deepEqual(result.copy, from ? { fromMachineId: from } : undefined, label);
  }
});

test("the reason says which machine holds the image and what is copied from where", () => {
  assert.equal(planned({ placement: "auto" }).reason, "on Studio, the machine with the most room that holds rails-dev (4 GiB free); skipped offline garage");
  assert.equal(planned({ machine: "attic" }).reason, "on attic, as asked (10 GiB free); copying rails-dev (8 GiB) there from Studio first");
  assert.equal(planned({ placement: "auto", neededBytes: 6 * GIB }).reason, "on attic, the machine with the most room (10 GiB free), since no machine holding rails-dev has room; skipped offline garage; copying rails-dev (8 GiB) there from Studio first");
});

test("a macOS image never goes to a Mac older than it needs", () => {
  const machines = imaged({ studio: { holds: true }, attic: { holds: true, macOSVersion: "26.4" }, garage: { reported: true, holds: true, macOSVersion: "27.0" } });
  const auto = place({ machines, neededBytes: 2 * GIB, image: macBase, placement: "auto" });
  assert.ok("machineId" in auto && auto.machineId === "m_garage", JSON.stringify(auto));
  const named = place({ machines, neededBytes: 2 * GIB, image: macBase, machine: "attic" });
  assert.ok("error" in named && named.error === "image_incompatible", JSON.stringify(named));
  assert.match(named.message, /attic runs macOS 26.4; mac-base needs macOS 27.0 or later/);
  const own = place({ machines, neededBytes: 2 * GIB, image: macBase, callerMachineId: "m_attic" });
  assert.ok("error" in own && own.error === "image_incompatible");
  const none = place({ machines: machines.map((machine) => ({ ...machine, macOSVersion: "26.0" })), neededBytes: 2 * GIB, image: macBase, placement: "auto" });
  assert.ok("error" in none && none.error === "image_incompatible");
  assert.ok(atLeast("27.0.1", "27.0") && atLeast("27.0", "27") && !atLeast("26.4", "27.0") && atLeast("27.10", "27.9"));
});

test("a copy that can't happen is refused with the numbers", () => {
  const cases: Array<[string, Partial<PlacementInput>, string, RegExp]> = [
    ["named machine without disk for the copy", { machine: "attic", machines: imaged({ attic: { freeDiskBytes: 3 * GIB } }) }, "disk_full", /attic has 3 GiB of free disk, and copying rails-dev there needs 9 GiB/],
    ["named machine that has not reported its disk", { machine: "attic", machines: imaged({ attic: { freeDiskBytes: undefined } }) }, "disk_full", /attic has not reported its free disk/],
    ["every holder offline", { machine: "attic", machines: imaged({ studio: { holds: false } }) }, "machine_offline", /every machine holding rails-dev is offline.*garage \(offline/],
    ["no holder anywhere", { machine: "attic", machines: imaged({ studio: { holds: false }, garage: { holds: false } }) }, "image_not_found", /no machine holds rails-dev/],
    ["auto where only an offline machine holds it", { placement: "auto", machines: imaged({ studio: { holds: false } }) }, "machine_offline", /every machine holding rails-dev is offline, so it can't be copied to attic/],
    ["auto with no holder online and no disk anywhere", { placement: "auto", machines: imaged({ studio: { holds: false, freeDiskBytes: 0 }, attic: { freeDiskBytes: 0 } }) }, "disk_full", /no online machine has 9 GiB of free disk to copy rails-dev to/],
  ];
  for (const [label, input, code, message] of cases) {
    const result = where({ image: railsDev, ...input });
    assert.ok("error" in result, label);
    assert.equal(result.error, code, label); assert.match(result.message, message, label);
  }
});

test("a copy is planned only where the image plus the receiver's margin fits, by the receiver's own rule", () => {
  const small: PlacementImage = { ...railsDev, sizeBytes: 4 * GIB };
  assert.equal(imageDiskNeedBytes(4 * GIB), 5 * GIB, "the image plus 1 GiB, as the receiving daemon checks");
  const tight = imaged({ attic: { freeDiskBytes: 4.5 * GIB } });
  const named = where({ image: small, machine: "attic", machines: tight });
  assert.ok("error" in named && named.error === "disk_full", JSON.stringify(named));
  assert.match(named.message, /attic has 4.5 GiB of free disk, and copying rails-dev there needs 5 GiB/);
  const auto = where({ image: small, placement: "auto", neededBytes: 6 * GIB, machines: tight });
  assert.ok("machineId" in auto && auto.machineId === "m_studio" && auto.copy === undefined, `no copy to attic: ${JSON.stringify(auto)}`);
  const exact = where({ image: small, machine: "attic", machines: imaged({ attic: { freeDiskBytes: 5 * GIB } }) });
  assert.ok("copy" in exact && exact.copy?.fromMachineId === "m_studio", JSON.stringify(exact));
});
