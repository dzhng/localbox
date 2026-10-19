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
is a Linux VM: product copy says "sandbox", and "VM" belongs to technical docs
and code. The [positioning](positioning.md) doc
owns the product message and the use cases; what is built is the code.

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

- Unknown operations and fields, malformed values, unknown sandbox names or IDs,
  expired or revoked authorization and missing mutation IDs are refused.
- A mutation is never retried implicitly after a lost response. It is reported
  as `operation_uncertain`; the caller resolves it with a status query or an
  exact replay of the same mutation ID.
- Deployed functions refuse to start without Convex, the API origin and the
  token signing key. Fixture transports, the dev mailer and the process-fixture
  VM backend are opt-in for local tests only.
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

Deleting a sandbox is the one way to discard its disk; `sandbox delete` takes an
optional `--confirm NAME` that must match. Update, rollback and uninstall
preserve every sandbox's disk. Project-local skills are never touched; a global
skill copy Localbox did not write is backed up before agent setup replaces it.

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
npx convex env set LOCALBOX_API_ORIGIN http://127.0.0.1:3000   # the token issuer dev:local signs as
npm run dev:local
```

The local server listens on `http://127.0.0.1:3000/api/{relay,auth,v1,mcp}` and
reads the Convex URL written to `.env.local`. Deployed functions fail closed
without Convex configuration or `LOCALBOX_API_ORIGIN`; both Convex and the token
issuer otherwise default to `https://api.localbox.sh`.

