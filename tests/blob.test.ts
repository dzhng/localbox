import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { BlobError, InMemoryBlobProvider, isBlobReference } from "../packages/blob/src/index.js";
import { PROTOCOL_VERSION, success, type RequestEnvelope } from "../packages/contract/src/index.js";
import { GuestService } from "../packages/guest-gateway/src/service.js";
import { decodeGuestFrames, encodeGuestFrame, type GuestFrame } from "../packages/guest-gateway/src/protocol.js";
import { InMemoryRelayStateRepository } from "../packages/state/src/index.js";
import { RelayHttpAdapter } from "../apps/relay/src/http.js";

async function nextFrame(output: PassThrough): Promise<GuestFrame> {
  let buffer = Buffer.alloc(0);
  for (;;) {
    const chunk = output.read() as Buffer | null;
    if (chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeGuestFrames(buffer);
      buffer = Buffer.from(decoded.remainder);
      if (decoded.frames[0]) return decoded.frames[0];
    }
    await new Promise<void>((resolve) => output.once("readable", resolve));
  }
}


test("in-memory blob provider returns signed, hashed, expiring references", async () => {
  let now = 1_000;
  const provider = new InMemoryBlobProvider({ secret: "a sufficiently long test secret", baseUrl: "https://relay.test", now: () => now, maxTtlMs: 100 });
  const reference = await provider.put({ body: new Uint8Array([0, 1, 2, 255]), contentType: "image/png", ttlMs: 50 });
  assert.equal(isBlobReference(reference), true);
  assert.equal(reference.content_type, "image/png");
  assert.equal(reference.size_bytes, 4);
  assert.match(reference.sha256, /^sha256:[0-9a-f]{64}$/);
  const stored = await provider.get(reference.download_url);
  assert.deepEqual([...stored.body], [0, 1, 2, 255]);
  assert.deepEqual(stored.reference, reference);

  const tampered = new URL(reference.download_url);
  tampered.searchParams.set("signature", "bad");
  await assert.rejects(() => provider.get(tampered.toString()), (error: unknown) => error instanceof BlobError && error.code === "invalid_reference");
  await assert.rejects(() => provider.get({ ...reference, size_bytes: 5 }), (error: unknown) => error instanceof BlobError && error.code === "invalid_reference");
  now = 1_050;
  await assert.rejects(() => provider.get(reference), (error: unknown) => error instanceof BlobError && error.code === "expired");
});

test("relay keeps inline results inline and externalizes only large JSON results", async () => {
  const repository = new InMemoryRelayStateRepository();
  const owner = await repository.createOwner({ subject: "blob-owner" });
  await repository.createVm({ ownerId: owner.ownerId, vmId: "vm_blob" });
  await repository.issueOAuthTokens({ ownerId: owner.ownerId, vmId: "vm_blob", resource: "https://relay.test/mcp", accessToken: "blob-access", refreshToken: "blob-refresh", accessExpiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 60_000 });
  await repository.issueChannelGrant({ ownerId: owner.ownerId, vmId: "vm_blob", channelId: "blob-channel", token: "blob-channel-token" });
  const provider = new InMemoryBlobProvider({ secret: "a sufficiently long test secret", baseUrl: "https://relay.test" });
  const relay = new RelayHttpAdapter({ repository, resource: "https://relay.test/mcp", blobProvider: provider, blobThresholdBytes: 16 });
  const auth = { authorization: "Bearer blob-access" };
  const channel = { "x-channel-id": "blob-channel", "x-channel-token": "blob-channel-token", "x-channel-epoch": "1", "x-vm-id": "vm_blob" };

  await relay.handle({ method: "POST", url: "https://relay.test/agent/requests", headers: auth, body: { request_id: "inline", operation: "system.info", vm_id: "vm_blob", payload: {} } });
  await relay.handle({ method: "POST", url: "https://relay.test/host/poll", headers: channel, body: { lease_owner: "host" } });
  const inline = await relay.handle({ method: "POST", url: "https://relay.test/host/responses/inline", headers: channel, body: { lease_owner: "host", response: { protocol_version: "v1", request_id: "inline", operation: "system.info", vm_id: "vm_blob", release_id: "agent-computer-contract-v1", ok: true, result: { ready: true } } } });
  assert.equal((inline.body as any).response.result.ready, true);

  await relay.handle({ method: "POST", url: "https://relay.test/agent/requests", headers: auth, body: { request_id: "large", operation: "system.info", vm_id: "vm_blob", payload: {} } });
  await relay.handle({ method: "POST", url: "https://relay.test/host/poll", headers: channel, body: { lease_owner: "host" } });
  const completed = await relay.handle({ method: "POST", url: "https://relay.test/host/responses/large", headers: channel, body: { lease_owner: "host", response: { protocol_version: "v1", request_id: "large", operation: "system.info", vm_id: "vm_blob", release_id: "agent-computer-contract-v1", ok: true, result: { text: "x".repeat(100) } } } });
  const reference = (completed.body as any).response.result;
  assert.equal(isBlobReference(reference), true);
  const replay = await relay.handle({ method: "POST", url: "https://relay.test/host/responses/large", headers: channel, body: { lease_owner: "host", response: { protocol_version: "v1", request_id: "large", operation: "system.info", vm_id: "vm_blob", release_id: "agent-computer-contract-v1", ok: true, result: { text: "x".repeat(100) } } } });
  assert.equal(replay.status, 200);
  assert.equal((replay.body as any).response.result.download_url, reference.download_url);
  const conflict = await relay.handle({ method: "POST", url: "https://relay.test/host/responses/large", headers: channel, body: { lease_owner: "host", response: { protocol_version: "v1", request_id: "large", operation: "system.info", vm_id: "vm_blob", release_id: "agent-computer-contract-v1", ok: true, result: { text: "different" } } } });
  assert.equal(conflict.status, 409);
  const downloaded = await relay.handle({ method: "GET", url: reference.download_url });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(downloaded.body as Uint8Array).toString()), { text: "x".repeat(100) });
});

test("guest service can externalize an oversized result before framing", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const provider = new InMemoryBlobProvider({ secret: "a sufficiently long test secret", baseUrl: "https://relay.test" });
  const request: RequestEnvelope = { protocol_version: PROTOCOL_VERSION, request_id: "guest-large", operation: "system.info", vm_id: "vm_blob_guest", deadline_ms: 1_000, mutation_id: null, input: {} };
  const gateway = { dispatch: async (candidate: RequestEnvelope) => success(candidate, { text: "x".repeat(500) }) } as any;
  const service = new GuestService({ input, output, gateway, vmId: "vm_blob_guest", channelEpoch: 3, readinessMarker: "/tmp/agent-computer-blob-ready", maxFrameBytes: 1_024, blobThresholdBytes: 16, blobProvider: provider });
  await service.start();
  assert.equal((await nextFrame(output)).kind, "ready");
  input.write(encodeGuestFrame({ kind: "request", channel_epoch: 3, request }));
  const frame = await nextFrame(output);
  assert.equal(frame.kind, "response");
  if (frame.kind === "response") {
    assert.equal(frame.response.ok, true);
    if (frame.response.ok) {
      assert.equal(isBlobReference(frame.response.result), true);
      const blob = await provider.get((frame.response.result as any).download_url);
      assert.deepEqual(JSON.parse(Buffer.from(blob.body).toString()), { text: "x".repeat(500) });
    }
  }
  service.stop();
});
