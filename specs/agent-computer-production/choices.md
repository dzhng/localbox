# Final choices ledger

This ledger records decisions made while implementing the production spec. The
remaining hardware, deployment, and signing gates are evidence gaps, not new
architecture choices.

## Needs user or environment

### Apple Silicon VM integration — needs-user, medium confidence

The code now has one Swift lifecycle owner, an authenticated local IPC seam, a
framed guest process, a named virtio-console attachment, and an ARM64 image.
The remaining choice is which signed macOS product bundle supplies the launchd
Unix socket and entitlements, because that requires the release team's Apple
credentials and a real host. The reversible default is to keep `HostDaemon` as
the only owner; no second daemon or alternate VM backend should be introduced.

### Production identity and release credentials — needs-user, medium confidence

The repository can validate Convex bearer tokens, store CLI tokens in Keychain,
and sign manifests with Ed25519. Local packaging follows the screen-recorder
pattern: it imports the ignored local PKCS#12 into an owned temporary keychain,
authorizes headless `codesign`, and deletes the keychain after the run. The
remaining deployment choice is the owner's identity provider, Vercel project,
Convex deployment, Apple team, and notarization key. The provisional call is
to use the environment variables and key material named by the deployment and
release scripts, then replace them with the team's managed secrets without
changing request or auth contracts.

### Local service boundary — sound, high confidence

`npx convex dev` owns the local durable state process, while `npm run dev:local`
invokes the exact Web Request handlers used by the Vercel functions. The local
flag enables only the in-memory blob provider and leaves the Convex repository
path active, so local smoke exercises the deployed route shape without turning
production deployments into an in-memory fallback. Vercel deployment remains
fail-closed unless its Convex URL, resource URL, and private blob token are
configured.

The gap was how to run the Vercel adapter before a network deployment existed.
The local launcher now refuses to start without the URL emitted by `convex dev`,
then binds only to loopback and forwards requests into the same relay and MCP
handlers. A missing Convex process therefore fails at startup instead of
silently losing queued work in an in-memory fallback. This constrains local
development to the same durable transaction surface as deployment while
leaving the blob provider injectable for a deterministic local run.

Verdict: sound. The split keeps one state owner and makes the local boundary
reversible; deploying the same handlers only changes environment variables.
Confidence: high.

### Vercel function discovery uses root boundary wrappers — sound, high confidence

Vercel discovers functions from the root `api/` directory in this repository,
while the relay and MCP implementations live under their owning app folders.
The root files only forward the default Web Request handlers, so Vercel gets a
stable deployment boundary without duplicating route logic. The gap was the
provider's function discovery convention, which the application module layout
does not control. This constrains deployment wiring but leaves all behavior in
the app-owned handlers and keeps local smoke on the same imports.

Verdict: sound. A provider boundary is the concrete consumer that justifies
the otherwise-thin wrappers. Confidence: high.

### Local release signing uses an owned temporary keychain — sound, high confidence

When a developer runs `scripts/release.sh` without an explicit distribution
identity, the script imports the ignored screen-recorder PKCS#12 into a newly
created keychain, grants `codesign` access only there, signs the app and bundled
Node runtime with `--keychain`, and deletes the keychain on exit. If the local
credential files are unavailable, it generates a throwaway self-signed bundle
for packaging checks. The gap was how local credentials could be used without
mutating the login keychain or requiring a hosted signing service. This makes
local signed-package validation repeatable while preserving explicit Apple
identity and notarization inputs for distribution.

Verdict: sound. The key material is scoped to one run and cleanup covers normal
exit and signals; the real boot artifacts and notarization gate remain outside
the local fixture smoke. Confidence: high.

## Sound decisions

### One catalog owns CLI and MCP parity — high confidence

When an operation is added, `packages/contract` defines its ID and schema once;
CLI help, generic `invoke`, and MCP `tools/list` read that same catalog. The
alternative would be two lists that slowly disagree. This keeps one operation
authority and preserves identical envelope identity and errors.

### Convex owns durable relay state — high confidence

Requests, leases, responses, channels, OAuth families, audit rows, and quotas
are written through Convex functions. The local `convex-test` harness and the
in-memory repository are doubles of that transaction interface, not competing
authorities. A server restart therefore replays the same durable state rules.

The production Convex directory contains only the schema and deployed
transactions; the `convex-test` harness lives beside it in the state package.
This keeps test-only imports out of a real Convex push while preserving the
same function references for local tests. Verdict: sound; deployment and test
authority have one contract with separate build surfaces. Confidence: high.