`npm run proof -- 03 --tier l` and later proofs start all of this for you,
plus one fixture HostDaemon per simulated machine
(`.localbox/proof/machines/<name>`), via `scripts/proof/stack.ts up --machines a,b`
(`a:8G,b:16G` gives each fixture daemon that much RAM instead of this Mac's).
`npm run proof -- 13 --tier l` runs the whole two-machine scenario; `--tier v`
makes machine A a real daemon with real VMs. Real-VM proofs (tier `v` of 01, 02,
10, 11, 12 and 13) need this Mac's screen lock to ask for no password ([why](skills/localbox/references/installation.md#prepare-the-mac-so-sandboxes-can-hibernate)).

### A simulated second machine

A second Mac is simulated by a second machine root on this one, served by a
fixture daemon (`LOCALBOX_SANDBOX_BACKEND=process-fixture`, which runs each
sandbox's guest agent as a child process and sleeps it with `SIGSTOP`; it is
refused unless `LOCALBOX_DEV=1`). By hand:

```sh
npx tsx scripts/proof/stack.ts up --machines a,b      # Convex, dev:local, two daemons
export LOCALBOX_API_ORIGIN=http://127.0.0.1:3000
LOCALBOX_MACHINE_ROOT=$PWD/.localbox/proof/machines/a node bin/localbox.js login --email you@example.com
# the code is printed in .localbox/proof/dev-local.log (localbox.dev.email_code)
LOCALBOX_MACHINE_ROOT=$PWD/.localbox/proof/machines/a node bin/localbox.js login --email you@example.com --code 123456
LOCALBOX_MACHINE_ROOT=$PWD/.localbox/proof/machines/a node bin/localbox.js connector run &
# repeat login and connector for machine b, then create and run across them:
LOCALBOX_MACHINE_ROOT=$PWD/.localbox/proof/machines/a node bin/localbox.js sandbox create --placement remote
npx tsx scripts/proof/stack.ts down
```

Every CLI call names its machine with `LOCALBOX_MACHINE_ROOT`; without it the CLI
uses this Mac's real install.

### How a request reaches a sandbox

Sandboxes are an account catalog in Convex (`sandboxes`): `localbox sandbox
create` reserves a generated name there, then asks the machine that
`packages/placement` chose (the machine the request names with `--machine NAME`,
else `--placement auto|remote` by the room each machine last reported, else this
one) to create it. `--machine` and `--sandbox` are request selectors, never
operation input: on the wire they travel beside the operation as `machine` and
`sandbox`, and when both are given they must agree.
The daemon admits each start against 75% of its RAM, sleeping its least recently
used idle sandboxes to make room; it keeps each sandbox's identity, read-only, in
its own directory next to its disk (the [host daemon](apps/macos/HostDaemon/README.md)
README covers its layout and lifecycle). `--sandbox NAME` is looked up on this
Mac's daemon first, then in the account; it may be left out when the account has
exactly one sandbox.

A sandbox on this Mac is reached through the daemon socket. A sandbox on another
machine is reached through the agent API, which finds its machine: the CLI posts
to `POST /api/v1/ops` (`apps/relay/src/ops.ts`), which enqueues a row in Convex's
`relay` module for that machine and waits on a Convex subscription for up to
min(deadline, 50 s); longer requests come back as a continuation the client
resumes. On each Mac, `localbox connector run` (launchd job
`com.localbox.connector`) is the only process that talks to Convex: it exchanges
the machine credential for a machine token at `POST /api/relay/machine-token`,
subscribes to `relay:pendingForMachine`, claims each row and forwards it to the
daemon's socket. A row nobody claims in time is abandoned and the caller gets
`machine_offline`; abandoned rows never run. Without a sign-in, only this Mac's
sandboxes are reachable, and none can be created. The
[security model](SECURITY.md) owns the token lifetimes, the claim window, the
relay's limits and retention, and what each boundary holds.

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
| `RESEND_API_KEY` | Resend API key for sign-in codes, sent from `login@mail.localbox.sh`. Without it (and outside local dev) sign-in fails with "email delivery is not configured". |

Local development only (`npm run dev:local` sets `LOCALBOX_LOCAL_SERVICES=1`):

| Setting | Purpose |
| --- | --- |
| `LOCALBOX_DEV_PRINT_CODES` | `1` prints sign-in codes to the dev server's log (`localbox.dev.email_code`) instead of emailing them. Refused unless local services are on. |
| `LOCALBOX_DEV` | `1` lets a HostDaemon use the process-fixture backend and `host.simulate_power`. |

On each Mac:

| Setting | Purpose |
| --- | --- |
| `LOCALBOX_MACHINE_ROOT` | Relocates the whole machine state (credentials, IPC token, socket, sandboxes, logs); used for simulated machines and fixture installs. |
| `LOCALBOX_CLI` | The installed CLI the HostDaemon runs for agent setup (set in its launchd plist by the installer). Without it the daemon does not reconcile the skill and refuses `skill.*`. |
| `LOCALBOX_API_ORIGIN` | The API the CLI and connector talk to; defaults to `https://api.localbox.sh`. |

Convex environment variables (`npx convex env set`):

| Setting | Purpose |
| --- | --- |
| `LOCALBOX_API_ORIGIN` | The token issuer, the same origin as above. |
| `LOCALBOX_JWKS` | The public key set printed by `npx tsx scripts/jwks.ts` from `LOCALBOX_JWT_PRIVATE_KEY`. |
| `LOCALBOX_RELAY_DAILY_REQUESTS` | Per-account daily relayed requests; default 500. |
| `LOCALBOX_RELAY_DAILY_RESULT_BYTES` | Per-account daily relayed result bytes; default 25,000,000. |

Which Convex functions are public, how they authenticate, and the operator-only
functions are in the [security model](SECURITY.md#convex-is-an-authenticated-boundary).

## VM image

`npm run image:boot -- --profile minimal|full` builds bootable artifacts
(kernel, initrd, an ext4 `template.img` and a manifest with their digests) into
`dist/vm-image/<profile>/`, using Docker on this Mac (start it with `colima start
--arch aarch64`). `full` is the release image and carries exactly Duet's VM
package set, ported to ARM64; `npm run image:parity` fails if it drifts from the
vendored copy of Duet's Dockerfile in `packages/vm-image/duet-reference/`. The
recorded substitutions live in the manifest. `minimal` is for fast proofs.
The template's root filesystem is unpacked and written inside Linux, never on
this Mac, whose case-insensitive, unprivileged checkout would corrupt it.

`full` also runs the desktop the desktop and browser tools drive, as the
`exedev` user ([units](packages/vm-image/desktop/)): display `:0` from KasmVNC's
`Xvnc` (its viewer on loopback port 6901 only), an XFCE session, and Google
Chrome (Google's arm64 package, at Duet's version) with CDP on
`127.0.0.1:9222`. Chrome's sandbox needs unprivileged
user namespaces, so the image turns off Ubuntu's AppArmor restriction on them.

The [guest agent](apps/guest-agent/README.md) is a persistent service on a Unix
socket, with socat forwarding vsock port 1024 to it. Kernel and boot output go
to a separate console, which `localbox-vmlab` keeps beside a scratch clone of the disk. To boot an image by
hand: `swift build --package-path apps/macos/HostDaemon`, sign the binaries with
the virtualization entitlement (`sh scripts/proof/lib/sign-dev.sh`), then run
`localbox-vmlab boot --artifacts dist/vm-image/minimal --json`.

## Releasing

Releases are built on an Apple Silicon Mac and uploaded to GitHub Releases by
hand; no CI publishes them. `scripts/release.sh` stages the signed HostDaemon
app bundle, compiled CLI, VM template, checksums and release manifest for the
`version` in `package.json` (override with `VERSION`). Set
`LOCALBOX_KERNEL`, `LOCALBOX_INITRD` and `LOCALBOX_TEMPLATE_DISK` to the
`npm run image:build` outputs in `dist/vm-image/full/` and `IMAGE_DIGEST` to the
`digest` in its `manifest.json`. It needs `zstd` (`brew install zstd`).

The kernel and initrd ship inside the app. The template does not: GitHub caps a
release asset at 2 GiB, so it is zstd-compressed and split into
`localbox-template-VERSION.img.zst.000`, `.001`, … The signed manifest lists the
parts and the expanded disk's SHA-256 and size; the installer expands them into
`releases/VERSION/vm/template.img`, leaving unused blocks as holes, and keeps
only that disk. Activation and rollback re-check it against the manifest.

Upload every file in the output directory to a release named after the tag:
`gh release create vVERSION dist/release/* --title "Localbox VERSION"`. Add
`--prerelease` for a suffixed version (`1.2.0-rc.1`); the updater only follows
the latest full release.

Release credentials live in the checkout's git-ignored `.release-signing/`
(override with `LOCALBOX_SIGNING_DIR`), restored from the owner's offline backup:

| File | Contents |
| --- | --- |
| `release-private.pem` | Ed25519 manifest key; its public half is `skills/localbox/release-public.pem` |
| `release-identity.p12` | Base64 self-signed code-signing identity ("Localbox Release") |
| `release-identity-password.txt` | Password for that identity |
| `public.json` | `sha1`, `certificateSha256` and `releasePublicKey` of the above |

The script refuses a manifest key that does not match the pinned public key
and, where `public.json` is present, an identity that does not match it; it imports the identity into a disposable keychain for headless
`codesign`, and deletes that keychain on exit.
A missing credential fails rather than creating another identity: a new key is a
different signer, and installed copies trust only the pinned one.
`APPLE_SIGNING_IDENTITY` and `NOTARY_PROFILE` switch to a keychain identity and
notarization; `RELEASE_PRIVATE_KEY` overrides the manifest key path.
`ALLOW_UNSIGNED=1` is only for local packaging checks; it cannot satisfy the
virtualization or distribution gates.

### Installing, rolling back and uninstalling

`RELEASE_PUBLIC_KEY=/path/to/release.pub scripts/install-release.sh dist/release`
verifies checksums and the Ed25519 manifest, keeps versioned app, CLI and
template trees behind an atomic `releases/active` link, materializes the launchd plist, creates
the owner-only IPC token, and loads the daemon and the GitHub release updater.
Automatic installs leave the running updater loaded while the active release is
switched, so the updater cannot terminate its own install.

`scripts/rollback-release.sh VERSION` selects an older verified tree.
`scripts/uninstall.sh` removes launchd jobs, the CLI link and the marked PATH
block while preserving VM state. Set `LOCALBOX_INSTALL_ROOT` for a user-local or
fixture install, and `LOCALBOX_RELEASE_REPOSITORY` when releases come from a
repository other than `dzhng/localbox`.
