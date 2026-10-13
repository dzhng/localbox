---
name: localbox
description: Install and operate Localbox through its CLI, with optional MCP.
---

# Localbox

When `localbox` is missing, install the signed arm64 CLI release from the
selected GitHub tag with the repository installer; the agent performs this
bootstrap and verifies `release.json` and `SHA256SUMS`. Then run
`localbox status`. The installer places the app at
`~/Library/Application Support/Localbox/releases/active/Localbox.app` and the
CLI at `~/.local/bin/localbox`.
For the complete bootstrap, read [installation](references/installation.md).

## Everyday use

Use `localbox vm start`, `localbox shell exec -- <command>`, and
`localbox status`. The CLI works without MCP. Run `localbox auth login`
before remote use; configure MCP OAuth only when a client needs tool discovery.
Use `localbox update check` to inspect GitHub Releases and
`localbox update install` to install a verified update. The installed launchd
job performs the same check automatically every six hours. Use
`localbox skill status`, `localbox skill install`, and `localbox skill update`
to manage the global Localbox skill for Codex and Claude; managed skills are
refreshed after an app update. The release carries its own Node runtime and
pinned `skills@1.7.0` installer, so these operations do not call host `npx` or
download a skill package.
For replacement, rollback, and unmanaged-skill rules, read
[skill lifecycle](references/skill-lifecycle.md).

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
