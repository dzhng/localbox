# Slice 08 — Remote CLI parity

## Contract unlocked

An agent can download the CLI from the repo/site skill and invoke the same
operations against the user's VM without MCP, including from a cloud execution
environment.

## API seam and ownership

The CLI chooses a local socket when it can reach the Mac app and otherwise uses
the hosted relay transport. It always sends the same catalog envelope to the same
runtime owner. OAuth is the CLI's remote login mechanism. There is no remote-only
operation set.

## Runnable artifact

Run a matrix through local and remote transports against one fixture VM and emit
a semantic diff report for every catalog operation, error, stream event, and
help response. The fixture starts from the same GitHub-style CLI install path a
cloud agent receives from the consumer skill.

## Verification

- Results, errors, retryability, cancellation, and limits match exactly.
- Auth expiry and relay reconnect are visible and recoverable.
- CLI works when MCP is absent.
- A dropped response is represented as uncertain rather than silently replayed.
