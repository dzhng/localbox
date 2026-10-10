# Slice 07 — OAuth and VM resources

## Contract unlocked

An MCP-compatible authorization flow grants access to the intended VM without a
separate pairing ceremony.

## API seam and ownership

The relay exposes protected-resource metadata and an OAuth authorization server.
Use authorization code + PKCE, resource/audience validation, expiring access
tokens, rotating refresh tokens, and family-wide revocation. The consent view
lists the account's VMs and records the selected `vm_id` when the client supports
resource selection. If it cannot, v1 binds the account to its default/only VM.

## Runnable artifact

An in-memory account with two VMs exercises `agent-computer login`, consent,
token exchange, refresh, revoke, and one operation through the relay.

## Verification

- MCP clients discover authorization through protected-resource metadata and
  `WWW-Authenticate` as specified by MCP.
- Expired, wrong-audience, wrong-VM, rotated, and revoked grants fail closed.
- Refresh replay grace and family revocation are tested.
- Tokens and capability URLs never enter logs or retained artifacts.
- The selected VM cannot call another VM ID.
