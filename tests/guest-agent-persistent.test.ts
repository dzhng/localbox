import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decodeGuestFrames, encodeGuestFrame } from "../packages/guest-gateway/src/protocol.js";

/** One host connection to the agent's socket: waits for ready, then sends requests and reads responses. */
async function open(path: string): Promise<{ call(request: Record<string, unknown>): Promise<any>; ready: any; close(): void }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const socket = await new Promise<Socket>((resolve, reject) => { const s = connect(path, () => resolve(s)); s.once("error", reject); });
      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0); const frames: any[] = []; const waiters: Array<() => void> = [];
      socket.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); const decoded = decodeGuestFrames(buffer); buffer = decoded.remainder; frames.push(...decoded.frames); waiters.splice(0).forEach((wake) => wake()); });
      const next = async (kind: string) => { for (;;) { const index = frames.findIndex((frame) => frame.kind === kind); if (index >= 0) return frames.splice(index, 1)[0]; await new Promise<void>((resolve) => waiters.push(resolve)); } };
      const ready = await next("ready");
      return { ready, close: () => socket.destroy(), call: async (request) => { socket.write(encodeGuestFrame({ kind: "request", request, channel_epoch: ready.channel_epoch } as never)); return (await next("response")).response; } };
    } catch (error) { if (attempt > 100) throw error; await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
}
const envelope = (operation: string, input: unknown, mutation: string | null = null) => ({ protocol_version: "v1", request_id: `r-${Math.random()}`, operation, sandbox_id: "sandbox_t", deadline_ms: 10_000, mutation_id: mutation, input });

test("the persistent agent keeps its jobs and their processes when a host connection drops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lb-agent-")); const path = join(dir, "agent.sock");
  const agent = spawn(process.execPath, ["--import", "tsx", "apps/guest-agent/src/index.ts"], { env: { ...process.env, LOCALBOX_ROOT: dir, LOCALBOX_READINESS_MARKER: join(dir, "ready"), LOCALBOX_AGENT_SOCKET: path }, stdio: "ignore" });
  try {
    const first = await open(path);
    const started = await first.call(envelope("shell.exec", { command: "sleep 30", background: true }, "m-bg"));
    assert.equal(started.ok, true, JSON.stringify(started)); const jobId = started.result.job_id;
    first.close(); await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await open(path);
    assert.ok(second.ready.channel_epoch >= first.ready.channel_epoch);
    const status = await second.call(envelope("job.status", { job_id: jobId }));
    assert.equal(status.result.status, "running", "the job outlived the connection that started it");
    await second.call(envelope("job.cancel", { job_id: jobId }, "m-cancel")); second.close();
  } finally { agent.kill("SIGKILL"); }
});
