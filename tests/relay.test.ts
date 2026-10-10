import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayError, RelayServer, ChannelSupervisor } from "../apps/relay/src/index.js";

test("relay rejects stale and revoked channel grants", async () => {
  const relay = new RelayServer();
  const grant = relay.issueGrant("vm_01");
  relay.attach(grant, async (frame) => frame);
  const reply = await relay.route(grant, { kind: "request", vm_id: "vm_01", payload: { ok: true } });
  assert.equal(reply?.sequence, 1);
  relay.revoke(grant);
  await assert.rejects(() => relay.route(grant, { kind: "request", vm_id: "vm_01" }), RelayError);
});

test("channel supervisor reconnects with bounded lifecycle", async () => {
  let attempts = 0;
  const supervisor = new ChannelSupervisor({ connect: async () => { attempts++; if (attempts === 1) throw new Error("offline"); return { send: async () => undefined, close: async () => undefined }; }, minBackoffMs: 1, maxBackoffMs: 2, heartbeatMs: 100 });
  await supervisor.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(supervisor.state, "connected");
  await supervisor.stop();
  assert.equal(supervisor.state, "disconnected");
});
