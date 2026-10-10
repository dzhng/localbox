---
name: localbox
description: Install and operate Localbox through its CLI, with optional MCP.
---

# Localbox

Install the signed arm64 release, verify `release.json` and `SHA256SUMS`, then
run `localbox status`. The installer places the app at
`~/Applications/Localbox.app` and the CLI at `~/.local/bin/localbox`.

## Everyday use

Use `localbox vm start`, `localbox shell exec -- <command>`, and
`localbox status`. The CLI works without MCP. Run `localbox auth login`
before remote use; configure MCP OAuth only when a client needs tool discovery.

## Recovery

After sleep or a network change, rerun `localbox status` and wait for the
relay to reconnect. Reads may retry; never blindly repeat a mutation after an
`operation_uncertain` result. Use the same mutation ID or query status first.
Use `vm pause` for a temporary stop, `auth login` after revoke/expiry, and
`vm reset --discard-state` only with explicit confirmation when all guest state
should be removed.

## Capability discovery

`localbox help` is generated from the shared operation catalog. MCP and CLI
expose the same operations, schemas, VM selection, and errors.
