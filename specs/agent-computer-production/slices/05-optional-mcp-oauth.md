# Slice 05 — Optional MCP/OAuth adapter

## Contract unlocked

MCP-native agents can install the published endpoint and invoke exactly the same catalog as the CLI, while CLI operation remains independent.

## Seam

`apps/mcp` is a thin Streamable HTTP adapter over the remote `AgentClient`. Durable Convex-backed OAuth provides metadata, PKCE, resource/audience binding, VM binding, access expiry, refresh rotation, replay-family revocation, and server/channel revocation. The endpoint publishes copyable install configuration; there is no invite or per-agent enrollment workflow.

## Human runnable artifact

The product app/status page prints MCP URL, bearer/install configuration, and revocation status. An MCP client can call `tools/list` and `tools/call`; the CLI can perform the same operation with the same response identity.

## Verification

- OAuth metadata, PKCE, resource, VM, expiry, refresh replay, and revoke tests use Convex state.
- `tools/list` is byte/schema-equivalent to the catalog/CLI help snapshot.
- Origin, method, malformed JSON, missing auth, stale token, and oversized payload errors fail closed.
- One owner token can serve multiple concurrent agents; revocation cuts off all use at the channel/credential boundary.
