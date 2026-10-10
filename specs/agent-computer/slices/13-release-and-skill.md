# Slice 13 — Release, CLI distribution, and consumer skill

## Contract unlocked

An agent can install the product from GitHub or the website without MCP and use
the skill to configure optional MCP, everyday work, and recovery.

## API seam and ownership

Release scripts own versioned arm64 app/CLI assets, receipt, checksums,
signature/notarization checks, and update/rollback policy. `skills/agent-computer`
is the consumer skill; `.agents/skills` remains development tooling.

Follow the screen-recorder convention: install the app under
`~/Applications/AgentComputer.app`, put `agent-computer` under
`~/.local/bin`, verify `release.json` and `SHA256SUMS`, and do not require Bun or
Node beyond the bundled runtime.

## Runnable artifact

The clean-account installer downloads and verifies a release, launches the app,
runs `agent-computer status`, and observes automatic VM/relay startup. The skill
then runs shell/browser/desktop smoke, teaches a cloud agent to install the same
CLI and use `agent-computer auth login`, and optionally configures MCP OAuth. It
includes references for installation, usage, recovery, and capability discovery.

## Verification

- Wrong architecture, digest, signature, or minimum macOS fails before install.
- Upgrade preserves the VM disk and never edits installed skill files.
- Skill commands match generated CLI help and work with MCP absent.
- Recovery instructions cover sleep/network reconnect, revoke, pause, and reset.
- Release artifacts are reproducible enough to identify an image and app digest.
