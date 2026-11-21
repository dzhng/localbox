# 24 Image store on the Mac

**Unlocks:** images live on a Mac as files under exactly one owner, and sandboxes
are provisioned from an image instead of a template (E3, E4).

## Seam

- `packages/config` `machinePaths()` (`machine-paths.ts:14`) gains `images` and
  `operations`; Swift receives them as explicit paths like the others.
- `HostDaemonCore/ImageStore.swift` (new), the only code that touches
  `images/<imageID>/`:
  - Layout: `image.json` (`{ imageID, os, sizeBytes, hardwareModel?, minMacOS?,
    agentVersion }`), `disk.img`, `boot/` (`efi-vars` or `aux.img`; or `kernel`
    and `initrd` under the slice 15 fallback).
  - API: `list()`, `manifest(id)`, `reserveTemp(id) -> URL` (a dot-prefixed temp
    directory, so `sandboxes/` stray detection at `SandboxHost.swift:176` never
    sees it), `commit(temp, id)` (atomic rename), `remove(id)`,
    `cloneForSandbox(id, into: SandboxDirectory) -> BootStore` (APFS clone of the
    disk, plain copy of the boot store), `freeBytes()`, `sweepTemps()` at start.
  - Moves `cloneDisk` and `privateBytes` out of `SandboxRecord.swift:109-122`.
    A clone that falls back to a full copy reports it, so results never claim a
    thin clone they didn't get.
- `AppleSandboxFactory.provision` (`AppleVirtualizationBackend.swift:27-33`) takes
  an `imageID` and calls `cloneForSandbox`; it runs off the `SandboxHost` actor
  (today it blocks it, `SandboxHost.swift:504`).
- Capacity (`SandboxHost.swift:528-533`) adds `free_disk_bytes` and
  `macos_version`.
- Removes slice 23's short-lived seam: deletes `SandboxArtifacts`, the
  `VZLinuxBootLoader` path and `BootStore.linuxDirect` (kept only under the slice
  15 fallback). `localbox-hostd/main.swift:53-66` builds `ImageStore` from
  `machinePaths()` and stops reading `LOCALBOX_KERNEL`, `LOCALBOX_INITRD` and
  `LOCALBOX_TEMPLATE_DISK` (slice 25 stops the installer writing them).
- Dev path until slice 25 ships it in releases:
  `build-boot-artifacts.ts --boot efi --out <images>/linux` writes a valid
  `images/linux` directory.

## See it

`swift test --filter ImageStoreTests`.

## Gates

Tier `s`, `ImageStoreTests`: a crash between `reserveTemp` and `commit` is swept
on the next start; clones are thin on APFS (private bytes ≈ 0); `remove` leaves
existing sandbox clones bootable; `freeBytes` matches `statfs`.
`tests/machine-paths.test.ts` for the new paths.

## Delegated

Manifest field order; temp naming; whether `list()` caches.

## Firewall

No network, no Convex, no contract change. Nothing calls `ImageStore` except the
factory, the host operations (26) and the image ops that follow.

## Stays green

`swift test`; probe 10 at tier `s`.
