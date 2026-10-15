/** Where `sandbox create` puts a sandbox (map Q4). Pure; the create route in the agent API is its only caller (D8). */

export interface PlacementMachine {
  id: string; name: string; online: boolean; roomBytes: number; totalBytes: number;
  /** When the machine last reported (ms), so an offline one can say how long it has been gone. */
  lastReportAt?: number;
}
export interface PlacementFlags { machine?: string; placement?: "auto" | "remote" }
export interface PlacementInput {
  flags: PlacementFlags;
  /** The machine the caller runs on, when it has one (a CLI whose local daemon answers); agents have none. */
  callerMachineId?: string;
  machines: PlacementMachine[];
  /** Memory the new sandbox reserves; machines with room for it come first. */
  neededBytes: number;
}
export type PlacementErrorCode = "machine_offline" | "machine_full" | "machine_not_found" | "invalid_input";
export interface MachineRoom { machine_id: string; name: string; online: boolean; room_bytes: number; total_bytes: number }
export type Placement =
  | { machineId: string; reason: string }
  | { error: PlacementErrorCode; message: string; machines: MachineRoom[] };

const GIB = 1024 ** 3;
const gib = (bytes: number) => `${Math.round(bytes / GIB * 10) / 10} GiB`;
const lastReport = (machine: PlacementMachine) => machine.lastReportAt === undefined ? "never reported" : `last report ${new Date(machine.lastReportAt).toISOString()}`;
const room = (machine: PlacementMachine) => machine.online ? `${machine.name} (${gib(machine.roomBytes)} free of ${gib(machine.totalBytes)})` : `${machine.name} (offline, ${lastReport(machine)})`;
const rooms = (machines: PlacementMachine[]): MachineRoom[] => machines.map((machine) => ({ machine_id: machine.id, name: machine.name, online: machine.online, room_bytes: machine.roomBytes, total_bytes: machine.totalBytes }));

/**
 * `machine` (an id or a case-insensitive name) wins; `placement: auto` takes the online machine with the most room,
 * `remote` the same without the caller's machine; no flag means the caller's own machine. Ties go to the caller's
 * machine, then by name. A named or default machine is used even when full: its host makes room when it starts the
 * sandbox. A machine whose whole memory is smaller than the sandbox is never chosen.
 */
export function place(input: PlacementInput): Placement {
  const { flags, callerMachineId, machines, neededBytes } = input;
  const all = [...machines].sort((a, b) => a.name.localeCompare(b.name));
  const fail = (error: PlacementErrorCode, message: string): Placement => ({ error, message, machines: rooms(all) });
  const listed = all.length ? all.map(room).join(", ") : "this account has no machines";
  const tooSmall = (machine: PlacementMachine) => machine.totalBytes > 0 && machine.totalBytes < neededBytes;

  if (flags.machine !== undefined && flags.placement !== undefined) return fail("invalid_input", "pass either a machine or a placement, not both");
  if (flags.machine !== undefined) {
    const wanted = flags.machine.toLowerCase();
    const machine = all.find((candidate) => candidate.id === flags.machine) ?? all.find((candidate) => candidate.name.toLowerCase() === wanted);
    if (!machine) return fail("machine_not_found", `no machine ${flags.machine} on this account; machines: ${listed}`);
    if (!machine.online) return fail("machine_offline", `${machine.name} is offline (${lastReport(machine)}); machines: ${listed}`);
    if (tooSmall(machine)) return fail("machine_full", `${machine.name} has ${gib(machine.totalBytes)} in all, less than the ${gib(neededBytes)} this sandbox needs`);
    return { machineId: machine.id, reason: `on ${machine.name}, as asked (${gib(machine.roomBytes)} free)` };
  }
  if (flags.placement !== undefined) {
    const remote = flags.placement === "remote";
    const pool = all.filter((machine) => !(remote && machine.id === callerMachineId));
    if (!pool.length) return fail("machine_not_found", remote ? "this account has no machine other than this one" : "this account has no machines");
    const online = pool.filter((machine) => machine.online && !tooSmall(machine));
    if (!online.length) {
      const offline = pool.filter((machine) => !machine.online);
      return offline.length === pool.length ? fail("machine_offline", `no ${remote ? "other " : ""}machine is online; machines: ${listed}`)
        : fail("machine_full", `no online ${remote ? "other " : ""}machine has ${gib(neededBytes)} in all; machines: ${listed}`);
    }
    const [best] = online.sort((a, b) => b.roomBytes - a.roomBytes || Number(b.id === callerMachineId) - Number(a.id === callerMachineId) || a.name.localeCompare(b.name));
    const skipped = pool.filter((machine) => !machine.online).map((machine) => machine.name);
    const fits = best.roomBytes >= neededBytes ? "" : `; none has ${gib(neededBytes)} free, so ${best.name} makes room`;
    return { machineId: best.id, reason: `on ${best.name}, the ${remote ? "remote " : ""}machine with the most room (${gib(best.roomBytes)} free)${fits}${skipped.length ? `; skipped offline ${skipped.join(", ")}` : ""}` };
  }
  const own = callerMachineId === undefined ? undefined : all.find((machine) => machine.id === callerMachineId);
  if (!own) return fail("invalid_input", `there is no machine to default to here; name a machine or use --placement auto: ${listed}`);
  if (tooSmall(own)) return fail("machine_full", `${own.name} has ${gib(own.totalBytes)} in all, less than the ${gib(neededBytes)} this sandbox needs; name another machine or use --placement auto`);
  return { machineId: own.id, reason: `on ${own.name}, this machine (${gib(own.roomBytes)} free)` };
}
