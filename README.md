# Agent Computer

Agent Computer runs a durable, preconfigured Linux VM on a user's Mac and
makes that VM available to AI agents through a CLI and an optional MCP adapter.

The VM provides the execution boundary. The agent can use shell access as the
authority, with filesystem, browser, screenshots, and virtual-desktop controls
as convenience interfaces over the same operation contract.

## Product direction

- Apple silicon macOS is the first host target.
- One VM is created by default; the model can support multiple VMs later.
- The VM persists files, installed software, browser state, and desktop state.
- A hosted outbound relay avoids port forwarding and Tailscale setup.
- MCP uses Streamable HTTP and OAuth; OAuth selects or scopes the VM when the
  client flow supports resource selection.
- The CLI and MCP expose the exact same operation catalog, schemas, behavior,
  errors, and permissions. MCP is optional.
- The consumer skill teaches an agent how to install the app and CLI, configure
  MCP when desired, and use and recover the product.

## Status

The code-level production implementation is shipped and documented in the
[production spec](specs/agent-computer-production/README.md). Contract, guest,
Convex, relay, MCP, recovery, registry, image, release, and CLI gates are
runnable locally. Apple Virtualization boot, deployed Convex/Vercel smoke, and
signed distribution still require the release environment.

The deployable control-plane entrypoints are `apps/relay/api/[...path].ts` and
`apps/mcp/api/[...path].ts`. Set `CONVEX_URL`, `CONVEX_DEPLOYMENT`,
`AGENT_COMPUTER_RESOURCE`, and `AGENT_COMPUTER_RELAY_URL` in Vercel; deployed
functions fail closed when Convex is not configured. Build an image with
`AGENT_COMPUTER_BASE_IMAGE` pinned to an ARM64 digest plus the four artifact
pin variables documented by `packages/vm-image/scripts/build-arm64-image.ts`.

## References

- [Agent Computer rationale](specs/done/agent-computer/README.md)
- [Security model](SECURITY.md)
- [Duet VM desktop reference](../duet/specs/done/vm-desktop/README.md)
- [Screen-recorder CLI and skill reference](../screen-recorder/README.md)
