import assert from "node:assert/strict";
import { test } from "node:test";
import { createPkcePair } from "../packages/client/src/auth.js";
import { createLocalConvexHarness } from "../packages/state/src/index.js";
import { RepositoryOAuthServer } from "../apps/relay/src/repository-oauth.js";

test("repository OAuth authorization, refresh, validation, and revocation are durable", async () => {
  let now = 1_700_000_000_000;
  const harness = await createLocalConvexHarness({ now: () => now });
  const repository = harness.client();
  const owner = await repository.createOwner({ subject: "owner@example.test" });
  await repository.createVm({ ownerId: owner.ownerId, vmId: "vm_01" });
  const oauth = new RepositoryOAuthServer({ repository, issuer: "https://relay.test", resource: "https://relay.test/mcp", ownerSubject: "owner@example.test", now: () => now, accessTokenTtlSeconds: 30 });
  const pair = createPkcePair();
  const started = await oauth.authorize({ response_type: "code", client_id: "agent-computer-cli", redirect_uri: "http://127.0.0.1:1234/oauth/callback", code_challenge: pair.challenge, code_challenge_method: "S256", resource: "https://relay.test/mcp", state: "state" });
  assert.equal(started.vm_id, "vm_01");
  const tokens = await oauth.token({ grant_type: "authorization_code", code: started.code, client_id: "agent-computer-cli", redirect_uri: started.redirect_uri, code_verifier: pair.verifier, resource: "https://relay.test/mcp" });
  assert.equal((await oauth.validateAccessToken(tokens.access_token)).vm_id, "vm_01");
  now += 1_000;
  const rotated = await oauth.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: "https://relay.test/mcp" });
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  await oauth.revoke(rotated.access_token, "access_token");
  await assert.rejects(() => oauth.validateAccessToken(rotated.access_token));
  await assert.rejects(() => oauth.validateAccessToken(tokens.access_token));
  await harness.restart();
});

