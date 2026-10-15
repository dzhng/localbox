# Slice 06 — Recovery, observability, and signed release

## Contract unlocked

A clean ARM64 install survives sleep, network changes, guest crashes, interrupted upgrades, and credential revocation, and can be installed by a new user without developer tooling.

## Seam

`RecoverySupervisor` becomes the host lifecycle/reconnect owner and emits redacted structured events/metrics. Read operations may retry; mutations remain uncertain until status or exact replay resolves them. `scripts/release.sh` stages the macOS HostDaemon app, compiled CLI, published VM inputs, checksums, and manifest; production signing/notarization are supplied through the release machine's credentials. Release tooling verifies checksums/signatures/architecture/tool inventory and supports rollback to the previous image/app. Activation verifies every artifact before atomically replacing the `active` symlink; rollback uses the same verified switch, so an interrupted or invalid upgrade leaves the current release selected.

## Human runnable artifact

A clean Apple Silicon machine can install, run `localbox login`, start the VM, use CLI operations, inspect status, and recover from forced sleep/network/guest failure. A release verifier rejects wrong architecture, digest, signature, or inventory.

## Verification

- Chaos timeline for sleep, wake, network change, guest crash, stale lease, and reconnect; no duplicate mutation application.
- Redacted audit, quota/rate, payload retention, and credential/channel revocation checks.
- Code-signing/notarization, clean-machine install, upgrade interruption, rollback, image checksum/digest, and Duet inventory gates.
- Run the full review workflow and archive the spec only after G0–G7 are green.
