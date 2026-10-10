# Slice 01 — Reproducible ARM64 image and real guest agent

## Contract unlocked

A pinned Linux ARM64 image boots a guest agent with the Duet-compatible workflow inventory and exposes the complete catalog inside the VM.

## Seam

`packages/vm-image` owns the versioned image manifest, canonical digest, tool inventory, readiness marker, display geometry, loopback bindings, and artifact provenance. The image builder owns a Debian Bookworm ARM64 rootfs, kernel/initrd, persistent disk seed, XFCE/VNC, Chromium/Playwright CDP, and all Duet binaries/modules with ARM64 substitutions documented in the manifest.

The guest agent owns the envelope server, shell/filesystem/jobs, browser/desktop backend, output limits, and mutation journal. It communicates over the future `GuestChannel` protocol; no host path is mounted into the guest.

## Human runnable artifact

An offline rebuild command emits the same digest from pinned inputs. A guest smoke command prints a versioned readiness and tool-inventory report; shell, filesystem, browser, desktop, and job probes run inside the VM.

## Verification

- Build on ARM64 or an explicit ARM64 builder; verify ELF architecture/linkage for every binary and import every required Python module from Duet's audited list.
- Verify actual binary probes, not only names; verify Chromium/CDP and loopback-only desktop bindings.
- Boot the image on Apple Silicon and assert readiness, persistent marker, 1440x900 desktop, guest identity, and host-path isolation.
- Preserve deterministic fake guest tests and add real guest acceptance tests; `npm run build && npm test` stays green.

## Delegated choices

Base distro, exact ARM64 browser artifact, and VNC package may change only with manifest provenance and a passing inventory/CDP gate.
