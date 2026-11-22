import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { ContractError, ERROR_CODES, type ErrorCode, type Json } from "../../../packages/contract/src/index.js";
import type { MachinePaths } from "../../../packages/config/src/index.js";
import { ensureApp, type AppLaunchOptions } from "./app-launch.js";
import type { Layout } from "./layout.js";

/** Localbox.app's operations (`AppControl` in apps/macos/App); none is a catalog operation. */
export type AppOperation = "app.info" | "login_item.get" | "login_item.set";

export const NEEDS_APP = "this command needs Localbox.app";

/**
 * One request to the app's socket (`<root>/app.sock`): one JSON line out, one back, as `AppSocket` frames them.
 * Returns the answer's `result`; a refusal is thrown as the app's `ContractError`, an app that does not answer as a
 * retryable `guest_unreachable`, the code every local command gives when Localbox is not running.
 */
export function callApp(socket: string, operation: AppOperation, params: Record<string, Json> = {}, timeoutMs = 10_000): Promise<Json> {
  const id = `cli-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let reply = "";
    const fail = (error: ContractError) => { connection.destroy(); reject(error); };
    connection.setEncoding("utf8");
    connection.setTimeout(timeoutMs, () => fail(new ContractError("guest_unreachable", `Localbox did not answer ${operation} within ${timeoutMs / 1000} s`, undefined, true)));
    connection.once("connect", () => connection.write(`${JSON.stringify({ id, operation, params })}\n`));
    connection.on("data", (chunk: string) => { reply += chunk; });
    connection.once("error", (error: NodeJS.ErrnoException) => fail(new ContractError("guest_unreachable", `Localbox is not running (${error.code ?? error.message}); open Localbox from Applications`, undefined, true)));
    connection.once("end", () => {
      let answer: { id?: string; ok?: boolean; result?: Json; error?: { code?: string; message?: string } };
      try { answer = JSON.parse(reply.split("\n")[0]); } catch { return fail(new ContractError("internal", `Localbox answered ${operation} with something other than JSON: ${reply.slice(0, 200)}`)); }
      if (answer.id !== id) return fail(new ContractError("internal", `Localbox answered a different request (${answer.id}) to ${operation}`));
      if (answer.ok) { connection.destroy(); return resolve(answer.result ?? null); }
      const code = ERROR_CODES.includes(answer.error?.code as ErrorCode) ? answer.error!.code as ErrorCode : "internal";
      fail(new ContractError(code, answer.error?.message ?? `Localbox refused ${operation}`));
    });
  });
}

/**
 * `callApp` for a CLI inside Localbox.app: the app is started first if it is quit (`ensureApp`, waiting on the app's
 * socket, which answers even while the daemon is down). Any other CLI has no app to ask.
 */
export async function askApp(layout: Pick<Layout, "app">, paths: Pick<MachinePaths, "appSocket">, operation: AppOperation, params: Record<string, Json> = {}, options: AppLaunchOptions = {}): Promise<Json> {
  if (!layout.app) throw new ContractError("unsupported", NEEDS_APP);
  const started = await ensureApp(layout, { socket: paths.appSocket }, options);
  if (started.state === "failed") throw new ContractError("guest_unreachable", started.message, undefined, true);
  return callApp(paths.appSocket, operation, params);
}
