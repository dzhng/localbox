# 34 macOS base build

**Unlocks:** Q3, L2, L5 and P3/P12 in the product. `localbox image create --macos`
builds the account's macOS base with no human step, as a durable host operation.

## Seam

- `HostDaemonCore/MacBaseBuilder.swift` (new), host operation kind `macos.build`
  (slice 26), refusing up front unless the host runs macOS 27 or later
  (`image_incompatible`) and `ImageStore.freeBytes()` covers the IPSW plus a 60 GB
  disk (`disk_full`). Phases, each a resumable checkpoint:
  1. `download` the latest IPSW from Apple into an IPSW cache under
     `machinePaths().images/.ipsw/`.
  2. `install` with `VZMacOSInstaller` (slice 16).
  3. `provision` with `VZMacGuestProvisioningOptions`, Remote Login on, random
     password (slice 17).
  4. `bootstrap` over SSH: install `localbox-agent` (both roles, slice 33),
     `localbox-vsock` (slice 19), the launchd plists, and Chrome from Google's
     official installer (P12). No Xcode (L5).
  5. `sip` through `RecoveryVNC` (slice 17).
  6. `tcc` grants (slice 18).
  7. `finish`: Remote Login off, password discarded, shut down, commit through
     `ImageStore` with `os: macos`, `hardwareModel`, `minMacOS` (the IPSW's
     version).
- Relay `image.create { macos: true }` reserves the row with `source.kind =
  "ipsw"`, routes to the target Mac (the caller's own, or `--machine`), returns the
  operation state; `image wait` streams phases.

## See it

`localbox image create --macos`, then `localbox image wait macos` until `ready`.

## Gates

- Tier `u`: `tests/macos-build-relay.test.ts` (reservation, routing, host-version
  refusal).
- Tier `s`: `MacBaseBuilderTests` with a fake VM driver: phase order, resume from
  each checkpoint, password never persisted.
- Tier `m`, probe 34: an uncached build to `ready` (up to 45 min), then a cached
  rebuild skipping the download. The image has Chrome, no Xcode, SIP disabled,
  Remote Login off.

## Delegated

IPSW cache eviction; disk size between 50 and 80 GB.

## Stays green

Probes 16–19.
