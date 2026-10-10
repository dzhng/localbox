# Choices ledger

## User-chosen

- Production transport is Vercel HTTPS polling with outbound-only Mac connectivity.
- Convex is the durable control-plane state system, with a local Convex harness modeled on Duet.
- CLI is the primary interface after `agent-computer login`; every MCP capability must be available from CLI.
- MCP is optional and separate; the product publishes install information rather than making CLI manage MCP.
- One owner account can connect one or many agents to one MCP server; there is no invite workflow.
- First release exposes the complete catalog: shell, filesystem, jobs, browser, desktop, VM, network, and relay operations.
- Build our own reproducible ARM64 image while carrying Duet's prebuilt workflow inventory and substituting architecture-specific artifacts as required.

## Answered by the agent on the user's behalf

- Use one shared generated catalog for CLI and MCP to prevent capability drift.
- Use Keychain/secure storage for CLI refresh credentials and revocable bearer/channel credentials.
- Use bounded short polling rather than permanent Vercel connections.
- Use a Debian Bookworm ARM64 base, system Chromium/Playwright CDP, XFCE plus loopback VNC, and virtio-serial as the initial reversible implementation choices.
- Keep the local JSON registry as a host disk cache while Convex owns cloud control-plane state.

## Territory evidence

- Existing catalog, runtime, guest, desktop, recovery, relay, OAuth, MCP, registry, release, and VM probe are deterministic foundation seams, not production implementations.
- Duet's Convex harness provides the local isolated-deployment pattern.
- Duet's required-tools manifest is the image compatibility target.

## Open until implementation evidence

- Exact Convex schema/function names and retention indexes.
- Exact ARM64 artifact provenance for each Duet tool and browser licensing.
- Apple Virtualization guest channel/display implementation details.
- Production identity provider/device bootstrap details and release signing credentials.

## Implementation evidence

- Slice 01a is split from the original broad image slice: manifest/inventory/framing can be verified in CI, while real image build and guest execution remain an explicit hardware-gated slice 01b.
- Slice 02 is materialized as a lifecycle seam first: the Swift actor and native VZ owner are testable now, while guest readiness, local IPC, and real image boot remain hardware-gated work.
