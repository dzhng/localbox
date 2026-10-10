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
functions fail closed when Convex is not configured. For repository-backed
MCP OAuth, also set `AGENT_COMPUTER_ISSUER`, `AGENT_COMPUTER_OWNER_SUBJECT`,
and `AGENT_COMPUTER_VM_ID` (or provision the owner and VM in Convex first).
Set `BLOB_READ_WRITE_TOKEN` for the relay's private Vercel Blob provider;
`AGENT_COMPUTER_BLOB_THRESHOLD_BYTES`, `AGENT_COMPUTER_BLOB_TTL_MS`, and
`AGENT_COMPUTER_BLOB_MAX_BYTES` tune its bounded externalization policy.
The OAuth route returns raw access and refresh tokens only at issuance or
rotation; Convex stores hashes. Build an image with
`AGENT_COMPUTER_BASE_IMAGE` pinned to an ARM64 digest plus the four artifact
pin variables documented by `packages/vm-image/scripts/build-arm64-image.ts`.

After deployment, `agent-computer mcp install --json` prints the optional MCP
configuration for agents. CLI login and catalog operations remain independent
of MCP.

On the Mac, the installed CLI uses the authenticated HostDaemon Unix socket by
default. The daemon reads the owner-only token at
`~/Library/Application Support/AgentComputer/ipc-token`; set
`AGENT_COMPUTER_SOCKET_PATH` or `AGENT_COMPUTER_IPC_TOKEN_FILE` only when an
installer materializes a different location. The in-process fixture transport
is available only with `AGENT_COMPUTER_LOCAL_TRANSPORT=fixture` for local tests.

On an ARM64 release machine, `scripts/release.sh` stages the signed HostDaemon
app bundle, compiled CLI, VM artifacts, checksums, and release manifest. Set
`AGENT_COMPUTER_KERNEL`, `AGENT_COMPUTER_INITRD`, and
`AGENT_COMPUTER_TEMPLATE_DISK` to the published VM inputs, then provide
`APPLE_SIGNING_IDENTITY`, `NOTARY_PROFILE`, and `RELEASE_PRIVATE_KEY` (a path to
the Ed25519 private-key file) for a production release. `ALLOW_UNSIGNED=1` is
reserved for local packaging checks;
it cannot satisfy the virtualization or distribution gates.

## References

- [Agent Computer rationale](specs/done/agent-computer/README.md)
- [Security model](SECURITY.md)
- Duet VM desktop reference: `~/dev/duet/specs/done/vm-desktop/README.md`
- Screen-recorder CLI and skill reference: `~/dev/screen-recorder/README.md`
