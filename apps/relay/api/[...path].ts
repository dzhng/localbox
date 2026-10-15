import { makeFunctionReference } from "convex/server";
import { signMachineToken } from "../../../packages/tokens/src/index.js";
import { selectMailer } from "../../../packages/mail/src/index.js";
import { handleOps } from "../src/ops.js";
import { convexAs, machineFor, opsDeps, principalFor, serviceCall } from "../src/convex-deps.js";
import { bearer, clientIp, json } from "../src/http.js";

// This module is the deployable adapter. Convex is selected whenever its URL is
// present; the explicit local-services flag only permits the local test doubles.
const localServices = process.env.LOCALBOX_LOCAL_SERVICES === "1";
if (process.env.VERCEL && !localServices && !process.env.CONVEX_URL) throw new Error("CONVEX_URL is required for the deployed relay");
if (process.env.VERCEL && process.env.CONVEX_URL && !process.env.LOCALBOX_JWT_PRIVATE_KEY) throw new Error("LOCALBOX_JWT_PRIVATE_KEY is required for the deployed relay");
const bodyOf = async (request: Request) => await request.json() as Record<string, unknown>;
async function handleIdentity(request: Request): Promise<Response | undefined> {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  if (request.method === "POST" && path === "/auth/email/start") {
    const input = await bodyOf(request); const email = String(input.email ?? "");
    const result = await serviceCall("mutation", "signin:start", { email, ip: clientIp(request) });
    // The mailer is chosen per send, so a deployment without email still serves everything else.
    if (result.issued) {
      let mailer: ReturnType<typeof selectMailer>;
      try { mailer = selectMailer(); } catch { return json({ error: "email sign-in is not available yet: this deployment has no email delivery configured" }, 503); }
      await mailer.sendCode({ to: email.trim().toLowerCase(), code: result.code, idempotencyKey: `${email}:${result.code}` });
    }
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
  if (request.method === "GET" && path === "/status") {
    const machine = await machineFor(bearer(request)); if (!machine) return json({ error: "unauthorized" }, 401);
    return json({ machine_id: machine.machineId, account_id: machine.accountId });
  }
  if (request.method === "POST" && (path === "/machine-token" || path === "/relay/machine-token")) {
    const machine = await machineFor(bearer(request)); if (!machine) return json({ error: "this machine was removed; run localbox login" }, 401);
    await serviceCall("mutation", "machines:touch", { machineId: machine.machineId });
    return json({ token: signMachineToken(machine.machineId, machine.accountId), expires_at: Date.now() + 86_400_000, convex_url: process.env.CONVEX_URL });
  }
  if (request.method === "POST" && path === "/v1/ops") {
    const principal = await principalFor(bearer(request)); if (!principal) return json({ error: "this machine was removed or the agent is signed out; sign in again" }, 401);
    const signedOut = principal.machineId ? "this machine was removed; run localbox login" : "this agent's sign-in was revoked; sign in again";
    try { const result = await handleOps(principal, await bodyOf(request), opsDeps); return json(result.body, result.status); }
    catch (error) { const message = error instanceof Error ? error.message : "operation failed"; return json({ error: /revoked|Forbidden/i.test(message) ? signedOut : message }, /revoked|Forbidden/i.test(message) ? 401 : 400); }
  }
  return undefined;
}

export default async function handle(request: Request): Promise<Response> {
  try { return await handleIdentity(request) ?? json({ error: "not_found" }, 404); }
  catch (error) { return json({ error: "internal_error", error_description: error instanceof Error ? error.message : String(error) }, 500); }
}
