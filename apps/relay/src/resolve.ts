import { ContractError, type CapacityReport, type Json } from "../../../packages/contract/src/index.js";
import { byNameOrId } from "../../../packages/placement/src/index.js";
import type { OpsDeps, Principal } from "./relay-wait.js";

/** A row of `machines:list`: the machine's last capacity report and when it last reached the relay. */
export interface MachineRow { machineId: string; name: string; lastSeenAt?: number; capacity?: CapacityReport; capacityAt?: number }

/**
 * A row of `sandboxes:list`. A sandbox made on a Mac without its image is `copying` (`copy_operation_id` names the copy)
 * until that Mac reports it created, or `failed` with `error` (why, and what to try next). `disk_bytes` is the disk its
 * create asked for (null: its image's), then the size its Mac reports.
 */
export interface SandboxRow { sandbox_id: string; name: string; machine_id: string; machine_name: string | null; image_id: string; os: "linux" | "macos"; min_macos: string | null; cpus: number; memory_bytes: number; disk_bytes: number | null; sleep_after_ms: number; delete_after_ms: number | null; state: string; copy_operation_id?: string | null; error?: { code: string; message: string; next_step: string } | null }

export const machineRows = async (principal: Principal, deps: OpsDeps) => await deps.accountCall(principal, "query", "machines:list", {}) as MachineRow[];

/** The named sandbox (name or id) on the caller's account; omitted, the account's only sandbox. */
export async function resolveSandbox(principal: Principal, wanted: string | undefined, deps: OpsDeps): Promise<SandboxRow> {
  const rows = await deps.accountCall(principal, "query", "sandboxes:list", {}) as SandboxRow[];
  const names = rows.map((row) => row.name);
  if (wanted) {
    const row = byNameOrId(rows, wanted, (candidate) => candidate.sandbox_id);
    if (!row) throw new ContractError("sandbox_not_found", `no sandbox ${wanted} on this account; ${names.length ? `sandboxes: ${names.join(", ")}` : "it has none"}`, { names });
    return row;
  }
  if (rows.length === 1) return rows[0];
  if (!rows.length) throw new ContractError("sandbox_not_found", "this account has no sandboxes; create one with sandbox create", { names });
  throw new ContractError("sandbox_ambiguous", `this account has ${rows.length} sandboxes; name one: ${names.join(", ")}`, { names });
}

/** The machine `wanted` (name or id) names on the caller's account. */
export async function findMachine(principal: Principal, wanted: string, deps: OpsDeps): Promise<MachineRow> {
  const rows = await machineRows(principal, deps);
  const row = byNameOrId(rows, wanted, (candidate) => candidate.machineId);
  if (row) return row;
  const names = rows.map((candidate) => candidate.name);
  throw new ContractError("machine_not_found", `no machine ${wanted} on this account; ${names.length ? `machines: ${names.join(", ")}` : "it has none"}`, { names });
}

/** A request naming both a sandbox and a machine must mean the same machine; otherwise the caller meant something else. */
export async function requireSameMachine(principal: Principal, target: SandboxRow, machine: string | undefined, deps: OpsDeps): Promise<void> {
  if (machine && (await findMachine(principal, machine, deps)).machineId !== target.machine_id) throw new ContractError("invalid_input", `${target.name} is on ${target.machine_name ?? target.machine_id}, not ${machine}; name one or the other`);
}

/** The machine a machine-level operation runs on: the named sandbox's, else the named machine, else the calling machine, else the account's only machine. */
export async function resolveMachine(principal: Principal, sandbox: string | undefined, machine: string | undefined, deps: OpsDeps): Promise<string> {
  if (sandbox) { const target = await resolveSandbox(principal, sandbox, deps); await requireSameMachine(principal, target, machine, deps); return target.machine_id; }
  if (machine) return (await findMachine(principal, machine, deps)).machineId;
  if (principal.machineId) return principal.machineId;
  const rows = await machineRows(principal, deps);
  const names = rows.map((row) => row.name);
  if (rows.length === 1) return rows[0].machineId;
  if (!rows.length) throw new ContractError("machine_not_found", "this account has no machines; sign a Mac in with localbox login", { names });
  throw new ContractError("invalid_input", `this account has ${rows.length} machines; name one with machine: ${names.join(", ")}`, { names });
}

/** A delete of something the account no longer has: nothing is left to remove. */
export function alreadyDeleted(kind: "sandbox" | "image", requested: Json, wanted: string): Json {
  return { requested, produced: { [kind]: wanted, removed: [] }, actions: [{ kind: "left_alone", detail: `${wanted} is already deleted: this account has no ${kind} by that name or id` }] };
}
