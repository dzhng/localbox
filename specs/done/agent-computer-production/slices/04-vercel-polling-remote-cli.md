# Slice 04 — Vercel HTTPS relay, host poller, and remote CLI

## Contract unlocked

A remote logged-in CLI can invoke every catalog operation on the Mac VM through public Vercel HTTPS without inbound ports.

## Seam

Vercel route handlers are stateless adapters over `RelayStateRepository`: agent submit, response read/ack, host poll/lease, host response/ack, heartbeat, revoke, and status. They validate auth, envelopes, size/deadline/rate limits, and repository transactions only. The Mac daemon uses bounded short polls with exponential backoff and lease renewal; it never exposes an inbound listener.

`packages/client` gains an HTTPS transport used by CLI and later MCP. `localbox login` performs PKCE owner login, stores refresh credentials in Keychain (or the platform secure store), refreshes access tokens, and selects the default VM. CLI commands and generic invoke route through this transport; CLI remains usable without MCP.

Small results stay inline. Larger screenshots/files are blob references with hash, size, expiry, and download authorization.

## Human runnable artifact

Against local Convex plus local HTTP handlers, two terminals can submit a shell/filesystem/browser/desktop operation and watch the Mac poll, execute, and return the result. The same CLI points at a deployed Vercel URL after configuration.

## Verification

- Stateless cold-start route tests against the local Convex harness.
- Concurrent pollers, lease expiry/redelivery, stale epoch/revocation, queue/rate/frame/output limits, heartbeat, and response retention.
- Lost response returns `operation_uncertain`; exact mutation replay returns the original guest response; no implicit mutation retry.
- Network/sleep reconnect preserves epochs and rejects stale channels.
- Full 37-operation parity matrix compares local and HTTPS envelopes, errors, help, and mutation identities.