### VM identities are unique and channel rotation takes a caller-owned token — high confidence

When a host reconnects, it must be able to identify one VM without another
owner or an earlier row sharing that identifier. The Convex schema therefore
indexes `vmId` directly and rejects duplicates, matching the local repository's
global uniqueness rule. When a channel epoch changes, the caller supplies the
new random token and receives only its hash in durable state; the previous
token then fails while the caller can authenticate with the new one. The
alternative implementation generated a token inside the transaction and
discarded it, which would make every rotated channel unusable. Verdict: sound;
the durable authority never stores raw bearer material and the owner of the new
token can complete the reconnect. Confidence: high.

### Vercel is a stateless HTTPS adapter — high confidence

An agent submits a request, a Mac host polls and leases it, and the host posts
the response. Vercel functions validate credentials and call repository
transactions; they never execute guest operations or keep an in-memory queue.
This makes cold starts safe and keeps all connectivity outbound from the Mac.

### Hosted adapters fail closed when production identity is incomplete — high confidence

The Vercel relay and MCP entrypoints now refuse to initialize without the
durable Convex URL, private blob token, public resource URL, and (for MCP) the
relay URL and owner subject. Falling back to an in-memory queue or the fixture
audience would make a deployment appear healthy while losing requests or
issuing tokens that the CLI could not use. Local tests still omit `VERCEL` and
retain their explicit in-memory fixtures. Verdict: sound; production and test
authority are separated at the process boundary. Confidence: high.

### The host waits for a guest readiness frame before serving requests — high confidence

When Apple Virtualization starts the VM, the backend creates a named
virtio-console port and connects it to two host pipes. `GuestService` sends a
length-prefixed JSON readiness frame first; `HostDaemon` consumes that frame
before changing the lifecycle to ready, and later frames carry request
responses. The alternative would mark the VM ready immediately after the
hypervisor reports “started,” which lets the CLI race a guest process that is
still booting. Keeping framing in one `FramedFileHandleGuestChannel` actor also
serializes writes and bounds each frame.

The plan did not specify the host-side byte transport or readiness ordering;
this choice constrains the guest entrypoint and the future launchd/socket
packaging. Verdict: sound, because it makes readiness observable at the
consumer boundary and matches the guest framing contract. Confidence: high.

### The installed CLI uses HostDaemon IPC and fixtures require an explicit switch — high confidence

The CLI now sends one length-prefixed, authenticated request to the
HostDaemon's Unix socket and receives the same response envelope that MCP and
the remote relay use. A missing daemon or token is reported as unavailable or
unauthorized; the CLI does not silently execute against a local fake VM. The
fixture dispatcher remains behind `AGENT_COMPUTER_LOCAL_TRANSPORT=fixture` so
tests can run without Apple Virtualization. The alternative default would make
an installed product appear to work while every file, browser, and VM action
stayed inside the developer checkout. Verdict: sound; production authority is
the signed HostDaemon and the fixture is explicit. Confidence: high.

### Installation uses versioned trees with an atomic active link — high confidence

An upgrade first verifies the signed release and extracts the app and CLI into
a new version directory. Only after its checksums and code signature pass does
the installer replace `releases/active` in one rename; launchd and the CLI
symlink point at that stable link. An interrupted extraction therefore leaves
the old daemon selected, and rollback is the same verified switch in reverse.
Uninstall removes the integration points while preserving the VM disk. The
alternative was replacing `/Applications/Agent Computer.app` in place, which
could leave launchd pointing at a partial tree. Verdict: sound; the release
boundary and durable VM state have separate lifecycles. Confidence: high.

### The ARM64 image is reproducible and probe-backed — high confidence

The builder requires an immutable base digest, pinned Debian snapshot and
artifact checksums, then probes actual executables, Python imports, readiness,
and architecture. The image carries Duet's workflow inventory while using
ARM64-compatible artifacts. A manifest name alone cannot make a missing binary
usable, so verification fails closed.

### Guest execution stays inside the VM boundary — high confidence

The guest service owns shell/filesystem dispatch, path confinement, deadlines,
cancellation, and the mutation journal. It receives framed requests on its
channel and emits framed responses; the relay only transports data. This keeps
host paths and guest authority separate.

### Mutations are never guessed after a lost response — high confidence

The client reports `operation_uncertain` when transport drops after dispatch.
An exact mutation ID replays the recorded response; a different payload with
the same ID fails closed. Read-only calls may retry under recovery supervision.

