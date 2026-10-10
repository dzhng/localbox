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

This repository currently holds the product map and will receive the
implementation specification next. The first engineering spikes should validate
Apple silicon virtualization, the Linux desktop image, residential egress,
sleep/wake reconnect, and OAuth VM selection.

## References

- [Product map](specs/agent-computer/MAP.md)
- [Security model](SECURITY.md)
- [Duet VM desktop reference](../duet/specs/done/vm-desktop/README.md)
- [Screen-recorder CLI and skill reference](../screen-recorder/README.md)
