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
The installer adds `~/.local/bin` to the login shell profile only when it is not
already covered, using a marked block that can be removed safely on uninstall.
For the complete bootstrap, read [installation](references/installation.md).

## Everyday use

Run `localbox login --email <address>`, then repeat it with the six-digit
code from the user. Create a sandbox with `localbox sandbox create`: it lands
on this Mac, on `--machine NAME`, or with `--placement auto` (the machine with
the most room) or `--placement remote` (the same, never this Mac), and reports
where and why, the generated name and the size it chose (`--name`, `--cpus`,
`--memory 4G` override). A full Mac makes room by sleeping its least recently
used sandboxes and reports each as `made_room`; one running a job is never
slept. Then use `localbox shell exec --sandbox NAME --
<command>`, `localbox fs read --sandbox NAME PATH` and `localbox sandbox list`.
`--sandbox` may be left out only when the account has exactly one sandbox; a
sandbox on another Mac needs no `--machine`. Every command prints short text
by default and the same facts as JSON with `--json`. The CLI works without MCP;
configure MCP OAuth only when a client needs tool discovery.
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
Use `localbox sandbox sleep` for a temporary stop and `localbox login` after a
machine is revoked. To start over, `localbox sandbox delete NAME --confirm NAME`
and create a new one, only with explicit confirmation from the user.

## Capability discovery

`localbox help` is generated from the shared operation catalog. MCP and CLI
expose the same operations, schemas, sandbox selection, and errors;
`localbox help OPERATION` shows one operation's schema.
