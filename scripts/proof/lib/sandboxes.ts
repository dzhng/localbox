import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asMachine } from "./as-machine.js";
import { API_ORIGIN, login, machineRoot, startConnector } from "./login.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The daemon's records on a proof machine (`sandboxes/<id>/sandbox.json`). */
export function sandboxRecords(root: string, machine: string): Array<{ sandbox_id: string; name: string; in_catalog: boolean; [key: string]: unknown }> {
  const sandboxes = join(machineRoot(root, machine), "sandboxes");
  if (!existsSync(sandboxes)) return [];
  return readdirSync(sandboxes).flatMap((id) => { try { return [JSON.parse(readFileSync(join(sandboxes, id, "sandbox.json"), "utf8"))]; } catch { return []; } });
}

/** A fixture sandbox's own guest root, found by its name. */
export function guestRoot(root: string, machine: string, name: string): string {
  const record = sandboxRecords(root, machine).find((row) => row.name === name);
  if (!record) throw new Error(`machine ${machine} has no sandbox named ${name}`);
  return join(machineRoot(root, machine), "sandboxes", record.sandbox_id, "root");
}

/** Whether any fixture sandbox on `machine` has `file` in its guest root. */
export function inAnyGuestRoot(root: string, machine: string, file: string): boolean {
  return sandboxRecords(root, machine).some((record) => existsSync(join(machineRoot(root, machine), "sandboxes", record.sandbox_id, "root", file)));
}

/** Runs the CLI as a proof machine against the local stack; `--json` output is parsed into `envelope`. */
export async function cli(root: string, machine: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string; envelope: any }> {
  const result = await asMachine(machine, args, { cwd: root, env: { LOCALBOX_API_ORIGIN: API_ORIGIN } });
  let envelope: any = {};
  if (args.includes("--json")) { try { envelope = JSON.parse(result.stdout.trim() || "{}"); } catch { envelope = { unparsed: result.stdout }; } }
  return { ...result, envelope };
}

export async function waitConnected(root: string, machine: string, at = machineRoot(root, machine)): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (readFileSync(join(at, "logs/connector.log"), "utf8").split("started for machine").at(-1)?.includes("state connected")) return;
    await sleep(250);
  }
  throw new Error(`machine ${machine}'s connector never reported connected`);
}

/** Signs each machine in with `email`, starts its connector and, unless told otherwise, creates one sandbox on it. */
export async function signedInWithSandboxes(root: string, machines: string[], email: string, options: { create?: boolean } = {}): Promise<{ connectors: Record<string, ChildProcess>; sandboxes: Record<string, string> }> {
  const connectors: Record<string, ChildProcess> = {}; const sandboxes: Record<string, string> = {};
  for (const machine of machines) {
    const signed = await login(root, machine, email);
    if (signed.code !== 0) throw new Error(`${machine} could not sign in: ${signed.stderr || signed.stdout}`);
    writeFileSync(join(machineRoot(root, machine), "logs/connector.log"), "");
    connectors[machine] = startConnector(root, machine);
  }
  for (const machine of machines) await waitConnected(root, machine);
  if (options.create === false) return { connectors, sandboxes };
  for (const machine of machines) {
    const created = await createSandbox(root, machine);
    sandboxes[machine] = created.envelope.result.produced.name;
  }
  return { connectors, sandboxes };
}

/** `sandbox create --json` on `machine`, retried while its connector has not yet reported the machine's size. */
export async function createSandbox(root: string, machine: string, extra: string[] = []): Promise<Awaited<ReturnType<typeof cli>>> {
  for (let attempt = 0; ; attempt++) {
    const created = await cli(root, machine, ["sandbox", "create", "--json", ...extra]);
    if (created.envelope.ok) return created;
    if (created.envelope.error?.code !== "machine_offline" || attempt >= 20) throw new Error(`sandbox create on ${machine} failed: ${created.stdout}${created.stderr}`);
    await sleep(250);
  }
}
