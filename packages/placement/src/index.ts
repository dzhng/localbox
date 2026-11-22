import { BUILT_IN_IMAGE, gibibytes as gib, imageDiskNeedBytes, type ImageOS } from "../../contract/src/index.js";

/** Where a sandbox goes, where an image is copied to, and which Mac can build a macOS image. Pure: the agent API feeds it. */

export interface PlacementMachine {
  id: string; name: string;
  /** It has reported capacity (and the relay has not just found it offline), so it may take the sandbox. */
  reported: boolean;
  roomBytes: number; totalBytes: number;
  /** When the machine last reported (ms), so an offline one can say how long it has been gone. */
  lastReportAt?: number;
  /** It holds the image, ready (its holder row); the built-in image counts as held everywhere. */
  holds?: boolean;
  /** When its holding last changed (ms); a copy comes from the holder that changed most recently. */
  heldAt?: number;
  /** Free disk for a copy, which must hold `imageDiskNeedBytes` of the image; absent until the machine reports it, and then no copy is planned to it. */
  freeDiskBytes?: number;
  /** The host's macOS version, e.g. "27.0.1"; absent until the machine reports it, and then no macOS image goes there. */
  macOSVersion?: string;
}
export interface PlacementImage {
  id: string; name: string; os: ImageOS;
  /** The oldest host macOS a macOS image runs on. */
  minMacOS?: string;
  /** What a copy moves; the built-in image is never copied. */
  sizeBytes: number;
}
export interface PlacementInput {
  /** The machine the request names (an id or a case-insensitive name). */
  machine?: string;
  placement?: "auto" | "remote";
  /** The machine the caller runs on, when it has one (a CLI whose local daemon answers); agents have none. */
  callerMachineId?: string;
  machines: PlacementMachine[];
  /** Memory the new sandbox reserves; machines with room for it come first. */
  neededBytes: number;
  /** The image the sandbox starts from. */
  image: PlacementImage;
}
export type PlacementErrorCode = "machine_offline" | "machine_full" | "machine_not_found" | "invalid_input" | "disk_full" | "image_incompatible" | "image_not_found";
export interface MachineRoom { machine_id: string; name: string; reported: boolean; room_bytes: number; total_bytes: number }
/** A copy the create waits on: the image comes from `fromMachineId` first. */
export interface PlannedCopy { fromMachineId: string }
export type Placement =
  | { machineId: string; reason: string; copy?: PlannedCopy }
  | { error: PlacementErrorCode; message: string; machines: MachineRoom[] };

/** The oldest host macOS that builds (and runs) a macOS image: provisioning a guest with no Setup Assistant needs 27. */
export const MACOS_IMAGE_MINIMUM = "27";

const lastReport = (machine: PlacementMachine) => machine.lastReportAt === undefined ? "never reported" : `last report ${new Date(machine.lastReportAt).toISOString()}`;
const room = (machine: PlacementMachine) => machine.reported ? `${machine.name} (${gib(machine.roomBytes)} free of ${gib(machine.totalBytes)})` : `${machine.name} (offline, ${lastReport(machine)})`;
const rooms = (machines: PlacementMachine[]): MachineRoom[] => machines.map((machine) => ({ machine_id: machine.id, name: machine.name, reported: machine.reported, room_bytes: machine.roomBytes, total_bytes: machine.totalBytes }));

/** The row `wanted` names: its id exactly, else its name in any case. The agent API resolves machines and sandboxes this way too. */
export function byNameOrId<T extends { name: string }>(rows: readonly T[], wanted: string, id: (row: T) => string): T | undefined {
  const lower = wanted.toLowerCase();
  return rows.find((row) => id(row) === wanted) ?? rows.find((row) => row.name.toLowerCase() === lower);
}

/** Whether dotted version `version` is at least `minimum` ("27.0.1" ≥ "27.0"). */
export function atLeast(version: string, minimum: string): boolean {
  const have = version.split(".").map(Number); const need = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(have.length, need.length); index++) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference) return difference > 0;
  }
  return true;
}

