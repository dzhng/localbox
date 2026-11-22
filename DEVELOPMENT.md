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
is a Linux or macOS VM started from an image: product copy says "sandbox", and
"VM" belongs to technical docs and code. The [positioning](positioning.md) doc
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

Deleting a sandbox is the one way to discard its disk; `sandbox delete` requires
`--confirm NAME`, matching the sandbox's name. Deleting an image is the one way to
discard an image's files; `image delete` requires the same `--confirm NAME`, and
never touches a sandbox made from the image. Replacing or removing the app
preserves every sandbox's disk. Project-local skills are never touched; a global
skill copy Localbox did not write is backed up before agent setup replaces it.

## Releases are the only install path

Users install signed releases through their agent; there is no browser download.
A release is one app, `Localbox.app`, with the CLI, its Node runtime and the
pinned skill installer inside, so installing never depends on the host's Node
toolchain or a network package fetch. The
[installation procedure](skills/localbox/references/installation.md) trusts only
the public key printed in it, never key metadata carried inside the manifest it
is verifying, and checks the signature with what every Mac has. Once installed,
the app is the only supervisor of the daemon and the connector; there is no
launchd job. Until the app updates itself, a newer release is installed by the
same procedure, which replaces the app in place.

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
swift build --package-path apps/macos/App && npm run test:app   # Localbox.app package
npm run app:dev      # build and open the development Localbox.app (its own machine root)
```

`node bin/localbox.js contract probe`, `status --json` and `shell exec -- …`
are smoke entry points; set
`LOCALBOX_LOCAL_TRANSPORT=fixture` to run them against the in-process fixture
sandbox instead of a daemon. The [website](apps/site/README.md) has its own build and checks.

## Proofs

A spec's slices are judged by probes (`scripts/proof/probes`), run with
`npm run proof -- NN --tier …` ([`run.ts`](scripts/proof/run.ts)): one JSON
verdict line each, exit 0 pass, 1 fail, 2 blocked on a missing input it names.
A probe implements the tiers its claims need:

| Tier | What runs | Budget |
| --- | --- | --- |
| u | `node:test` and `convex-test`, in process | < 30 s |
| s | `swift test --package-path apps/macos/HostDaemon` | < 60 s |
| l | local Convex, `dev:local` and fixture machines | < 2 min |
| a | the development Localbox.app in a scratch root, launched with `open -g` and never focused ([`packaged-app.ts`](scripts/proof/lib/packaged-app.ts)) | < 2 min |
| v | real Apple Virtualization on this Mac | < 6 min |
| m | real macOS guests | < 10 min with the base cached; the first build up to 45 min |
| x | Resend, the deployed stack and a real second Mac | manual |

A fixture is never evidence for a real-VM claim: hibernation, NAT, cloning and
guest identity are proven only at tier `v` or `m`.

- **Tier `m`** needs a macOS 27 host and about 47 GiB free (a macOS build's disk)
  plus any IPSW bytes not yet cached. It keeps the IPSW and the installed macOS
  base under `LOCALBOX_VMLAB_DIR` (default `~/.cache/localbox-vmlab`), so only the
  first run downloads and installs; a probe that needs the base and finds none
  exits 2 naming the probe that builds it.
- **Run sweeps from a short worktree under `$HOME`** (`git worktree add ~/lbi`).
  A tier `l` daemon's socket path must fit the Unix socket limit, so a long
  checkout fails with "socket path is too long"; Colima shares only `$HOME` with
  Docker, so Docker-backed checks fail from `/tmp`; and tier `l` stacks share
  fixed ports, so run one sweep at a time.

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
makes machine A a real daemon with real VMs. Every tier `v` or `m` probe needs
this Mac's screen lock to ask for no password ([why](skills/localbox/references/installation.md#prepare-the-mac-so-sandboxes-can-hibernate));
[Proofs](#proofs) covers the rest of what the tiers need.

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
tail -f /dev/null | LOCALBOX_MACHINE_ROOT=$PWD/.localbox/proof/machines/a node bin/localbox.js connector run &   # it stops when its stdin closes
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
one) to create it. Its `place()` does no I/O: the agent API hands it the
machines, their reports and the image, so every placement rule (image holders,
macOS compatibility, the copy a target needs) lives and is tested in one pure
function. `--machine` and `--sandbox` are request selectors, never
operation input: on the wire they travel beside the operation as `machine` and
`sandbox`, and when both are given they must agree.
The daemon admits each start against 75% of its RAM, sleeping its least recently
used idle sandboxes to make room; it keeps each sandbox's identity, read-only, in
its own directory next to its disk (the [host daemon](apps/macos/HostDaemon/README.md)
README covers its layout and lifecycle). `--sandbox NAME` is looked up on this
Mac's daemon first, then in the account; it may be left out when the account has
exactly one sandbox.

Each operation's route (which executor answers it, and whether it goes to one
machine, the account or the image's holders) is in the contract's routing table
([`packages/contract`](packages/contract/src/index.ts)); nothing falls back to a
default by name. A sandbox on this Mac is reached through the daemon socket.
Everything else goes through the agent API (`apps/relay/src/`): the CLI posts to
`POST /api/v1/ops`, which runs the account side of an operation itself (every
`image` command's, against
[`packages/state/convex/images.ts`](packages/state/convex/images.ts)) and sends a
machine's part as a row in Convex's `relay` module for that machine, waiting on
a Convex subscription for up to min(deadline, 50 s); longer requests come back
as a continuation the client resumes. `sandbox create` resolves its image there
before placing it; a Mac without that image answers at once in state `copying`
and creates the sandbox once the copy lands (deleting it meanwhile stops that
create, and the copy when no other sandbox waits on it). On each Mac, `localbox connector run` (a child of
Localbox.app) is the only process that talks to Convex: it exchanges
the machine credential for a machine token at `POST /api/relay/machine-token`,
subscribes to `relay:pendingForMachine`, claims each row and forwards it to the
daemon's socket. It also reports what the daemon's long work finished (the
images this Mac now holds), pushes the account's image ids so a deletion made
elsewhere reaches this Mac, and meets the other Mac of an image copy at that
copy's row in `copies`. A row nobody claims in time is abandoned and the caller
gets `machine_offline`; abandoned rows never run. Without a sign-in, only this
Mac's sandboxes are reachable, and none can be created. The
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
| `CONVEX_URL` | The Convex deployment holding the account's durable state ([`schema.ts`](packages/state/convex/schema.ts)). |
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
| `LOCALBOX_MACHINE_ROOT` | Relocates the whole machine state, everything [`machinePaths()`](packages/config/src/machine-paths.ts) names; used for simulated machines and fixture installs. |
| `LOCALBOX_GUEST_AGENT` | The guest agent build the HostDaemon holds every guest to (Localbox.app sets it to its bundle's). Without it the daemon pushes no agent and each sandbox keeps the one its image carries. |
| `LOCALBOX_CLI` | The CLI the HostDaemon runs for agent setup (Localbox.app sets it to its bundle's). Without it the daemon does not reconcile the skill and refuses `skill.*`. |
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

## Images

The guest agent builds with one pinned Bun (`BUN_VERSION` in
[`scripts/build-guest-agent.ts`](scripts/build-guest-agent.ts)), which refuses any
other; `npm run build:guest-agent`, `image:boot` and `scripts/release.sh` all run
that build, so install that Bun first.

### The built-in linux image

`npm run image:boot -- --profile minimal|full` builds the linux image's disk
(a GPT disk: an EFI system partition with GRUB, and the ext4 root carrying the
kernel, pinned in `packages/vm-image/src/pins.ts`) and a manifest of its digests
into `dist/vm-image/<profile>/`, using Docker on this Mac (start it with `colima
start --arch aarch64`). `--out DIR` also writes the image directory the host
daemon reads (`image.json`, `disk.img`, `boot/efi-vars`); `npm run image:build`
is the `full` profile. `full` is the release image and carries exactly Duet's VM
package set, ported to ARM64; `npm run image:parity` fails if it drifts from the
vendored copy of Duet's Dockerfile in `packages/vm-image/duet-reference/`. The
recorded substitutions live in the manifest. `minimal` is for fast proofs.
The root filesystem is unpacked and written inside Linux, never on
this Mac, whose case-insensitive, unprivileged checkout would corrupt it.

`full` also runs the desktop the desktop and browser tools drive, as the
`exedev` user ([units](packages/vm-image/desktop/)): display `:0` from KasmVNC's
`Xvnc` (its viewer on loopback port 6901 only), an XFCE session, and Google
Chrome (Google's arm64 package, at Duet's version) with CDP on
`127.0.0.1:9222`. Chrome's sandbox needs unprivileged
user namespaces, so the image turns off Ubuntu's AppArmor restriction on them.

How the [guest agent](apps/guest-agent/README.md) runs in the image is its
README's. To boot an image by hand: `swift build --package-path
apps/macos/HostDaemon`, sign the binaries with the virtualization entitlement
(`sh scripts/proof/lib/sign-dev.sh`), then run `localbox-vmlab boot --image
dist/vm-image/images/linux --json` on an image directory written with `--out`;
vmlab keeps the kernel and boot console beside a scratch clone of the disk.

A Mac gets this image after install, not in the app: at every launch the app
runs `localbox app image ensure` as a one-shot child, the only writer of
`images/linux`. It fetches the release's `release.json` (from
`LOCALBOX_RELEASE_URL` when set, else the release on GitHub,
`LOCALBOX_RELEASE_REPOSITORY` to change the repository), verifies it against the
bundle's `release-public.pem`, and does nothing more when the installed image
is that release's. Otherwise it downloads the parts with `Range` resume into
`<root>/downloads/`, where the daemon's start-time sweep never looks, and swaps
the expanded image in with one rename. Its progress is `<root>/builtin-image.json`
(and the app's `image.log`); until the image is there a create from `linux`
answers `sandbox_not_ready`, retryable, with that progress. Probes launch the app
with `LOCALBOX_RELEASE_URL` on an empty folder, so they never reach GitHub;
probe 43 serves a scratch release instead.

### The macOS base

No script builds a macOS image: the daemon does, as host operation
`MacBaseBuilder` behind `localbox image create --macos` ([host
daemon](apps/macos/HostDaemon/README.md)), on a macOS 27 Mac. To drive a step by
hand (install from an IPSW, clone, hibernate, TCC, the vsock forwarder), build
and sign as above and run `localbox-vmlab macos-*`; the commands and their
arguments are listed in
[`localbox-vmlab/main.swift`](apps/macos/HostDaemon/Sources/localbox-vmlab/main.swift),
and they share the IPSW and base cache with tier `m` ([Proofs](#proofs)).

## Releasing

Releases are built on an Apple Silicon Mac and uploaded to GitHub Releases by
hand; no CI publishes them. `scripts/release.sh` builds, for the `version` in
`package.json` (override with `VERSION`), `Localbox-macos-arm64.zip` (the signed
app with the CLI inside), the built-in linux image's parts, `release.json` (the
signed manifest) and `SHA256SUMS`. Set `LOCALBOX_IMAGE` to the image directory
`npm run image:build -- --out DIR` wrote, and `IMAGE_DIGEST` to the `digest` in
`dist/vm-image/full/manifest.json`. The image's own agent doesn't have to match:
the app ships the release's agent and the daemon pushes it into every guest whose
agent build differs. The script needs `zstd` (`brew install zstd`) and the pinned
Bun ([Images](#images)).

The bundle's layout has one definition,
[`build-app.mjs`](apps/macos/App/scripts/build-app.mjs) (`--release` for this
build), and its signature one,
[`sign.mjs`](apps/macos/App/scripts/sign.mjs): inside out, never `--deep`, the
virtualization entitlement on the daemon alone, and the guest agent sealed as
built so its digests stay true. Nothing is notarized; the
[security model](SECURITY.md#releases-and-updates) says what that means.

The app carries no kernel: the image boots its own through EFI. The image ships
beside the app because GitHub caps a release asset at 2 GiB: its disk
zstd-compressed and split into parts, with its boot store and `image.json`
beside them (`packImage` in [`scripts/release.ts`](scripts/release.ts) names the
assets). The signed manifest names them and the expanded disk's SHA-256 and
size, so a Mac can check the image against the same signature as the app.

Upload every file in the output directory to a release named after the tag:
`gh release create vVERSION dist/release/* --title "Localbox VERSION"`. Add
`--prerelease` for a suffixed version (`1.2.0-rc.1`); the installation procedure
takes the latest full release.

Release credentials live in the checkout's git-ignored `.release-signing/`
(override with `LOCALBOX_SIGNING_DIR`), restored from the owner's offline backup:

| File | Contents |
| --- | --- |
| `release-private.pem` | Ed25519 manifest key; its public half is `skills/localbox/release-public.pem` |
| `release-identity.p12` | Base64 self-signed code-signing identity ("Localbox Release") |
| `release-identity-password.txt` | Password for that identity |
| `public.json` | `sha1`, `certificateSha256` and `releasePublicKey` of the above |

The script refuses a manifest key that does not match the pinned public key
and, where `public.json` is present, an identity that does not match it.
`sign.mjs` imports the identity into a disposable keychain for headless
`codesign` and deletes it afterwards. A missing credential fails rather than
creating another identity: a new key is a different signer, and installed copies
trust only the pinned one. `APPLE_SIGNING_IDENTITY` names a keychain identity
instead; `RELEASE_PRIVATE_KEY` overrides the manifest key path.
`ALLOW_UNSIGNED=1` (ad hoc code signature, unsigned manifest) is only for local
packaging checks.

### Rehearsing a release

Never use the release credentials to test. A scratch release takes a throwaway
identity (`LOCALBOX_SIGNING_DIR` holding its `.p12` and password), a scratch
manifest key (`RELEASE_PRIVATE_KEY`) and that key's public half
(`LOCALBOX_RELEASE_PUBLIC_KEY`, which the bundle then carries in place of the
pinned one). `npm run proof -- 42 --tier a` does exactly that, then runs the
installation procedure's own blocks against it, served over HTTP
(`LOCALBOX_RELEASE_URL`) into a scratch `HOME`; `--tier v` boots a real VM with
the daemon from inside the signed bundle. To rehearse by hand, serve the output
directory (`python3 -m http.server -d dist/release`), set `LOCALBOX_RELEASE_URL`
to it and follow the procedure with the scratch public key in step 3.
