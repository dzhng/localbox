import type { Auth, UserIdentity } from "convex/server";
import { familyRevoked } from "./relay.js";

type IdentityContext = { auth: Auth; db: any };
export type IdentityKind = "service" | "machine" | "agent";
export type LocalboxIdentity = {
  kind: IdentityKind;
  subject: string;
  accountId?: string;
  machineId?: string;
  familyId?: string;
  identity: UserIdentity;
};
export type AccountCaller = { accountId: string; machineId?: string; familyId?: string };

/** Authenticate a Convex function and enforce the caller's durable kind. */
export async function requireIdentity(ctx: IdentityContext, kind: IdentityKind): Promise<LocalboxIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  if (kind === "service") {
    if (identity.subject !== "service:api") throw new Error("Forbidden: service identity required");
    return { kind, subject: identity.subject, identity };
  }
  if (kind === "agent") {
    if (!identity.subject.startsWith("agent:")) throw new Error("Forbidden: agent identity required");
    const familyId = identity.subject.slice("agent:".length);
    if (!familyId || typeof identity.account !== "string") throw new Error("Forbidden: invalid agent identity");
    // The JWT outlives a revocation by up to five minutes, so the family is checked on every call.
    const token = await ctx.db.query("oauthTokens").withIndex("by_family", (q: any) => q.eq("familyId", familyId)).first();
    if (!token || token.accountId !== identity.account) throw new Error("Forbidden: agent token unknown");
    if (await familyRevoked(ctx, familyId)) throw new Error("Forbidden: agent token revoked");
    return { kind, subject: identity.subject, familyId, accountId: token.accountId, identity };
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

/** A caller acting on its account's catalog: one of the account's machines or a signed-in agent. */
export async function requireAccount(ctx: IdentityContext): Promise<AccountCaller> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  if (identity.subject.startsWith("agent:")) { const agent = await requireIdentity(ctx, "agent"); return { accountId: agent.accountId!, familyId: agent.familyId }; }
  if (identity.subject.startsWith("machine:")) { const machine = await requireIdentity(ctx, "machine"); return { accountId: machine.accountId!, machineId: machine.machineId }; }
  throw new Error("Forbidden: machine or agent identity required");
}