/** A macOS image needs a host at least its `minMacOS`; a Linux image runs anywhere. */
const runs = (machine: PlacementMachine, image: PlacementImage) => image.os !== "macos" || (machine.macOSVersion !== undefined && atLeast(machine.macOSVersion, image.minMacOS ?? "0"));
const incompatible = (machine: PlacementMachine, image: PlacementImage) => `${machine.name} ${machine.macOSVersion === undefined ? "has not reported its macOS version" : `runs macOS ${machine.macOSVersion}`}; ${image.name} needs ${image.minMacOS ? `macOS ${image.minMacOS} or later` : "a Mac that reports its macOS version"}`;

/** Whether `machine` can build a macOS image: it is online and its host runs `MACOS_IMAGE_MINIMUM` or later. */
export function buildTarget(machine: PlacementMachine): Placement {
  const build: PlacementImage = { id: "", name: "building a macOS image", os: "macos", minMacOS: MACOS_IMAGE_MINIMUM, sizeBytes: 0 };
  if (!machine.reported) return { error: "machine_offline", message: `${machine.name} is offline (${lastReport(machine)})`, machines: rooms([machine]) };
  if (!runs(machine, build)) return { error: "image_incompatible", message: incompatible(machine, build), machines: rooms([machine]) };
  return { machineId: machine.id, reason: `on ${machine.name}` };
}

/**
 * Machines that can't run the image are never chosen: a macOS image needs a host at least its `minMacOS`. Then the
 * named `machine` wins, else `placement` (auto: the online machine with the most room, remote: the same without the
 * caller's), else the caller's own machine. A named or own machine without the image gets a copy first, from the
 * holder whose holding changed most recently. Auto and remote take a holder with room; only when none has room do they
 * take the roomiest non-holder with disk for a copy. Ties go to the caller's machine, then by name. A named or default
 * machine is used even when full: its host makes room when it starts the sandbox. A machine whose whole memory is
 * smaller than the sandbox is never chosen.
 */
