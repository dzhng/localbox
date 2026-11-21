# 16 macOS install, clone identity and suspend spike (go/no-go)

**Outcome 2026-11-21: go.** Evidence: [16-macos-install.json](../evidence/16-macos-install.json).

- macOS 27.2.1 (26B131, 25.6 GB IPSW, the latest this 27.0.1 host supports)
  installed in 4 min; the base disk allocates 27 GB of its 64 GB.
- Two clones (APFS clone of the disk, copied auxiliary storage, new identifier
  and MAC) ran together, each leased a NAT address within 9 s; a clone's private
  bytes after boot: 94 MB.
- A third concurrent macOS VM failed to start with `VZErrorDomain` code 6
  (`virtualMachineLimitExceeded`), as E11 expects.
- With the suspendable device set, save took 2.6 s (2.5 GB state file) and a new
  process restored in 3.2 s; the guest kept running.
- Guest readiness here is the DHCP lease (no agent exists yet); the first-boot
  vsock wait is measured in slice 19.

**Unlocks:** a macOS 27 guest installs from an IPSW; clones with a new
`VZMacMachineIdentifier` and copied auxiliary storage boot side by side; the
suspendable device set saves and restores; a third concurrent macOS VM is
refused. Confirm item 2. Adds proof tier `m` (P8).

## Seam

- `localbox-vmlab macos-install --ipsw <path|latest> --json`:
  `VZMacOSRestoreImage` (latest from Apple, or a local file), `VZMacOSInstaller`,
  writing the lab base to `$LOCALBOX_VMLAB_DIR/macos-base/{disk.img, aux.img,
  hardware-model, ipsw-version}`. Cached; later tier `m` probes reuse it.
- `localbox-vmlab macos-clone` and `macos-hibernate`: per clone, a new
  `VZMacMachineIdentifier`, a copy of `aux.img`, `VZMacPlatformConfiguration`
  with the saved hardware model, `VZMacGraphicsDeviceConfiguration` (no window),
  `VZMacKeyboard` and `VZMacTrackpad`, virtio block, NAT, vsock; no entropy and no
  audio device (Tart's `--suspendable` recipe, map E9).
- `@available(macOS 27, *)` gates; `Package.swift` stays at `.macOS(.v14)`.
- `scripts/proof/run.ts` accepts tier `m`; probe `16-macos-install-spike.ts`,
  tiers `m`.

## See it

`npm run proof -- 16 --tier m` writes `evidence/16-macos-install.json`: install
and download times and bytes (map E14), the clone's on-disk size, two clones
running at once with distinct identifiers (framebuffer captures of both at
Setup Assistant are enough here), save in one process and restore in another,
and a third clone's start failing with `VZError.virtualMachineLimitExceeded`
(evidence for E11).

## Gates

All of the above. A missing cached base exits 2 with
`blocked: no cached macOS base`.

## Stop rule

Clones with new identifiers failing to boot means "one running sandbox per
macOS image at a time", a product call: stop and ask the user. Save/restore
failing means macOS sandboxes can't sleep: stop and ask.

## Delegated

File names inside the base, how the IPSW is cached, capture method for the
framebuffer evidence.

## Feedback that would change it

The user deciding macOS sandboxes may skip sleep, which would relax the device
set.
