import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, test } from "node:test";
import { decodeGuestFrames, encodeGuestFrame, type GuestFrame } from "../packages/guest-gateway/src/protocol.js";
import { BUN_VERSION, agentBinaryName, buildGuestAgent, bunVersion } from "../scripts/build-guest-agent.js";

// The built agent binaries, driven the way the process-fixture backend drives an agent: one connection on stdin/stdout.
// The linux binary runs in a bare Ubuntu 24.04 container (no Node) unless this host is itself linux arm64.

const outDir = resolve("dist/guest-agent");
const UBUNTU = "ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55";
const noBun = bunVersion() === BUN_VERSION ? false : `bun ${BUN_VERSION} is not installed`;
const nativeLinux = process.platform === "linux" && process.arch === "arm64";
const noLinux = noBun || (nativeLinux || spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 ? false : "needs linux arm64 or Docker");
const noDarwin = noBun || (process.platform === "darwin" && process.arch === "arm64" ? false : "needs darwin arm64");

let built: Awaited<ReturnType<typeof buildGuestAgent>> | undefined;
before(async () => { if (!noBun) built = await buildGuestAgent(outDir); });

interface Session { ready: Extract<GuestFrame, { kind: "ready" }>; call(operation: string, input: unknown, mutation?: string): Promise<any>; close(): Promise<void> }

async function session(child: ChildProcess): Promise<Session> {
  let buffer: Buffer = Buffer.alloc(0); const frames: GuestFrame[] = []; const waiters: Array<() => void> = []; let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk; });
  child.stdout!.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); const decoded = decodeGuestFrames(buffer); buffer = decoded.remainder; frames.push(...decoded.frames); waiters.splice(0).forEach((wake) => wake()); });
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => { waiters.splice(0).forEach((wake) => wake()); resolveExit(); }));
  const next = async <K extends GuestFrame["kind"]>(kind: K): Promise<Extract<GuestFrame, { kind: K }>> => {
    for (;;) {
      const index = frames.findIndex((frame) => frame.kind === kind);
      if (index >= 0) return frames.splice(index, 1)[0] as Extract<GuestFrame, { kind: K }>;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the agent exited before its ${kind} frame: ${stderr}`);
      await new Promise<void>((wake) => waiters.push(wake));
    }
  };
  const ready = await next("ready");
  let id = 0;
  return {
    ready,
    call: async (operation, input, mutation) => {
      const request = { protocol_version: "v1", request_id: `r-${++id}`, operation, sandbox_id: "sandbox_bin", deadline_ms: 30_000, mutation_id: mutation ?? null, input };
      child.stdin!.write(encodeGuestFrame({ kind: "request", request, channel_epoch: ready.channel_epoch } as GuestFrame));
      const { response } = await next("response");
      assert.equal(response.ok, true, `${operation}: ${JSON.stringify(response)}`);
      return (response as { result: unknown }).result;
    },
    // Closing stdin ends the connection, and with it a stdin/stdout agent.
    close: async () => { child.stdin!.end(); await exited; },
  };
}

function linuxAgent(): ChildProcess {
  const env = { LOCALBOX_ROOT: "/tmp", LOCALBOX_READINESS_MARKER: "/tmp/ready" };
  if (nativeLinux) return spawn(join(outDir, agentBinaryName("linux")), [], { env: { PATH: "/usr/bin:/bin", ...env } });
  return spawn("docker", ["run", "-i", "--rm", "--platform", "linux/arm64", "-v", `${outDir}:/agent:ro`,
    ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]), UBUNTU, `/agent/${agentBinaryName("linux")}`]);
}

test("the linux agent binary serves shell, files and jobs with no Node installed", { skip: noLinux, timeout: 180_000 }, async () => {
  const agent = await session(linuxAgent());
  try {
    assert.equal(agent.ready.readiness_marker, "/tmp/ready");
    assert.deepEqual([agent.ready.agent_version, agent.ready.agent_os], [built!.version, "linux"], "the binary announces the version it was built as");
    assert.equal((await agent.call("system.info", {})).gateway, "guest");
    if (!nativeLinux) {
      const node = await agent.call("shell.exec", { command: "command -v node nodejs" }, "m-node");
      assert.notEqual(node.exit_code, 0, `the container has a Node runtime: ${node.stdout}`);
    }
    const written = await agent.call("shell.exec", { command: "uname -sm > /tmp/uname.txt && cat /tmp/uname.txt" }, "m-write");
    assert.equal(written.exit_code, 0); assert.equal(written.stdout, "Linux aarch64\n");
    assert.equal((await agent.call("fs.read", { path: "/uname.txt" })).content, "Linux aarch64\n");
    const job = await agent.call("shell.exec", { command: "sleep 0.2; echo done", background: true }, "m-job");
    const waited = await agent.call("job.wait", { job_id: job.job_id, timeout_ms: 20_000 });
    assert.equal(waited.status, "completed"); assert.equal(waited.exit_code, 0);
    assert.equal((await agent.call("job.output", { job_id: job.job_id })).data, "done\n");
  } finally { await agent.close(); }
});

test("the darwin agent binary starts and answers over stdin/stdout", { skip: noDarwin, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "lb-agent-bin-"));
  const agent = await session(spawn(join(outDir, agentBinaryName("darwin")), [], { env: { PATH: "/usr/bin:/bin", LOCALBOX_ROOT: root, LOCALBOX_READINESS_MARKER: join(root, "ready") } }));
  try {
    assert.deepEqual([agent.ready.agent_version, agent.ready.agent_os], [built!.version, "darwin"]);
    assert.equal((await agent.call("system.info", {})).gateway, "guest");
    const uname = await agent.call("shell.exec", { command: "uname -s" }, "m-uname");
    assert.equal(uname.stdout, "Darwin\n");
  } finally { await agent.close(); }
});
