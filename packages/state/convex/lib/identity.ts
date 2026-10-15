import type { Auth, UserIdentity } from "convex/server";

type IdentityContext = { auth: Auth; db: any };
export type IdentityKind = "service" | "machine";
export type LocalboxIdentity = {
  kind: IdentityKind;
  subject: string;
  accountId?: string;
  machineId?: string;
  identity: UserIdentity;
};

/** Authenticate a Convex function and enforce the caller's durable kind. */
export async function requireIdentity(ctx: IdentityContext, kind: IdentityKind): Promise<LocalboxIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  if (kind === "service") {
    if (identity.subject !== "service:api") throw new Error("Forbidden: service identity required");
    return { kind, subject: identity.subject, identity };
  }
  if (!identity.subject.startsWith("machine:")) throw new Error("Forbidden: machine identity required");
  const machineId = identity.subject.slice("machine:".length);
  if (!machineId) throw new Error("Forbidden: invalid machine identity");
  const machine = await ctx.db.query("machines").withIndex("by_machine", (q: any) => q.eq("machineId", machineId)).first();
  if (!machine || machine.revokedAt !== undefined) throw new Error("Forbidden: machine revoked or unknown");
  const accountId = typeof identity.account === "string" ? identity.account : machine.accountId;
  if (accountId !== machine.accountId) throw new Error("Forbidden: machine account mismatch");
  return { kind, subject: identity.subject, machineId, accountId, identity };
}
