import { ConvexHttpClient } from "convex/browser";
import { ConvexRelayStateRepository, InMemoryRelayStateRepository } from "../../../packages/state/src/index.js";
import { createVercelRelayHandler } from "../src/vercel.js";
import { PUBLIC_MCP_RESOURCE } from "../../../packages/config/src/index.js";
import { signMachineToken, signServiceToken } from "../../../packages/tokens/src/index.js";
import { selectMailer } from "../../../packages/mail/src/index.js";
import { makeFunctionReference } from "convex/server";

// This module is the deployable adapter. Convex is selected whenever its URL is
// present; the explicit local-services flag only permits the local test doubles.
const localServices = process.env.LOCALBOX_LOCAL_SERVICES === "1";
if (process.env.VERCEL && !localServices && !process.env.CONVEX_URL) throw new Error("CONVEX_URL is required for the deployed relay");
if (process.env.VERCEL && process.env.CONVEX_URL && !process.env.LOCALBOX_JWT_PRIVATE_KEY) throw new Error("LOCALBOX_JWT_PRIVATE_KEY is required for the deployed relay");
const repository = process.env.CONVEX_URL
  ? new ConvexRelayStateRepository(new ConvexHttpClient(process.env.CONVEX_URL, { skipConvexDeploymentUrlCheck: true }), "convex", signServiceToken)
  : new InMemoryRelayStateRepository({ deploymentId: "vercel-local" });
const handleRelay = createVercelRelayHandler(repository, {
  resource: PUBLIC_MCP_RESOURCE,
  maxBodyBytes: numberEnv("LOCALBOX_RELAY_MAX_BODY_BYTES", 8 * 1024 * 1024),
});

/** A fresh client per call: function instances serve concurrent requests, and auth is per client. */
const convexAs = (token: string): ConvexHttpClient => {
  if (!process.env.CONVEX_URL) throw new Error("CONVEX_URL is required");
  const client = new ConvexHttpClient(process.env.CONVEX_URL, { skipConvexDeploymentUrlCheck: true }); client.setAuth(token); return client;
};
const configuredMailer = process.env.VERCEL ? selectMailer() : undefined;
const serviceCall = async (kind: "mutation" | "query", name: string, args: Record<string, unknown>) =>
  await (convexAs(signServiceToken()) as any)[kind](makeFunctionReference(name) as any, args) as any;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bodyOf = async (request: Request) => await request.json() as Record<string, unknown>;
const clientIp = (request: Request) => request.headers.get("x-real-ip") ?? request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
async function handleIdentity(request: Request): Promise<Response | undefined> {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  if (request.method === "POST" && path === "/auth/email/start") {
    const input = await bodyOf(request); const email = String(input.email ?? "");
    const result = await serviceCall("mutation", "signin:start", { email, ip: clientIp(request) });
    if (result.issued) await (configuredMailer ?? selectMailer()).sendCode({ to: email.trim().toLowerCase(), code: result.code, idempotencyKey: `${email}:${result.code}` });
    return json({ message: "code sent" });
  }
  if (request.method === "POST" && path === "/auth/email/verify") {
    const input = await bodyOf(request); let result: any;
    try { result = await serviceCall("mutation", "signin:verify", { email: String(input.email ?? ""), code: String(input.code ?? ""), machineName: String(input.machine_name ?? "machine"), ip: clientIp(request) }); }
    catch (error) { if (/rate limit/i.test(error instanceof Error ? error.message : "")) return json({ error: "too many verification attempts; try again later" }, 429); throw error; }
    if (!result.valid) return json({ error: "verification code is invalid or expired" }, 400);
    return json({ ...result, api_origin: process.env.LOCALBOX_API_ORIGIN ?? "http://127.0.0.1:3000", convex_url: process.env.CONVEX_URL });
  }
  if (request.method === "POST" && path === "/auth/logout") {
    const secret = bearer(request); if (!secret) return json({ error: "unauthorized" }, 401);
    let machine: any; try { machine = await serviceCall("query", "signin:authenticate", { secret }); } catch { return json({ error: "this machine was removed; run localbox login" }, 401); }
    await convexAs(signMachineToken(machine.machineId, machine.accountId)).mutation(makeFunctionReference("machines:revokeSelf") as any, {});
    return json({ revoked: true, machine_id: machine.machineId });
  }
  if (request.method === "POST" && path === "/v1/ops") {
    const secret = bearer(request); if (!secret) return json({ error: "unauthorized" }, 401);
    const input = await bodyOf(request);
    let machine: any; try { machine = await serviceCall("query", "signin:authenticate", { secret }); } catch { return json({ error: "this machine was removed; run localbox login" }, 401); }
    const convex = convexAs(signMachineToken(machine.machineId, machine.accountId));
    const operation = String(input.operation ?? ""); const payload = (input.input ?? {}) as Record<string, unknown>;
    const table: Record<string, ["mutation" | "query", string]> = { "account.status": ["query", "accounts:status"], "account.rename": ["mutation", "accounts:rename"], "machine.list": ["query", "machines:list"], "machine.rename": ["mutation", "machines:rename"], "machine.remove": ["mutation", "machines:remove"] };
    const entry = table[operation]; if (!entry) return json({ error: "unsupported operation" }, 400);
    const args = operation === "machine.rename" || operation === "machine.remove" ? (({ machine_id: machineId, ...rest }) => ({ ...rest, machineId }))(payload) : payload;
    try { return json(await (convex as any)[entry[0]](makeFunctionReference(entry[1]) as any, args)); } catch (error) { const message = error instanceof Error ? error.message : "operation failed"; return json({ error: /revoked|Forbidden/i.test(message) ? "this machine was removed; run localbox login" : message }, 401); }
  }
  return undefined;
}

export default async function handle(request: Request): Promise<Response> {
  const identity = await handleIdentity(request);
  return identity ?? handleRelay(request);
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
