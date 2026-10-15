# Development principles

This document records the decisions that shape Localbox's public contracts and
how to build, deploy and release it. It is for people changing Localbox, not for
agents using the product. The consumer [Localbox skill](skills/localbox/SKILL.md)
teaches external agents how to install and operate Localbox; it is not a second
copy of repository policy. The [security model](SECURITY.md) owns the trust
boundaries and the [rationale](specs/done/agent-computer/README.md) owns the
invariants and rejected alternatives.

## Product boundary

Localbox gives an agent durable sandboxes on the user's own machines. A sandbox
is a Linux VM: product copy says "sandbox", and "VM" belongs to technical docs,
code and the current operation catalog. The [positioning](positioning.md) doc
owns the product message, the use cases and what each one needs before it ships.

Shell is the authority inside the VM; filesystem, browser, screenshot and desktop
operations are convenience interfaces over that same authority. Do not add
per-tool approval scopes or payload allowlists inside the VM: an agent that can
run a shell can already do what they would forbid.

The host is outside the boundary. The VM must not gain access to the Mac's
files, processes, credentials or UI except through a narrow, reviewed interface
added as an explicit product feature. Shared folders are the planned one: a
folder the user names, read-only by default, served by Localbox itself so every
access can be logged.

## One catalog

Every capability has exactly one meaning, defined in
[`packages/contract`](packages/contract/src/index.ts). CLI help, MCP tools,
envelopes, schemas, limits and retry flags are generated from it. The CLI is the
primary surface; MCP is an optional adapter with the same operations, VM
selection, errors and permissions. Do not give an adapter its own
interpretation, and do not make any feature depend on MCP.

## Fail closed, never guess

- Unknown operations and fields, malformed values, stale VM IDs, stale relay
  epochs, expired authorization and missing mutation IDs are refused.
- A mutation is never retried implicitly after a lost response. It is reported
  as `operation_uncertain`; the caller resolves it with a status query or an
  exact replay of the same mutation ID.
- Deployed functions refuse to start without Convex, the API origin, the owner
  subject configuration. Fixture transports and in-memory
  providers are opt-in for local tests only.
- A missing native capability reports itself as unsupported rather than
  silently falling back to a fixture backend.

## Reversible requests act, then report

An explicit agent request chooses the policy. If the requested operation is
reversible and admitted by its contract, perform it without asking for
confirmation. Reversibility is the safety mechanism: the agent can inspect the
result and undo or adjust it.

Every result says exactly what Localbox did, so the agent never has to guess.
When an operation fills in a default, clamps a value, falls back or makes room,
the result names what was requested and what was produced. For example: the size
and machine chosen for a new sandbox, the sandboxes slept so another could start,
or the restart a resize required and the processes it ended. If an operation can
produce its output, it does, and reports each problem on that output. Refusal is
for malformed or ambiguous input, identity conflicts, missing prerequisites,
destructive actions and execution that failed.

Do not add cleverness the agent didn't ask for. Be direct when the agent
specifies an operation; be clever only where it delegates the choice, such as
automatic placement. Failures leave the prior state intact.

## Destructive actions are explicit

Reset requires `discard_state` and a typed confirmation. Reprovision, update,
rollback and uninstall preserve the VM disk and guest state unless the caller
confirms discarding them. Unmanaged and project-local skills are never replaced.

## Releases are the only install path

Users install signed releases through their agent; there is no browser download.
The updater trusts only the public key configured at install time, never key
metadata carried inside the manifest it is verifying. The CLI archive carries its
own Node runtime and pinned skill installer, so install and update never depend
on the host's Node toolchain or a network package fetch.

## Documentation ownership

The README is the product pitch and the agent install path, and it may describe
the launch product ahead of the code. `llms.txt` sells Localbox to agents and
tells them how to install it, nothing more. The consumer skill is the only usage
reference; it ships in every release, the installer installs it and every update
refreshes it. The skill and every install step (`llms.txt`, the README's Agent
setup) describe only what the shipped CLI does.
The positioning doc owns the message and use cases. This file owns contributor
principles and operations. Package-level behaviour belongs in the
owning code and its README; closed specs in `specs/done` hold rationale, not
current instructions.

