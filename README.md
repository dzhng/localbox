# Localbox

Localbox runs a durable, preconfigured Linux VM on a user's Mac and
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
local Convex, relay, MCP, recovery, registry, image, release, and CLI gates
are runnable locally. Apple Virtualization boot and deployed Convex/Vercel
internet smoke still require the release environment.

The deployable control-plane entrypoints are `apps/relay/api/[...path].ts` and
`apps/mcp/api/[...path].ts`. Set `CONVEX_URL`, `CONVEX_DEPLOYMENT`,
`LOCALBOX_RESOURCE`, and `LOCALBOX_RELAY_URL` in Vercel; deployed
functions fail closed when Convex is not configured. For repository-backed
MCP OAuth, also set `LOCALBOX_ISSUER`, `LOCALBOX_OWNER_SUBJECT`,
and `LOCALBOX_VM_ID` (or provision the owner and VM in Convex first).
Set `BLOB_READ_WRITE_TOKEN` for the relay's private Vercel Blob provider;
`LOCALBOX_BLOB_THRESHOLD_BYTES`, `LOCALBOX_BLOB_TTL_MS`, and
`LOCALBOX_BLOB_MAX_BYTES` tune its bounded externalization policy.
The OAuth route returns raw access and refresh tokens only at issuance or
rotation; Convex stores hashes. Build an image with
`LOCALBOX_BASE_IMAGE` pinned to an ARM64 digest plus the six checksum
and version variables documented by `packages/vm-image/scripts/build-arm64-image.ts`
(`NODE_*`, `BUN_*`, and `STATIC_WEB_SERVER_*`).

For a local control-plane smoke, start an isolated Convex deployment and the
same Web Request handlers used by the Vercel functions:

```sh
npx convex dev --typecheck disable --codegen disable
npm run dev:local
```

The local server listens on `http://127.0.0.1:3000/api/{relay,mcp}` and reads
the Convex URL written to `.env.local`. It enables the local in-memory blob
provider explicitly; deployed functions still fail closed without Convex and
private Blob configuration.

After deployment, `localbox mcp install --json` prints the optional MCP
configuration for agents. CLI login and catalog operations remain independent
of MCP.

On the Mac, the installed CLI uses the authenticated HostDaemon Unix socket by
default. The daemon reads the owner-only token at
`~/Library/Application Support/Localbox/ipc-token`; set
`LOCALBOX_SOCKET_PATH` or `LOCALBOX_IPC_TOKEN_FILE` only when an
installer materializes a different location. The in-process fixture transport
is available only with `LOCALBOX_LOCAL_TRANSPORT=fixture` for local tests.

On an ARM64 release machine, `scripts/release.sh` stages the signed HostDaemon
app bundle, compiled CLI, VM artifacts, checksums, and release manifest. Set
`LOCALBOX_KERNEL`, `LOCALBOX_INITRD`, and
`LOCALBOX_TEMPLATE_DISK` to the published VM inputs, then provide
`APPLE_SIGNING_IDENTITY`, `NOTARY_PROFILE`, and `RELEASE_PRIVATE_KEY` (a path to
the Ed25519 private-key file) for a production release. `ALLOW_UNSIGNED=1` is
reserved for local packaging checks;
it cannot satisfy the virtualization or distribution gates.
When `APPLE_SIGNING_IDENTITY` is omitted, the script imports the local
screen-recorder PKCS#12 from `~/dev/screen-recorder/.release-signing` (or
`LOCALBOX_SIGNING_DIR`) into a disposable keychain, authorizes headless
`codesign`, and deletes that keychain on exit. If those local files are absent,
it creates a throwaway self-signed identity instead. `RELEASE_PRIVATE_KEY` is
still required for the signed release manifest; `ALLOW_UNSIGNED=1` is only for
explicit unsigned packaging checks.

Install a signed release with `RELEASE_PUBLIC_KEY=/path/to/release.pub scripts/install-release.sh dist/release`. The
installer verifies checksums and the Ed25519 manifest, keeps versioned app/CLI
trees behind an atomic `releases/active` link, materializes the launchd plist,
creates the owner-only IPC token, and loads the daemon plus the automatic
GitHub release updater. `localbox update check` inspects the latest release;
`localbox update install` downloads, verifies, installs, and then refreshes a
managed global skill. Use
`scripts/rollback-release.sh VERSION` to select an older verified tree; use
`scripts/uninstall.sh` to remove launchd and the CLI link while preserving VM
state. Set `LOCALBOX_INSTALL_ROOT` for a user-local or fixture install.
The CLI archive carries its own ARM64 Node runtime and pinned `skills@1.7.0`
installer, so skill install/update never depends on the agent's host `node`,
`npm`, `npx`, or a network fetch.
It also adds a marked `~/.local/bin` PATH line only when the account's login
shell does not already cover that directory; uninstall removes only that marked
block.

The bundled Localbox skill is the agent-facing installation path: when the CLI
is missing, the agent downloads the tagged release kit, verifies it, and invokes
the release installer. There is no browser app download or drag-and-drop step.

The tagged-release workflow is `.github/workflows/release.yml`. It expects
repository variables for the pinned ARM64 kernel, initrd, template disk, image
digest, and the release public key in
`skills/localbox/release-public.pem`, plus secrets for the Ed25519 release key,
Apple signing identity, and password. The workflow publishes the app, CLI,
manifest, and checksums to GitHub Releases. The updater trusts the public key
configured by the installer and refuses unsigned or mismatched artifacts. The
manifest may carry public-key metadata for inspection, but it is never used as
the trust root for its own signature. Set `LOCALBOX_RELEASE_REPOSITORY` during
installation when the release repository is not the default
`dzhng/agent-computer`. Automatic installs leave the running updater job loaded
while the new active release is switched, so the updater cannot terminate its
own install process.

## References

- [Localbox rationale](specs/done/agent-computer/README.md)
- [Security model](SECURITY.md)
- Duet VM desktop reference: `~/dev/duet/specs/done/vm-desktop/README.md`
- Screen-recorder CLI and skill reference: `~/dev/screen-recorder/README.md`
