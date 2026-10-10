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

### Production identity and release credentials — needs-user, low confidence

The repository can validate Convex bearer tokens, store CLI tokens in Keychain,
and sign manifests with Ed25519, but it cannot choose the owner's identity
provider, Vercel project, Convex deployment, Apple team, or notarization key.
The provisional call is to use the environment variables and key material named
by the deployment/release scripts, then replace them with the team's managed
secrets without changing request or auth contracts.

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

### Vercel is a stateless HTTPS adapter — high confidence

An agent submits a request, a Mac host polls and leases it, and the host posts
the response. Vercel functions validate credentials and call repository
transactions; they never execute guest operations or keep an in-memory queue.
This makes cold starts safe and keeps all connectivity outbound from the Mac.

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