## Building and testing

The repository is an npm workspace monorepo. `apps/*` contains product surfaces
and `packages/*` contains shared runtime and protocol owners; the root TypeScript
project builds their shared source graph.

```sh
npm install
npm run build        # full TypeScript graph
npm test             # host test suite
npm run build:workspaces && npm run test:workspaces   # Turbo per-workspace tasks
swift test --package-path apps/macos/HostDaemon       # host daemon package
```

`node bin/localbox.js contract probe`, `status --json` and `shell exec -- …`
are smoke entry points; set
`LOCALBOX_LOCAL_TRANSPORT=fixture` to run them against the in-process fixture
sandbox instead of a daemon. The [website](apps/site/README.md) has its own build and checks.

## Local control-plane smoke

Start an isolated Convex deployment and the same Web Request handlers the Vercel
functions use:

```sh
CONVEX_AGENT_MODE=anonymous npx convex dev --typecheck disable --codegen disable
npm run dev:local
```

The local server listens on `http://127.0.0.1:3000/api/{relay,auth,v1,mcp}` and
reads the Convex URL written to `.env.local`. Deployed functions fail closed
without Convex configuration.

`npm run proof -- 03 --tier l` and later proofs start all of this for you,
plus one fixture HostDaemon per simulated machine
(`.localbox/proof/machines/<name>`), via `scripts/proof/stack.ts up --machines a,b`
(`a:8G,b:16G` gives each fixture daemon that much RAM instead of this Mac's).

### How a request reaches a sandbox

Sandboxes are an account catalog in Convex (`sandboxes`): `localbox sandbox
create` reserves a generated name there, then asks the machine that
`packages/placement` chose (this one by default, `--machine NAME`, or
`--placement auto|remote` by the room each machine last reported) to create it.
The daemon admits each start against 75% of its RAM, sleeping its least recently
used idle sandboxes to make room; it keeps each
sandbox's identity, read-only, in its own directory next to its disk. `--sandbox NAME` is looked up on this Mac's daemon first, then
in the account; it may be left out when the account has exactly one sandbox.
A sandbox on this Mac is reached through the daemon socket. A sandbox on another
machine is reached through the agent API, which finds its machine: the CLI posts to the agent API
(`POST /api/v1/ops`, `apps/relay/src/ops.ts`), which enqueues a row in Convex's
`relay` module for that machine and waits on a Convex subscription for up to
min(deadline, 50 s); longer requests come back as a continuation the client
resumes. On each Mac, `localbox connector run` (launchd job
`com.localbox.connector`) is the only process that talks to Convex: it exchanges
the machine credential for a 24-hour machine token at
`POST /api/relay/machine-token`, subscribes to `relay:pendingForMachine`, claims
each row and forwards it to the daemon's socket. A row nobody claims within
3 s is abandoned and the caller gets `machine_offline`; abandoned rows never run.
Without a sign-in, only this Mac's sandboxes are reachable, and none can be created.

On the Mac, the CLI uses the authenticated HostDaemon Unix socket. The daemon
reads the owner-only token at
`~/Library/Application Support/Localbox/ipc-token`. Set `LOCALBOX_MACHINE_ROOT`
to relocate the complete machine state, credentials included. The in-process
fixture transport is available only with `LOCALBOX_LOCAL_TRANSPORT=fixture`.

## Deploying the control plane

The relay and MCP endpoint deploy from `apps/relay/api/[...path].ts` and
`apps/mcp/api/[...path].ts` to [api.localbox.sh](https://api.localbox.sh).

| Setting | Purpose |
| --- | --- |
| `LOCALBOX_API_ORIGIN` | Public API origin, normally `https://api.localbox.sh`. The MCP resource and relay URLs derive from it. |
| `CONVEX_URL` | Durable Convex deployment: accounts, machines, relay rows and OAuth state. |
| `LOCALBOX_JWT_PRIVATE_KEY` | ES256 (P-256) private key, PEM. Vercel signs short-lived Convex tokens with it; deployed functions refuse to start without it. |

The OAuth route returns raw access and refresh tokens only at issuance or
rotation; Convex stores hashes.

Relay rows live 24 hours (a daily cron, `relay:cleanupExpired`). Per-account
daily limits are Convex environment variables: `LOCALBOX_RELAY_DAILY_REQUESTS`
(default 500) and `LOCALBOX_RELAY_DAILY_RESULT_BYTES` (default 25,000,000).

Convex itself needs two environment variables (`npx convex env set`): `LOCALBOX_API_ORIGIN`
(the token issuer, the same origin as above) and `LOCALBOX_JWKS`, the public key
set printed by `npx tsx scripts/jwks.ts` from the signing key. Every public Convex
function rejects callers without a valid token; operator functions such as
`admin:wipe` are internal and run only through `npx convex run`.

## VM image

`npm run image:boot -- --profile minimal|full` builds bootable artifacts
(kernel, initrd, an ext4 `template.img` and a manifest with their digests) into
`dist/vm-image/<profile>/`, using Docker on this Mac (start it with `colima start
--arch aarch64`). `full` is the release image and carries exactly Duet's VM
package set, ported to ARM64; `npm run image:parity` fails if it drifts from the
vendored copy of Duet's Dockerfile in `packages/vm-image/duet-reference/`. The
recorded substitutions live in the manifest. `minimal` is for fast proofs.

The guest agent listens on vsock port 1024 (socat in the image's
`localbox-guest` unit). Kernel and boot output go to a separate console, which
`localbox-vmlab` keeps beside a scratch clone of the disk. To boot an image by
hand: `swift build --package-path apps/macos/HostDaemon`, sign the binaries with
the virtualization entitlement (`sh scripts/proof/lib/sign-dev.sh`), then run
`localbox-vmlab boot --artifacts dist/vm-image/minimal --json`.

## Releasing

On an ARM64 release machine, `scripts/release.sh` stages the signed HostDaemon
app bundle, compiled CLI, VM artifacts, checksums and release manifest. Set
`LOCALBOX_KERNEL`, `LOCALBOX_INITRD` and `LOCALBOX_TEMPLATE_DISK` to the
published VM inputs, then provide `APPLE_SIGNING_IDENTITY`, `NOTARY_PROFILE`
and `RELEASE_PRIVATE_KEY` (a path to the Ed25519 private key).

When `APPLE_SIGNING_IDENTITY` is omitted, the script imports the local
screen-recorder PKCS#12 from `~/dev/screen-recorder/.release-signing` (or
`LOCALBOX_SIGNING_DIR`) into a disposable keychain, authorizes headless
`codesign`, and deletes that keychain on exit. Without those files it creates a
throwaway self-signed identity. `RELEASE_PRIVATE_KEY` is always required.
`ALLOW_UNSIGNED=1` is only for local packaging checks; it cannot satisfy the
virtualization or distribution gates.

Tagged releases run `.github/workflows/release.yml`. It expects repository
variables for the pinned kernel, initrd, template disk and image digest, the
public key in `skills/localbox/release-public.pem`, and secrets for the Ed25519
release key and Apple signing identity. It publishes the app, CLI, manifest and
checksums to GitHub Releases.

### Installing, rolling back and uninstalling

`RELEASE_PUBLIC_KEY=/path/to/release.pub scripts/install-release.sh dist/release`
verifies checksums and the Ed25519 manifest, keeps versioned app and CLI trees
behind an atomic `releases/active` link, materializes the launchd plist, creates
the owner-only IPC token, and loads the daemon and the GitHub release updater.
Automatic installs leave the running updater loaded while the active release is
switched, so the updater cannot terminate its own install.

`scripts/rollback-release.sh VERSION` selects an older verified tree.
`scripts/uninstall.sh` removes launchd jobs, the CLI link and the marked PATH
block while preserving VM state. Set `LOCALBOX_INSTALL_ROOT` for a user-local or
fixture install, and `LOCALBOX_RELEASE_REPOSITORY` when releases come from a
repository other than `dzhng/localbox`.
