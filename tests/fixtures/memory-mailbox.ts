import type { RequestEnvelope, ResponseEnvelope } from "../../packages/contract/src/index.js";
import type { OpsDeps, Principal, RelayResult } from "../../apps/relay/src/ops.js";

type Row = RelayResult & { requestId: string; accountId: string; machineId: string; mutationKey?: string; payload: RequestEnvelope };

/**
 * An in-memory stand-in for the Convex relay tables plus one connector per machine, so the agent API's waiting
 * logic and the client transport can be tested without Convex. `connectors[machineId]` answers a request;
 * a machine with no connector never claims, so its requests go offline.
 */
export function memoryMailbox(options: { machines: Array<{ machineId: string; name: string }>; connectors: Record<string, (request: RequestEnvelope) => Promise<ResponseEnvelope | undefined>>; claimWindowMs?: number; maxWaitMs?: number }) {
  const rows = new Map<string, Row>(); const watchers = new Map<string, Set<(result: RelayResult | null) => void>>();
  const publish = (row: Row) => { for (const watcher of watchers.get(row.requestId) ?? []) watcher({ accountId: row.accountId, status: row.status, response: row.response }); };
  const deps: OpsDeps = {
    claimWindowMs: options.claimWindowMs ?? 50, maxWaitMs: options.maxWaitMs,
    async accountCall(_principal: Principal, _kind, name) { if (name === "machines:list") return options.machines; throw new Error(`unexpected account call ${name}`); },
    async serviceMutation(name, args: any) {
      if (name === "relay:enqueue") {
        const mutationKey = args.mutationId ? `${args.sandboxId ?? ""}:${args.operation}:${args.mutationId}` : undefined;
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
  return { deps, rows };
}
