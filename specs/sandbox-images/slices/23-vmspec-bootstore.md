# 23 VM spec and boot store

**Unlocks:** one pure description of a VM for both operating systems, tested
without booting, and the end of the per-Mac template. The fork from slice 15 lands
here.

## Seam

`apps/macos/HostDaemon/Sources/HostDaemonCore`:

- `VMSpec` (new, pure struct): `platform` (`.linux(machineIdentifier)` |
  `.macos(machineIdentifier, hardwareModel)`), `boot: BootStore`, `cpus`,
  `memoryBytes`, `disk`, `mac`, `consoleLog?`, `devices` from `GuestPlatform`.
- `BootStore` (new enum): `.linuxEFI(variableStore: URL)` |
  `.macos(auxiliaryStorage: URL)`; if slice 15 failed and the user accepted the
  fallback, `.linuxDirect(kernel: URL, initrd: URL)` replaces `.linuxEFI`.
- `GuestPlatform.devices(for:)`: Linux (virtio block, NAT, entropy, vsock, virtio
  console to `console.log`) or macOS (virtio block, NAT, vsock, Mac graphics with
  no window, `VZMacKeyboard`, `VZMacTrackpad`; no entropy, no audio; per slice 16).
- `SandboxConfigurationBuilder` becomes the one translator `VMSpec →
  VZVirtualMachineConfiguration`, still calling `validate()` and
  `validateSaveRestoreSupport()` (`AppleVirtualizationBackend.swift:71-72`).
- **Short-lived seam:** until slice 24 provisions from `ImageStore`, the factory
  builds a `VMSpec` from today's `SandboxArtifacts` with a test-and-dev-only
  `BootStore.linuxDirect(kernel, initrd)` so the daemon keeps booting. Slice 24
  deletes `SandboxArtifacts` (`AppleVirtualizationBackend.swift:3-16`), the
  `VZLinuxBootLoader` path and its command line (`:49-51`), and the `linuxDirect`
  case, unless slice 15 failed and the user accepted the fallback, in which case
  `linuxDirect` is the permanent Linux case and `linuxEFI` never exists.
- `SandboxRecord` changes outright (no migration): gains `imageID`, `os`, and the
  sandbox's own copied boot store path; `machineIdentifier` holds either kind.
- `SandboxDirectory` gains `bootStore` (`efi-vars` or `aux.img`).

## See it

`swift test --filter VMSpecTests`; `localbox-vmlab boot` on slice 15's EFI disk
through the production translator.

## Gates

- Tier `s`, `VMSpecTests`: Linux EFI spec has no command line and validates; macOS
  spec has no entropy device; every field a restore depends on comes from the
  record or the boot store, never from the environment.
- Tier `v`: the EFI disk boots and hibernates through the translator.

## Delegated

File names inside the sandbox directory; how `VMSpec` is constructed from a record
(initializer vs factory).

## Firewall

Doesn't touch `SandboxHost` admission, `ImageStore`, the contract or Convex.

## Stays green

`swift test`; probe 02's restore-identity rules (now asserted in `VMSpecTests`).
