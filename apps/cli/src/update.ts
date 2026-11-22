import { closeSync } from "node:fs";
import { ContractError, type Json } from "../../../packages/contract/src/index.js";
import { machinePaths } from "../../../packages/config/src/index.js";
import type { AppDeps } from "./app.js";
import { askApp, callApp, type AppOperation } from "./app-socket.js";
import { layout } from "./layout.js";

/**
 * What `localbox update` prints: Localbox.app's updater (`UpdateCoordinator`, specs/menu-bar-app slice 15). `state`
 * is one of `idle`, `disabled`, `checking`, `downloading`, `waiting`, `installing`, `failed`; `status` the sentence
 * Settings shows under its button.
 */
export interface UpdateStatus { available: true; enabled: boolean; can_check: boolean; state: string; status: string | null; version: string | null }

export interface UpdateDeps extends AppDeps {
  /** How often a check is polled while Sparkle works, and for how long at most. */
  pollMs?: number;
  settleMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Sparkle is still finding or fetching the update; anything else is an answer. */
const BUSY = new Set(["checking", "downloading"]);

/**
 * `localbox update check|install|status` and `localbox update automatic on|off`, all clients of the app socket.
 * `check` and `install` wait until Sparkle has an answer (nothing newer, an update waiting or installing, a failure),
 * so the caller reads the outcome, not "checking". An install the app performs quits the app: the last status before
 * it went is the answer.
 */
export async function updateCommand(words: string[], deps: UpdateDeps = {}): Promise<Json> {
  const [verb, choice, ...rest] = words;
  const socket = (deps.paths ?? machinePaths()).appSocket;
  const ask = async (operation: AppOperation, params: Record<string, Json> = {}) =>
    await askApp(deps.layout ?? layout(), { appSocket: socket }, operation, params, deps.launch) as unknown as UpdateStatus;
  if (verb === "automatic") {
    if ((choice !== "on" && choice !== "off") || rest.length) throw new ContractError("invalid_input", "localbox update automatic takes on or off");
    return await ask("update.set_automatic", { enabled: choice === "on" }) as unknown as Json;
  }
  if (choice !== undefined) throw new ContractError("invalid_input", `unexpected ${words.slice(1).join(" ")}; localbox update takes check, install, status or automatic on|off`);
  if (verb === "status") return await ask("update.status") as unknown as Json;
  if (verb !== "check" && verb !== "install") throw new ContractError("invalid_input", "localbox update takes check, install, status or automatic on|off");
  // This command waits for the install it asks for, which waits for every command holding the launch lock: it lets go
  // of its own share first (everything it runs from here is already loaded).
  releaseLaunchLock(deps.env ?? process.env);
  let status = await ask(verb === "check" ? "update.check" : "update.install");
  const deadline = Date.now() + (deps.settleMs ?? 120_000);
  while (BUSY.has(status.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? 500));
    // Straight to the socket: an app that quit to install is never started again from here.
    try { status = await callApp(socket, "update.status") as unknown as UpdateStatus; } catch (error) {
      if (error instanceof ContractError && error.code === "guest_unreachable") break;
      throw error;
    }
  }
  return status as unknown as Json;
}

/** Closes the launcher's descriptor (`LOCALBOX_LAUNCH_LOCK_FD`), which releases this process's shared hold. */
function releaseLaunchLock(env: NodeJS.ProcessEnv): void {
  const descriptor = Number(env.LOCALBOX_LAUNCH_LOCK_FD);
  if (!Number.isInteger(descriptor) || descriptor <= 2) return;
  try { closeSync(descriptor); } catch { /* already closed */ }
  delete env.LOCALBOX_LAUNCH_LOCK_FD;
}
