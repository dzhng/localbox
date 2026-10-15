import { spawn, type ChildProcess } from "node:child_process";

const convexEnv = { CONVEX_AGENT_MODE: "anonymous" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts Convex function executions while `during` runs, from the local backend's function log. */
export async function countConvexCalls(root: string, during: () => Promise<void>): Promise<number> {
  let count = 0; const child: ChildProcess = spawn("npx", ["convex", "logs", "--success", "--jsonl", "--history", "0"], { cwd: root, env: { ...process.env, ...convexEnv }, stdio: ["ignore", "pipe", "ignore"], detached: true });
  child.stdout!.on("data", (chunk: Buffer) => { count += chunk.toString().split("\n").filter((line) => line.includes("\"udfType\"") || line.includes("\"identifier\"")).length; });
  await sleep(3000); count = 0;
  try { await during(); await sleep(2000); } finally { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } }
  return count;
}
