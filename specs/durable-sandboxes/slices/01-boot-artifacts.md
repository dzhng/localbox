# 01 Boot artifacts

**Unlocks:** a Linux sandbox boots on this Mac and reports ready on the guest
channel. Today `npm run image:build` only produces a Docker image (no kernel,
initrd, disk, init or virtio binding), so nothing can boot (plan decision D1).

## Seam

- `packages/vm-image/scripts/build-boot-artifacts.ts --profile minimal|full`
  (`npm run image:boot`): builds the existing Dockerfile plus a boot layer
  (`linux-image-arm64`, `systemd-sysv`, initramfs with virtio modules), a
  `localbox-guest.service` unit that runs the guest agent bound to
  `/dev/virtio-ports/org.localbox.guest`, and an empty `/etc/machine-id`.
  Exports the filesystem and runs `mke2fs -t ext4 -d` inside a container (the
  host has no `mkfs.ext4`; the harness starts colima). Extracts the kernel
  (decompressed to a raw arm64 `Image` if gzip) and initrd. Writes
  `dist/vm-image/<profile>/{kernel,initrd,template.img,manifest.json}`; the
  manifest carries `artifactDigests` (type exists in `packages/vm-image/src/index.ts`).
- `minimal` (Debian, systemd, Node, guest agent, curl) for fast probes; `full` is
  the release image. One pipeline; only the package set differs.
- Dev pins in `packages/vm-image/image-pins.dev.json` (gitignored, checked-in
  example). A missing pin exits 2 naming the variable.
- Fix the boot command line: the guest port is created with `isConsole = false`
  (`AppleVirtualizationBackend.swift:44`), so `console=hvc0` is not it.
- `localbox-vmlab`: new executable target in `apps/macos/HostDaemon/Package.swift`
  driving the same `AppleVirtualizationBackend` as the daemon:
  `vmlab boot|hibernate|clone|net --artifacts <dir> --json`. Signed by
  `scripts/proof/lib/sign-dev.sh`.

## See it

`npm run proof -- 01 --tier v`: builds `minimal` (cached by input digest), then
`vmlab boot`: configuration validates, ready frame within 60 s,
`shell.exec uname -m` returns `aarch64`.

## Gates

The probe; a tier-u test that the manifest binds artifact digests;
`tests/vm-image-guest-protocol.test.ts` and `npm run image:verify` stay green.

## Delegated

Kernel package (`linux-image-arm64` or `-cloud-arm64`), default template size,
how the ext4 build runs in Docker.

## Firewall

If `VZLinuxBootLoader` cannot boot the Debian kernel even decompressed, the
fallback is `VZEFIBootLoader` with a GRUB disk. That is a new seam: reslice, do
not patch it in.

## Feedback that would change it

A different base distro; dropping the desktop from `full`.