export function place(input: PlacementInput): Placement {
  const { machine: named, placement, callerMachineId, machines, neededBytes, image } = input;
  const all = [...machines].sort((a, b) => a.name.localeCompare(b.name));
  const fail = (error: PlacementErrorCode, message: string): Placement => ({ error, message, machines: rooms(all) });
  const listed = all.length ? all.map(room).join(", ") : "this account has no machines";
  const tooSmall = (machine: PlacementMachine) => machine.totalBytes > 0 && machine.totalBytes < neededBytes;
  const builtIn = image.id === BUILT_IN_IMAGE;
  const holds = (machine: PlacementMachine) => builtIn || machine.holds === true;
  const fits = (machine: PlacementMachine) => machine.roomBytes >= neededBytes;
  const copyNeeds = imageDiskNeedBytes(image.sizeBytes);
  const hasDisk = (machine: PlacementMachine) => machine.freeDiskBytes !== undefined && machine.freeDiskBytes >= copyNeeds;
  /** `target` as the answer, with the copy it needs when it doesn't hold the image. */
  const onto = (target: PlacementMachine, reason: string): Placement => {
    if (holds(target)) return { machineId: target.id, reason };
    if (!hasDisk(target)) return fail("disk_full", `${target.name} ${target.freeDiskBytes === undefined ? "has not reported its free disk" : `has ${gib(target.freeDiskBytes)} of free disk`}, and copying ${image.name} there needs ${gib(copyNeeds)}`);
    const holders = all.filter((machine) => machine.id !== target.id && holds(machine));
    const [source] = holders.filter((machine) => machine.reported).sort((a, b) => (b.heldAt ?? 0) - (a.heldAt ?? 0) || a.name.localeCompare(b.name));
    if (!source) return holders.length ? fail("machine_offline", `every machine holding ${image.name} is offline, so it can't be copied to ${target.name}; holders: ${holders.map(room).join(", ")}`)
      : fail("image_not_found", `no machine holds ${image.name}, so there is nothing to copy to ${target.name}`);
    return { machineId: target.id, reason: `${reason}; copying ${image.name} (${gib(image.sizeBytes)}) there from ${source.name} first`, copy: { fromMachineId: source.id } };
  };

  if (named !== undefined && placement !== undefined) return fail("invalid_input", "pass either a machine or a placement, not both");
  if (named !== undefined) {
    const machine = byNameOrId(all, named, (candidate) => candidate.id);
    if (!machine) return fail("machine_not_found", `no machine ${named} on this account; machines: ${listed}`);
    if (!machine.reported) return fail("machine_offline", `${machine.name} is offline (${lastReport(machine)}); machines: ${listed}`);
    if (!runs(machine, image)) return fail("image_incompatible", incompatible(machine, image));
    if (tooSmall(machine)) return fail("machine_full", `${machine.name} has ${gib(machine.totalBytes)} in all, less than the ${gib(neededBytes)} this sandbox needs`);
    return onto(machine, `on ${machine.name}, as asked (${gib(machine.roomBytes)} free)`);
  }
  if (placement !== undefined) {
    const remote = placement === "remote";
    const pool = all.filter((machine) => !(remote && machine.id === callerMachineId));
    if (!pool.length) return fail("machine_not_found", remote ? "this account has no machine other than this one" : "this account has no machines");
    const online = pool.filter((machine) => machine.reported);
    const compatible = online.filter((machine) => runs(machine, image));
    const candidates = compatible.filter((machine) => !tooSmall(machine));
    if (!candidates.length) {
      if (!online.length) return fail("machine_offline", `no ${remote ? "other " : ""}machine is online; machines: ${listed}`);
      if (!compatible.length) return fail("image_incompatible", `no online ${remote ? "other " : ""}machine can run ${image.name}: ${online.map((machine) => incompatible(machine, image)).join("; ")}`);
      return fail("machine_full", `no online ${remote ? "other " : ""}machine has ${gib(neededBytes)} in all; machines: ${listed}`);
    }
    const roomiest = (rows: PlacementMachine[]): PlacementMachine | undefined => [...rows].sort((a, b) => b.roomBytes - a.roomBytes || Number(b.id === callerMachineId) - Number(a.id === callerMachineId) || a.name.localeCompare(b.name))[0];
    const skipped = pool.filter((machine) => !machine.reported).map((machine) => machine.name);
    const skippedNote = skipped.length ? `; skipped offline ${skipped.join(", ")}` : "";
    const which = `the ${remote ? "remote " : ""}machine with the most room`;
    const roomNote = (machine: PlacementMachine) => fits(machine) ? "" : `; none has ${gib(neededBytes)} free, so ${machine.name} makes room`;
    const holderAnswer = (best: PlacementMachine): Placement => {
      const holding = builtIn ? "" : ` that holds ${image.name}`;
      return { machineId: best.id, reason: `on ${best.name}, ${which}${holding} (${gib(best.roomBytes)} free)${roomNote(best)}${skippedNote}` };
    };
    const holders = candidates.filter(holds);
    const fittingHolder = roomiest(holders.filter(fits));
    if (fittingHolder) return holderAnswer(fittingHolder);
    // No holder has room. A copy is worth it only to a machine that has room; otherwise a holder makes room.
    const copyTargets = candidates.filter((machine) => !holds(machine) && hasDisk(machine));
    const roomyTarget = roomiest(copyTargets.filter(fits));
    if (roomyTarget) return onto(roomyTarget, `on ${roomyTarget.name}, ${which} (${gib(roomyTarget.roomBytes)} free), since no machine holding ${image.name} has room${skippedNote}`);
    if (holders.length) return holderAnswer(roomiest(holders)!);
    const target = roomiest(copyTargets);
    if (!target) return fail("disk_full", `no online ${remote ? "other " : ""}machine has ${gib(copyNeeds)} of free disk to copy ${image.name} to; machines: ${listed}`);
    return onto(target, `on ${target.name}, ${which} (${gib(target.roomBytes)} free)${roomNote(target)}${skippedNote}`);
  }
  const own = callerMachineId === undefined ? undefined : all.find((machine) => machine.id === callerMachineId);
  if (!own) return fail("invalid_input", `there is no machine to default to here; name a machine or use --placement auto: ${listed}`);
  if (!runs(own, image)) return fail("image_incompatible", `${incompatible(own, image)}; name another machine or use --placement auto`);
  if (tooSmall(own)) return fail("machine_full", `${own.name} has ${gib(own.totalBytes)} in all, less than the ${gib(neededBytes)} this sandbox needs; name another machine or use --placement auto`);
  return onto(own, `on ${own.name}, this machine (${gib(own.roomBytes)} free)`);
}
