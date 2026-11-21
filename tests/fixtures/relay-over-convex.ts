import { makeFunctionReference } from "convex/server";
import { createConvexTestHarness } from "../../packages/state/src/index.js";
import { runOps } from "../../apps/relay/src/ops.js";
import type { Principal } from "../../apps/relay/src/relay-wait.js";
import { catalogById, success, type CapacityReport, type HostOperationRecord, type Json, type OperationId, type RequestEnvelope, type ResponseEnvelope } from "../../packages/contract/src/index.js";
import { memoryMailbox } from "./memory-mailbox.js";

export const ref = (name: string) => makeFunctionReference(name) as any;
export const GIB = 1024 ** 3;
/** One Mac's connector and daemon: the answer to a relayed request, or undefined while it never answers. */
export type Machine = (request: RequestEnvelope) => Promise<ResponseEnvelope | undefined>;
export const STUDIO: Principal = { accountId: "a1", machineId: "m1" };

/** A daemon's operation record for `request` (keyed by its mutation id, its subject the input's image), `fields` merged in. */
export const hostRecord = (request: RequestEnvelope, fields: Partial<HostOperationRecord> & { kind: string; state: HostOperationRecord["state"] }): ResponseEnvelope =>
  success(request, { key: request.mutation_id, subject: (request.input as { image: string }).image, started_at: 1, updated_at: 2, ...fields } as unknown as Json);

/**
 * Account a1 with `machines`, its catalog answered by the real Convex functions as each caller (a machine, or the agent
 * family f1), and every relayed request by that machine's entry in `connectors` (a machine with none is offline).
 * `op` runs one agent API call, with a fresh mutation id whenever the operation requires one, as the CLI sends it.
 */
export async function relayOverConvex(options: { machines: Array<{ machineId: string; name: string; capacity?: CapacityReport }>; sandboxes?: Array<{ sandboxId: string; machineId: string; name: string; os?: "linux" | "macos"; minMacOS?: string }>; connectors?: Record<string, Machine>; agent?: boolean }) {
  const t = createConvexTestHarness();
  const connectors = options.connectors ?? {};
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("accounts", { accountId: "a1", email: "a@example.com", name: "brave-walrus-100", createdAt: now });
    for (const machine of options.machines) await ctx.db.insert("machines", { ...machine, accountId: "a1", credentialHash: `h-${machine.machineId}`, createdAt: now, lastSeenAt: now, ...(machine.capacity ? { capacityAt: now } : {}) });
    for (const sandbox of options.sandboxes ?? []) await ctx.db.insert("sandboxes", { os: "linux", ...sandbox, accountId: "a1", imageId: "linux", cpus: 2, memoryBytes: 2 * GIB, sleepAfterMs: 1_800_000, createdAt: now });
    if (options.agent) await ctx.db.insert("oauthTokens", { accountId: "a1", clientId: "c1", scopes: ["account"], constraints: null, familyId: "f1", accessTokenHash: "a", refreshTokenHash: "r", accessExpiresAt: now + 60_000, refreshExpiresAt: now + 60_000 });
  });
  const as = (principal: Principal) => t.withIdentity({ subject: principal.machineId ? `machine:${principal.machineId}` : `agent:${principal.familyId}`, account: principal.accountId });
  const { deps } = memoryMailbox({ machines: options.machines, connectors });
  deps.accountCall = async (principal, kind, name, args) => await (as(principal) as any)[kind](ref(name), args);
  let calls = 0;
  const op = async (operation: OperationId, body: Record<string, unknown> = {}, principal: Principal = STUDIO): Promise<any> => {
    const required = catalogById.get(operation)?.idempotency === "required";
    const result = await runOps(principal, { operation, request_id: `req-${++calls}`, input: {}, ...(required ? { mutation_id: `mut-${calls}` } : {}), ...body }, deps);
    return (result.body as { response: ResponseEnvelope }).response;
  };
  /** An image saved on `holders[0]` and ready on every Mac in `holders`. */
  const readyImage = async (name: string, holders: string[], sizeBytes: number) => {
    const first = as({ accountId: "a1", machineId: holders[0] });
    const image = await first.mutation(ref("images:reserve"), { machineId: holders[0], name, os: "linux", source: { kind: "sandbox", sandboxName: "bold-otter" }, createMutationId: `capture-${name}` }) as any;
    for (const [index, machineId] of holders.entries()) await as({ accountId: "a1", machineId }).mutation(ref("images:setHolder"), { imageId: image.image_id, state: "ready", ...(index === 0 ? { sizeBytes } : {}) });
    return image;
  };
  const images = async () => (await as(STUDIO).query(ref("images:list"), {}) as any[]).filter((row) => row.image_id !== "linux");
  return { t, deps, connectors, as, op, readyImage, images };
}
