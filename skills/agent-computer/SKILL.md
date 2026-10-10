---
name: agent-computer
description: Install and operate Agent Computer through its CLI, with optional MCP.
---

# Agent Computer

Install the signed arm64 release, verify `release.json` and `SHA256SUMS`, then
run `agent-computer status`. The installer places the app at
`~/Applications/AgentComputer.app` and the CLI at `~/.local/bin/agent-computer`.

## Everyday use

Use `agent-computer vm start`, `agent-computer shell exec -- <command>`, and
`agent-computer status`. The CLI works without MCP. Run `agent-computer auth login`
before remote use; configure MCP OAuth only when a client needs tool discovery.

## Recovery

After sleep or a network change, rerun `agent-computer status` and wait for the
relay to reconnect. Reads may retry; never blindly repeat a mutation after an
`operation_uncertain` result. Use the same mutation ID or query status first.
Use `vm pause` for a temporary stop, `auth login` after revoke/expiry, and
`vm reset --discard-state` only with explicit confirmation when all guest state
should be removed.

## Capability discovery

`agent-computer help` is generated from the shared operation catalog. MCP and CLI
expose the same operations, schemas, VM selection, and errors.