### MCP remains optional and shares the durable OAuth boundary — high confidence

MCP is a thin Streamable HTTP adapter over `AgentClient`. Its deployed entrypoint
uses the repository for authorization-code creation, PKCE token exchange,
refresh rotation, revocation, and access-token validation, then selects the VM
identity. It does not add invites, agent enrollment, or a separate operation
owner. Raw token material is returned only at issuance and refresh time; Convex
stores hashes.

### Release verification is layered — high confidence

Artifact SHA-256 checksums, ARM64 metadata/image digests, and Ed25519 manifest
signatures are checked independently. A valid checksum cannot authorize a
wrong-architecture artifact, and a valid signature cannot hide a changed file.

### Release activation is verified and atomic — high confidence

The installer verifies the selected version and every artifact before creating
an `active` symlink, then replaces that symlink in one rename. Rollback calls
the same activation path, so a bad or interrupted upgrade cannot replace the
currently selected release with a partially verified tree. Version and artifact
names are confined to the release root.

### The release artifact is a signed app plus compiled CLI archive — medium confidence

The release command packages the HostDaemon executable and launchd resources in
an app bundle, while the CLI ships as a self-contained archive containing the
ARM64 Node runtime, compiled catalog/client packages, and production
dependencies. The VM kernel,
initrd, immutable template disk, and versioned `Info.plist` are copied or
generated in the app resources before the manifest is written. This keeps the
host lifecycle owner and the agent's primary CLI install in one versioned
release; the alternative was shipping a source checkout and a development
`tsx` wrapper that cannot run on a clean machine. The bundle declares the Apple
Virtualization entitlement, but signing and notarization remain release-
environment inputs. Verdict: sound as the packaging boundary; confidence:
medium because the team's final installer layout and signing identity are still
environment choices. The bundled Node binary is signed without hardened-runtime
flags so V8 can reserve JIT memory; the HostDaemon app remains hardened. The
archive omits macOS resource-fork and quarantine
metadata so a normal unzip-based installer does not add `._*` files that
invalidate the sealed code signature. Verdict: sound; generic extraction now
has the same verification result as native macOS extraction.

### Large and binary results use signed blob references — high confidence

Inline JSON remains the default. When a result exceeds the configured inline
threshold, the guest or relay can place its serialized bytes behind a
`BlobReference` containing a SHA-256 digest, byte count, content type, expiry,
and an HMAC-signed download URL. `packages/blob` owns this stable contract and
ships an in-memory provider for local Convex/relay tests; production object
storage can implement the same `BlobProvider` interface without changing CLI,
MCP, or guest envelopes. The relay validates signed URLs itself and never
turns a blob reference into an unauthenticated public object. The gap was the
payload limit versus screenshot/file-sized results; this keeps normal responses
cheap while making retries resolve to the original signed reference. Verdict:
sound, because the digest and size are checked before replay and rejected
attempts clean up only references they created. Confidence: high.

### Local host IPC uses one bounded length-prefixed request per socket — high confidence

The CLI/daemon boundary is a Unix-domain socket carrying a four-byte
big-endian length followed by JSON. The server handles one request and closes
the connection, authenticates before forwarding to `HostDaemon`, refuses to
replace a non-socket path, and applies owner-only permissions. This choice was
needed because launchd supplies process lifecycle but does not define an
application message format. A newline protocol or a long-lived multiplexed
connection would complicate framing and let one stuck client hold shared state.
The wire shape is owned by `UnixDomainSocketServer` and `LocalIPCResponse`;
launchd packaging can wrap it without changing the protocol. Verdict: sound;
bounded frames and one-request connections make malformed input and cleanup
observable. Confidence: high.

### Destructive VM reset copies an immutable template disk — high confidence

Reset first stops the VM, copies the configured template image to a temporary
file, then atomically replaces the persistent disk. The old implementation's
empty-file reset would leave Virtualization with an invalid disk image after a
confirmed reset. The plan required explicit confirmation but did not specify
how a valid disk returns. `AppleVMConfiguration.templateDiskURL` now owns that
source, and missing templates fail closed. Verdict: sound; a reset either
restores a valid image or leaves the original disk in place. Confidence: high.

### Vercel has a separate bounded body ceiling for host responses — high confidence

The normal relay frame limit remains the inline safety limit. The Web Request
parser may accept a larger, explicitly configured body only on the path where a
host response is converted into a signed blob reference; the adapter still
stores the bounded reference rather than the large payload. Without this split,
the parser would reject the very response it was meant to externalize. The
ceiling is finite and must be configured with the deployment's provider limit.
Verdict: sound; it preserves the inline cap while making externalization
possible. Confidence: high.

