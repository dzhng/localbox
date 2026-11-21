# 15 EFI Linux boot and save/restore spike (go/no-go)

**Outcome 2026-11-21: go.** L1 holds; the fallback is not needed, and slices 23, 25
and 28 take their EFI branch. Evidence: [15-efi.json](../evidence/15-efi.json).

- EFI configuration passes `validateSaveRestoreSupport()`; cold boot to the guest
  agent's ready frame 2.9 s.
- Hibernate: save 0.55 s, restore 0.36 s in a new process, same PID, counter
  running, NAT. Restore still refuses a changed CPU count, MAC or machine
  identifier, as with direct boot; a changed kernel command line no longer matters
  (there is none).
- `apt-get install linux-image-generic-hwe-24.04` moved `/boot/vmlinuz` to
  7.0.0-43 and the next boot ran it (6.8.0-151 before), reboot 1.7 s, vsock up.
- Two clones, each with a copy of one fresh variable store, booted together in
  2.2 s with distinct machine-ids.
- The layout that worked: GRUB built with `grub-mkimage` at the removable path,
  finding the root by label and reading a fixed `grub.cfg` that loads the
  `/boot/vmlinuz` and `/boot/initrd.img` symlinks; `update-grub` replaced by
  `true`. No GRUB regeneration is ever needed.
- The Swift gate `VMLabEFIConfigurationTests` was not written: the EFI
  configuration lives in vmlab for the spike and moves into the production
  translator in slice 23, whose `VMSpecTests` assert it. The tier `v` probe
  proves validation here.

**Unlocks:** L1. A Linux guest boots from its own disk under `VZEFIBootLoader`,
hibernates and restores, and picks up an `apt` kernel upgrade. Confirm item 1.

## Seam

- `localbox-vmlab boot|hibernate --efi`, `efi-kernel` and `efi-clones`, reusing
  the hibernate scenario in
  `apps/macos/HostDaemon/Sources/localbox-vmlab/main.swift`. A lab-only
  configuration: `VZEFIBootLoader` with a `VZEFIVariableStore` created at
  `<dir>/efi-vars`, `VZGenericPlatformConfiguration`, the same devices as
  `SandboxConfigurationBuilder` (`AppleVirtualizationBackend.swift:53-67`).
  Production `SandboxConfigurationBuilder` is untouched.
- `packages/vm-image/scripts/build-boot-artifacts.ts --boot efi`: a GPT disk with
  an EFI system partition and an ext4 root labelled `localbox`, a bootloader at the
  removable path `/EFI/BOOT/BOOTAA64.EFI`, root by label. Today the template is a
  bare ext4 made with `mke2fs -d` and booted with `root=/dev/vda`
  (`build-boot-artifacts.ts:74-81`, `AppleVirtualizationBackend.swift:51`), so the
  partitioned layout is new.
- Probe `scripts/proof/probes/15-efi-spike.ts`, tiers `v`.

## See it

`npm run proof -- 15 --tier v` writes `specs/sandbox-images/evidence/15-efi.json`:

1. `validateSaveRestoreSupport()` on the EFI configuration.
2. Boot to the guest agent's `ready` frame; record boot ms against the current
   direct-kernel boot.
3. Start a counter server, hibernate, restore in a new process: same PID,
   counter increasing, NAT works.
4. `apt-get install` a newer kernel package inside the guest, reboot, `uname -r`
   changed, vsock still answers.
5. APFS-clone the disk twice, copy `efi-vars` into each clone, boot both at once.

## Gates

All five steps pass. Swift test `VMLabEFIConfigurationTests` asserts the lab
configuration has no kernel command line and validates.

## Fork (on fail)

Stop and tell the user. If they accept the fallback, L1 becomes "each image
carries its own kernel and initrd": slice 23 gives `BootStore` the case
`linuxDirect(kernel, initrd)` instead of `linuxEFI(variableStore)`, slice 25
ships the kernel and initrd inside the `linux` image directory instead of the
app, and slice 28 copies the source image's kernel and initrd into the new image
(the host can't read ext4, so `apt` kernel upgrades inside a sandbox have no
effect, which slice 40 documents). Nothing else changes; an image is files
either way.

## Delegated

Bootloader (GRUB EFI or systemd-boot), partitioning tool, ESP size, root disk
size, vmlab internals.

## Stays green

Probes 01 and 02 on the existing direct-kernel path; `swift test`.

## Feedback that would change it

The user rejecting the fallback; a boot-time regression the user won't accept.
