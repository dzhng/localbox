import assert from "node:assert/strict";
import { test } from "node:test";
import { createVercelRelayHandler, RelayHostPoller } from "../apps/relay/src/index.js";
import { AgentClient, FixtureTransport, RelayHttpTransport } from "../packages/client/src/index.js";
import { operationCatalog } from "../packages/contract/src/index.js";
import { FakeDispatcher, sampleInput } from "../packages/runtime/src/index.js";
import { createLocalConvexHarness } from "../packages/state/src/index.js";

test("every catalog operation preserves local semantics through the Vercel handler and host poller", async () => {
  const harness = await createLocalConvexHarness();
  const repository = harness.client();
  const owner = await repository.createOwner({ subject: "catalog-parity" });
  await repository.createVm({ ownerId: owner.ownerId, vmId: "vm_01" });
  await repository.issueOAuthTokens({
    ownerId: owner.ownerId,
    vmId: "vm_01",
    resource: "https://relay.test/mcp",
    accessToken: "access",
    refreshToken: "refresh",
    accessExpiresAt: Date.now() + 60_000,
    refreshExpiresAt: Date.now() + 60_000,
  });
  await repository.issueChannelGrant({ ownerId: owner.ownerId, vmId: "vm_01", channelId: "ch", token: "channel-token" });

  const handler = createVercelRelayHandler(repository, { resource: "https://relay.test/mcp" });
  let poller!: RelayHostPoller;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const request = new Request(String(input), {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body as BodyInit | null | undefined,
      signal: init.signal,
    });
    const response = await handler(request);
    if (request.method === "GET" && request.url.includes("/v1/requests/") && response.status === 202) {
      await poller.pollOnce();
      return handler(request);
    }
    return response;
  };

  const hostDispatcher = new FakeDispatcher();
  poller = new RelayHostPoller({
    relayUrl: "https://relay.test",
    channelId: "ch",
    channelToken: "channel-token",
    channelEpoch: 1,
    vmId: "vm_01",
    leaseOwner: "host",
    fetchImpl,
    dispatch: (request) => hostDispatcher.dispatch(request),
  });

  const local = new AgentClient({
    vmId: "vm_01",
    transport: new FixtureTransport("local", new FakeDispatcher()),
  });
  const remote = new AgentClient({
    vmId: "vm_01",
    transport: new RelayHttpTransport({ baseUrl: "https://relay.test", accessToken: "access", fetchImpl, pollMs: 1 }),
  });

  for (const entry of operationCatalog) {
    const input = sampleInput(entry.id);
    const options = {
      requestId: `parity-${entry.id.replaceAll(".", "-")}`,
      mutationId: entry.idempotency === "required" ? `mutation-${entry.id.replaceAll(".", "-")}` : null,
    };
    const expected = await local.invoke(entry.id, input, options);
    const actual = await remote.invoke(entry.id, input, options);
    assert.deepEqual(actual, expected, entry.id);
  }
});
