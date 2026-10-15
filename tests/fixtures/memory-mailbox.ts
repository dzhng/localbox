import type { CapacityReport, RequestEnvelope, ResponseEnvelope } from "../../packages/contract/src/index.js";
import type { OpsDeps, Principal, RelayResult, SandboxRow } from "../../apps/relay/src/ops.js";

type Row = RelayResult & { requestId: string; accountId: string; machineId: string; mutationKey?: string; payload: RequestEnvelope };

/**
 * An in-memory stand-in for the Convex relay tables plus one connector per machine, so the agent API's waiting
 * logic and the client transport can be tested without Convex. `connectors[machineId]` answers a request;
 * a machine with no connector never claims, so its requests go offline.
 */
export function memoryMailbox(options: { machines: Array<{ machineId: string; name: string; lastSeenAt?: number; capacity?: CapacityReport }>; sandboxes?: Array<Partial<SandboxRow> & { sandbox_id: string; name: string; machine_id: string }>; connectors: Record<string, (request: RequestEnvelope) => Promise<ResponseEnvelope | undefined>>; claimWindowMs?: number; maxWaitMs?: number }) {
  const sandboxes = (options.sandboxes ?? []).map((row) => ({ machine_name: null, cpus: 2, memory_bytes: 2 * 1024 ** 3, state: "running", ...row })) as SandboxRow[];
  const rows = new Map<string, Row>(); const watchers = new Map<string, Set<(result: RelayResult | null) => void>>();
  const publish = (row: Row) => { for (const watcher of watchers.get(row.requestId) ?? []) watcher({ accountId: row.accountId, status: row.status, response: row.response }); };
  const deps: OpsDeps = {
    claimWindowMs: options.claimWindowMs ?? 50, maxWaitMs: options.maxWaitMs,
    async accountCall(_principal: Principal, _kind, name, args: any) {
      if (name === "machines:list") return options.machines;
      if (name === "sandboxes:list") return sandboxes;
      if (name === "sandboxes:create") {
        if (sandboxes.some((row) => row.name === args.name)) throw new Error(`Uncaught Error: name_conflict: ${args.name} is taken on this account; sandboxes: ${sandboxes.map((row) => row.name).join(", ")}`);
        const row: SandboxRow = { sandbox_id: `sandbox_${sandboxes.length + 1}`, name: args.name ?? `generated-${sandboxes.length + 1}`, machine_id: args.machineId, machine_name: options.machines.find((machine) => machine.machineId === args.machineId)?.name ?? null, cpus: args.cpus, memory_bytes: args.memoryBytes, state: "unknown" };
        sandboxes.push(row); return row;
      }
      if (name === "sandboxes:rename") { const row = sandboxes.find((candidate) => candidate.sandbox_id === args.sandboxId)!; const previous = row.name; row.name = args.name; return { sandbox_id: row.sandbox_id, name: row.name, previous_name: previous, machine_id: row.machine_id }; }
      if (name === "sandboxes:remove") { const index = sandboxes.findIndex((row) => row.sandbox_id === args.sandboxId); const [row] = sandboxes.splice(index, 1); return { sandbox_id: row.sandbox_id, name: row.name, machine_id: row.machine_id, removed: true }; }
      throw new Error(`unexpected account call ${name}`);
    },
    async serviceMutation(name, args: any) {
      if (name === "relay:enqueue") {
        const mutationKey = args.mutationId ? `${args.machineId}:${args.sandboxId ?? ""}:${args.operation}:${args.mutationId}` : undefined; // Convex scopes dedupe to the machine
        const existing = [...rows.values()].find((row) => row.requestId === args.requestId || (mutationKey && row.mutationKey === mutationKey));
        if (existing) return { requestId: existing.requestId };
        const row: Row = { requestId: args.requestId, accountId: args.accountId, machineId: args.machineId, mutationKey, payload: args.payload, status: "queued" };
        rows.set(row.requestId, row);
        const connector = options.connectors[args.machineId];
        if (connector) queueMicrotask(async () => { row.status = "claimed"; publish(row); const response = await connector(row.payload); if (response) { row.status = "completed"; row.response = response; publish(row); } });
        return { requestId: row.requestId };
      }
      if (name === "relay:abandonIfUnclaimed") { const row = rows.get(args.requestId)!; if (row.status !== "queued") return { abandoned: false, status: row.status }; row.status = "abandoned"; publish(row); return { abandoned: true, lastSeenAt: 1_700_000_000_000 }; }
      throw new Error(`unexpected service mutation ${name}`);
    },
    watchResult(requestId, onChange) {
      const set = watchers.get(requestId) ?? new Set(); set.add(onChange); watchers.set(requestId, set);
      const row = rows.get(requestId); queueMicrotask(() => onChange(row ? { accountId: row.accountId, status: row.status, response: row.response } : null));
      return () => set.delete(onChange);
    },
  };
  return { deps, rows, sandboxes };
}
