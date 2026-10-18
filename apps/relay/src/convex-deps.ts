import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { ConvexOAuthRepository, type ServiceCall } from "../../../packages/state/src/index.js";
import { signAgentToken, signMachineToken, signServiceToken } from "../../../packages/tokens/src/index.js";
import type { OpsDeps, Principal } from "./ops.js";

/** A fresh client per call: function instances serve concurrent requests, and auth is per client. */
export const convexAs = (token: string): ConvexHttpClient => {
  if (!process.env.CONVEX_URL) throw new Error("CONVEX_URL is required");
  const client = new ConvexHttpClient(process.env.CONVEX_URL, { skipConvexDeploymentUrlCheck: true }); client.setAuth(token); return client;
};
export const serviceCall: ServiceCall = async (kind, name, args) => await (convexAs(signServiceToken()) as any)[kind](makeFunctionReference(name) as any, args);
export const oauthRepository = new ConvexOAuthRepository(serviceCall);

const tokenFor = (principal: Principal) => {
  if (principal.machineId) return signMachineToken(principal.machineId, principal.accountId);
  if (principal.familyId) return signAgentToken(principal.familyId, principal.accountId);
  throw new ConvexError({ code: "unauthorized", message: "Forbidden: the caller has no machine or agent identity" });
};

export const opsDeps: OpsDeps = {
  accountCall: async (principal, kind, name, args) => await (convexAs(tokenFor(principal)) as any)[kind](makeFunctionReference(name) as any, args),
  serviceMutation: async (name, args) => await serviceCall("mutation", name, args),
  watchResult: (requestId, onChange, onError) => {
    if (!process.env.CONVEX_URL) throw new Error("CONVEX_URL is required");
    const client = new ConvexClient(process.env.CONVEX_URL, { skipConvexDeploymentUrlCheck: true });
    client.setAuth(async () => signServiceToken());
    const unsubscribe = client.onUpdate(makeFunctionReference<"query">("relay:result") as any, { requestId }, (result: any) => onChange(result ?? null), onError);
    return () => { unsubscribe(); void client.close(); };
  },
};

/** The machine behind a machine credential, or undefined when it is missing, unknown or removed. */
export async function machineFor(secret: string | undefined): Promise<{ machineId: string; accountId: string } | undefined> {
  if (!secret) return undefined;
  try { return await serviceCall("query", "signin:authenticate", { secret }); } catch { return undefined; }
}

/** Either credential the agent API accepts, resolved to its account: a machine credential or an agent access token. */
export async function principalFor(secret: string | undefined): Promise<Principal | undefined> {
  if (!secret) return undefined;
  const machine = await machineFor(secret); if (machine) return { accountId: machine.accountId, machineId: machine.machineId };
  try { const grant = await oauthRepository.validateAccess(secret); return { accountId: grant.accountId, familyId: grant.familyId }; } catch { return undefined; }
}
