import { queryGeneric } from "convex/server";
import { requireIdentity } from "./lib/identity.js";
import { byField, clean } from "./lib/relay.js";

/** The calling machine's own record; the only data a machine identity can read here. */
export const self = queryGeneric({ args: {}, handler: async (ctx) => {
  const { machineId } = await requireIdentity(ctx, "machine");
  const { credentialHash: _hash, ...machine } = clean(await byField(ctx, "machines", "by_machine", "machineId", machineId));
  return machine;
} });