### Convex relay reads are bounded and route-specific — high confidence

Polling a host or checking one response must not scan every request, channel,
and audit row owned by the deployment. The repository now uses indexes for the
host's owner/VM/status lease query and targeted request/channel lookups; the
diagnostic snapshot and family-wide security operations have an explicit row
ceiling and fail closed when state exceeds it. The alternative was an
unbounded database read in each HTTP request, which would grow with retention
history and eventually make the relay slow or exhaust its query budget. This
keeps the hot path proportional to the request being served while making an
abnormally large administrative set visible instead of silently truncating it.
Verdict: sound, because every production read has a bounded result or an index
that selects the requested owner/status bucket. Confidence: high.

### Production blobs use private Vercel Blob storage — needs-user, medium confidence

The relay now has a real `BlobProvider` implementation backed by Vercel Blob.
It uploads private objects, limits size and expiry, signs short-lived download
URLs, and restricts every object to the configured pathname prefix. The local
harness still uses the deterministic in-memory provider. The plan required
durable binary storage but left the vendor unspecified; this is a reversible
deployment choice because another object store can implement the same interface.
Verdict: needs-user only for the account and billing choice; the provisional
call is Vercel Blob because the relay already runs on Vercel and the adapter is
covered by a provider-injected test. Confidence: medium.

### launchd receives a token file rather than an inline secret — sound, high confidence

The host daemon executable reads its IPC credential from an owner-only file and
the launchd template points to that path. An inline plist environment variable
would put the bearer secret in a process configuration file that installers,
diagnostics, and backups can expose. The process still accepts an explicit
environment token for controlled development, while the product template uses
the file path. Verdict: sound; the credential boundary is clearer and can be
rotated without changing the socket protocol. Confidence: high.

### Host lifecycle requests are handled before guest forwarding — sound, high confidence

When the CLI sends `vm.stop`, the request must reach the native Virtualization
owner; sending it into Linux would only let the guest claim that the VM stopped
while the macOS process kept running. The local IPC router now recognizes host
lifecycle operations and returns the same response envelope after calling
`HostDaemon`; shell, filesystem, browser, desktop, and job operations continue
through the guest channel. The plan named one lifecycle owner but did not spell
out where the envelope split occurred. Verdict: sound, because the operation
that changes the VM cannot be simulated inside the VM. Confidence: high.

### The guest owns one complete catalog adapter — sound, medium confidence

The image entrypoint now registers every catalog operation through
`GuestGateway`; the CLI fixture uses that same handler map instead of layering a
second desktop map over it. This means a production guest no longer answers
browser, desktop, job, network, or status calls with an accidental
`unsupported` response. The production image now wires Chromium/CDP and
XFCE/VNC through a bounded backend seam; hardware boot and signed-image
integration remain explicit validation gates. Verdict: sound for ownership and
parity; the remaining desktop uncertainty is environmental rather than a second
operation owner. Confidence: medium.

### Relay responses require the active lease owner — sound, high confidence

A channel-authenticated host could previously post a response for a queued
request by omitting `lease_owner`; the repository accepted it before any host
had claimed the work. Response recording now requires a live leased row and the
same non-empty owner in both the local and Convex implementations, and the HTTP
route requires that field. The alternative allowed one host to complete another
host's request. Verdict: sound, because ownership is checked at the transaction
that changes the request state. Confidence: high.

### Production desktop is a loopback X11/Chromium backend selected by the image — sound, medium confidence

When a guest receives `browser.open` or `desktop.click`, the operation must reach a real desktop rather than the deterministic test runtime. The image now starts Xvfb (a virtual X display), XFCE, loopback-only VNC, and Chromium with CDP (Chrome DevTools Protocol) on `127.0.0.1`; the guest agent injects handlers that use CDP for browser actions and `xdotool`/ImageMagick for desktop actions. The standalone agent still defaults to fixtures for probes, while the production image sets the backend explicitly. The plan named Chromium/CDP and XFCE/VNC but left process startup and the Node 18 WebSocket gap unspecified. Keeping all listeners loopback-only avoids exposing the desktop through the relay, and using `undici` as an explicit runtime dependency supplies WebSocket support where Node 18 has no global implementation. Verdict: sound; the remaining uncertainty is hardware boot and real Chromium/X11 behavior on the signed image. Confidence: medium.
