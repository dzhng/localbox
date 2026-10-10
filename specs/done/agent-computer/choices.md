# Final choices ledger

## Needs-user — least confidence first

### In-memory relay/OAuth state is the development owner

The relay and authorization server keep channel grants, access tokens, refresh families, and VM selection in process memory. A restart loses those records, which is acceptable for deterministic tests but not for a hosted service. The plan named the relay and OAuth protocols but did not choose a production database or key-management service. The provisional call is to keep the interfaces and move their stores behind durable account/channel storage before hosted deployment; replacing the maps does not change the catalog or token checks. **Verdict: needs-user. Confidence: low.**

### Native VM lifecycle stops at configuration validation

The Apple adapter validates a pinned ARM64 image and disk configuration, then returns an explicit unsupported result because the long-lived host daemon and guest channel are not present. The alternative would have been to claim a real boot or silently use the fake backend. The plan required a real native probe but did not provide an image artifact or daemon implementation. The provisional call is to preserve the visible failure and add lifecycle only when a pinned image and host channel are available. **Verdict: needs-user. Confidence: medium.**

### Release metadata is a verifiable development manifest

The release scripts generate ARM64 checksums and image identity, while the checked-in manifest has no signed app artifact. The plan required signing and notarization but did not provide developer certificates or a distribution endpoint. The provisional call is to keep checksum verification as the pre-install gate and add signing/notarization in the release environment. **Verdict: needs-user. Confidence: medium.**

### JSON is the first durable VM registry format

The registry stores VM identity, disk path, image digest, selected VM, and lifecycle in one mode-600 JSON file. This keeps the new repository inspectable and makes reset/reprovision behavior testable; a database would add deployment machinery before there is a second writer. The format can be replaced behind `DurableVMRegistry` if concurrent app processes become a real requirement. **Verdict: needs-user. Confidence: medium.**

## Sound

### One catalog owns every adapter contract

The contract package defines operation IDs, schemas, envelopes, limits, retryability, mutation requirements, and help snapshots. CLI and MCP consume those snapshots, while the runtime owns dispatch. This prevents a CLI-only or MCP-only permission from appearing as the product grows. **Verdict: sound. Confidence: high.**

### Exact mutation identity is the replay boundary

A caller that loses a response cannot know whether a write happened. The client reports `operation_uncertain`, and the guest journal keys the complete response by VM, operation, and mutation ID. An exact replay returns the prior result instead of executing again; a different mutation ID is a new request. **Verdict: sound. Confidence: high.**

### The VM filesystem is the guest root

The gateway resolves every path beneath an absolute guest root and rejects traversal before touching the host filesystem. Shell runs beneath that root with bounded output and process-group cleanup. This preserves the single VM trust boundary without exposing arbitrary host paths. **Verdict: sound. Confidence: high.**

### Desktop targets are generation-local

The desktop runtime increments a generation when it starts or resets. Browser target IDs include that generation, so a target captured before a restart cannot address a new browser process by accident. Fixed 1440×900 geometry and demand-based reap are owned in one runtime. **Verdict: sound. Confidence: high.**

### OAuth binds audience and VM selection

Authorization code + S256 PKCE selects a VM from the account's available resources. Access and refresh tokens carry the resource and VM, refresh tokens rotate inside a family, and replay outside the grace window revokes that family. MCP validates the bearer token before it calls the shared client. **Verdict: sound. Confidence: high.**

### CLI is useful without MCP

The CLI has local and remote fixture transports, auth login, status, VM lifecycle, shell execution, generated help, contract probe, VM probe, and recovery probe. MCP is an optional adapter over the same catalog. **Verdict: sound. Confidence: high.**

### Native failure is visible instead of hidden

The Apple Virtualization backend never falls back to the fake backend when native configuration is missing or lifecycle support is absent. The fake backend remains available for CI and persistence evidence, while the native limitation is returned as an explicit unsupported report. **Verdict: sound. Confidence: high.**
