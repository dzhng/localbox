# Slice 05 — Local and remote CLI adapter

## Contract unlocked

An agent can use the complete catalog without MCP, whether the CLI is running on
the Mac beside the app or in a cloud agent environment.

## API seam and ownership

`apps/cli` owns parsing, help, JSON stdout, human projection, and stderr
diagnostics. `packages/client` selects a user-only local socket on the Mac or an
OAuth-authenticated hosted relay for a remote/cloud invocation. `--help` must
expose schemas without starting the VM. Convenience subcommands compile to
catalog operations; they never add behavior.

## Runnable artifact

```sh
agent-computer status --json
agent-computer vm start
agent-computer shell exec -- printf hello
agent-computer help shell.exec
```

Every machine response uses the shared envelope and every diagnostic stays off
stdout.

The same commands are valid from a cloud agent after `agent-computer auth login`;
the only difference is transport selection. CLI installation must never require
MCP.

## Verification

- CLI output matches direct-dispatcher fixtures for every operation.
- Help is complete and generated from the catalog.
- Timeouts, cancellation, uncertain writes, output caps, and background jobs
  have deterministic tests.
- Local status reports VM identity, boot ID, image digest, desktop phase, relay
  state, and observed egress without secrets.
