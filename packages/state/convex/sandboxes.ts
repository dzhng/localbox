import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireAccount, requireIdentity } from "./lib/identity.js";
import { boundedRows, byField, fail, id } from "./lib/relay.js";
import { sandboxName, validateLabel } from "../../names/src/index.js";

/** Idle time before a sandbox sleeps (slice 12 applies it). */
const DEFAULT_SLEEP_AFTER_MS = 30 * 60_000;
const NAME_ATTEMPTS = 20;

const accountRows = async (ctx: any, accountId: string) => await boundedRows(ctx.db.query("sandboxes").withIndex("by_account", (q: any) => q.eq("accountId", accountId)), "sandbox list");
const named = async (ctx: any, accountId: string, name: string) => await ctx.db.query("sandboxes").withIndex("by_account_name", (q: any) => q.eq("accountId", accountId).eq("name", name)).first();
/** Errors other modules map to contract codes start with `<code>:`. */
const nameTaken = async (ctx: any, accountId: string, name: string): Promise<never> => {
  const names = (await accountRows(ctx, accountId)).map((row: any) => row.name).sort();
  return fail(`name_conflict: ${name} is taken on this account; sandboxes: ${names.join(", ")}`);
};
async function ownSandbox(ctx: any, accountId: string, sandboxId: string) {
  const row = await byField(ctx, "sandboxes", "by_sandbox", "sandboxId", sandboxId);
  if (!row || row.accountId !== accountId) fail(`sandbox_not_found: no sandbox ${sandboxId} on this account`);
  return row;
}
const view = (row: any, machineName?: string) => ({
  sandbox_id: row.sandboxId, name: row.name, machine_id: row.machineId, machine_name: machineName ?? null,
  cpus: row.cpus, memory_bytes: row.memoryBytes, state: row.reportedState ?? "unknown", reported_at: row.reportedAt ?? null,
});

/** Reserves a sandbox's identity on one of the caller's machines; the agent API then asks that machine to create it. */
export const create = mutationGeneric({ args: { machineId: v.string(), name: v.optional(v.string()), cpus: v.number(), memoryBytes: v.number() }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const machine = await byField(ctx, "machines", "by_machine", "machineId", args.machineId);
  if (!machine || machine.accountId !== accountId || machine.revokedAt !== undefined) fail(`machine_not_found: no machine ${args.machineId} on this account`);
  let name = args.name;
  if (name !== undefined) { validateLabel(name); if (await named(ctx, accountId, name)) await nameTaken(ctx, accountId, name); }
  else {
    for (let attempt = 0; attempt < NAME_ATTEMPTS && name === undefined; attempt++) { const candidate = sandboxName(); if (!(await named(ctx, accountId, candidate))) name = candidate; }
    if (name === undefined) fail(`name_conflict: no free generated name after ${NAME_ATTEMPTS} tries; pass a name`);
  }
  const row = { sandboxId: id("sandbox"), accountId, machineId: machine.machineId, name: name!, cpus: args.cpus, memoryBytes: args.memoryBytes, sleepAfterMs: DEFAULT_SLEEP_AFTER_MS, createdAt: Date.now() };
  await ctx.db.insert("sandboxes", row);
  return view(row, machine.name);
} });

export const list = queryGeneric({ args: {}, handler: async (ctx) => {
  const { accountId } = await requireAccount(ctx);
  const machines = new Map((await boundedRows(ctx.db.query("machines").withIndex("by_account", (q: any) => q.eq("accountId", accountId)), "machine list")).map((row: any) => [row.machineId, row.name]));
  return (await accountRows(ctx, accountId)).sort((a: any, b: any) => a.createdAt - b.createdAt).map((row: any) => view(row, machines.get(row.machineId)));
} });

export const rename = mutationGeneric({ args: { sandboxId: v.string(), name: v.string() }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const row = await ownSandbox(ctx, accountId, args.sandboxId);
  const name = validateLabel(args.name);
  if (name !== row.name && await named(ctx, accountId, name)) await nameTaken(ctx, accountId, name);
  if (name !== row.name) await ctx.db.patch(row._id, { name });
  return { sandbox_id: row.sandboxId, name, previous_name: row.name, machine_id: row.machineId };
} });

export const remove = mutationGeneric({ args: { sandboxId: v.string() }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const row = await ownSandbox(ctx, accountId, args.sandboxId);
  await ctx.db.delete(row._id);
  return { sandbox_id: row.sandboxId, name: row.name, machine_id: row.machineId, removed: true };
} });

/** The calling machine's sandboxes, for its daemon's identity mirror. */
export const forMachine = queryGeneric({ args: {}, handler: async (ctx) => {
  const { machineId } = await requireIdentity(ctx, "machine");
  const rows = await boundedRows(ctx.db.query("sandboxes").withIndex("by_machine", (q: any) => q.eq("machineId", machineId)), "machine sandboxes");
  return rows.map((row: any) => ({ sandbox_id: row.sandboxId, name: row.name, cpus: row.cpus, memory_bytes: row.memoryBytes }));
} });

/** Runtime state (and the size the daemon runs it at) reported by the machine holding each sandbox; other machines' sandboxes are ignored and unchanged values are not written. */
export const reportState = mutationGeneric({ args: { states: v.array(v.object({ sandboxId: v.string(), state: v.string(), cpus: v.optional(v.number()), memoryBytes: v.optional(v.number()) })) }, handler: async (ctx, args) => {
  const { machineId } = await requireIdentity(ctx, "machine");
  let written = 0;
  for (const report of args.states.slice(0, 200)) {
    const row = await byField(ctx, "sandboxes", "by_sandbox", "sandboxId", report.sandboxId);
    if (!row || row.machineId !== machineId) continue;
    const patch: Record<string, unknown> = {};
    if (row.reportedState !== report.state) patch.reportedState = report.state;
    if (report.cpus !== undefined && report.cpus !== row.cpus) patch.cpus = report.cpus;
    if (report.memoryBytes !== undefined && report.memoryBytes !== row.memoryBytes) patch.memoryBytes = report.memoryBytes;
    if (Object.keys(patch).length) { await ctx.db.patch(row._id, { ...patch, reportedAt: Date.now() }); written++; }
  }
  return { written };
} });
